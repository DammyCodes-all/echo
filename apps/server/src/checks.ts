import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  gradeRubric,
  type HunkInput,
  makeCheck,
  type OwnershipKind,
  orderForSession,
  type Check as PackageCheck,
  type RubricHit as PackageRubricHit,
  rankHunks,
  verifyDemonstration,
} from "@echo/checks";
import type {
  AnswerCheckRequest,
  AnswerCheckResponse,
  AnswerConfidence,
  CheckAttempt,
  CheckKind,
  FileAttempt,
  GenerateChecksRequest,
  GenerateChecksResponse,
  ReviewHunk,
  SessionChecksResponse,
  SessionReport,
  StoredCheck,
} from "@echo/contracts";
import { type EchoDb, getSession } from "@echo/db";
import { type ModelConfig, ModelError, modelConfigFromEnv, requestJson } from "@echo/model";
import { describeBackends, pickBackend, runSandbox } from "@echo/sandbox";
import { buildSessionReview } from "./review-index";

export interface ChecksOutcome {
  status: number;
  body: unknown;
}

interface ChecksServiceOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to the real sandbox ladder. */
  sandboxRunner?: (
    code: string,
  ) => Promise<{ status: "ok" | "timeout" | "error" | "unavailable"; stdout: string }>;
}

/** Bonus that makes a never-opened hunk outrank an opened one of similar risk. */
const SKIPPED_BONUS = 50;
const MAX_PER_FILE = 2;

const CONFIDENCE_P: Record<AnswerConfidence, number> = {
  guessing: 0.4,
  think_so: 0.7,
  certain: 0.95,
};

interface ChecksArtifact {
  checks: StoredCheck[];
  attempts: Record<string, CheckAttempt[]>;
  waived: string[];
  updatedAt: string;
}

function emptyArtifact(): ChecksArtifact {
  return { checks: [], attempts: {}, waived: [], updatedAt: new Date().toISOString() };
}

const GRADING_PROMPT = [
  "Judge the user's answer against each rubric point.",
  "For every point output {point, hit, excerpt, why}: hit is true only if the answer makes the point (paraphrase counts, wording does not matter).",
  "excerpt must be a verbatim substring of the user's answer supporting the judgment, or null when the point is missed.",
  "why is one line on why the excerpt means the point (or why it misses).",
  'Reply with JSON only: {"hits": [{"point": string, "hit": boolean, "excerpt": string|null, "why": string|null}]}.',
  "Output one hit per rubric point, in order, with point copied exactly.",
].join("\n");

function toHunkInput(hunk: ReviewHunk): HunkInput {
  return {
    path: hunk.path,
    deletionStart: hunk.oldStart,
    deletionLines: hunk.oldLines,
    additionStart: hunk.newStart,
    additionLines: hunk.newLines,
    addedText: hunk.addedText,
    removedText: hunk.removedText,
  };
}

function hunkRange(hunk: ReviewHunk): string {
  if (hunk.newLines > 0) {
    const end = hunk.newStart + hunk.newLines - 1;
    return end === hunk.newStart ? `line ${hunk.newStart}` : `lines ${hunk.newStart}–${end}`;
  }
  return `removal at old line ${hunk.oldStart}`;
}

function hasRevertedAttempt(attempts: FileAttempt[], path: string): boolean {
  return attempts.some(
    (attempt) =>
      attempt.path === path && (attempt.status === "reverted" || attempt.status === "replaced"),
  );
}

/**
 * Template-drafted ownership questions. Deterministic from the hunk, so
 * regeneration reproduces the same check ids. blast_radius is excluded:
 * its demonstration must be a genuine runnable snippet, which only model
 * drafting (a later slice) can produce — a template cannot invent one.
 */
function draftQuestion(
  kind: Exclude<OwnershipKind, "blast_radius">,
  hunk: ReviewHunk,
): { question: string; rubric: string[] } {
  const where = `${hunk.path} (${hunkRange(hunk)})`;
  switch (kind) {
    case "consequence":
      return {
        question: `What did the change to ${where} cost or open up? Name the concrete local effect.`,
        rubric: [
          "names what the added lines do",
          "names one concrete consequence for callers or behavior",
          "grounds the effect in the changed lines",
        ],
      };
    case "decision":
      return {
        question: `Why this approach in ${where} over the earlier attempt that was reverted or replaced?`,
        rubric: [
          "names what the earlier attempt did",
          "names what the landed version does differently",
          "states why the landed version was kept",
        ],
      };
    case "tradeoff":
      return {
        question: `What price did the change to ${where} accept? Name what got worse or riskier.`,
        rubric: [
          "names the benefit the change buys",
          "names the cost or risk accepted",
          "ties both to the changed lines",
        ],
      };
    case "teach_back":
      return {
        question: `Explain the change to ${where} so a new teammate can act on it: what changed, why it matters, and what to watch.`,
        rubric: [
          "states what changed",
          "states why it matters",
          "names something to watch when touching it",
        ],
      };
  }
}

function parseGrading(value: unknown, rubric: string[]): PackageRubricHit[] {
  if (value === null || typeof value !== "object") {
    throw new ModelError("invalid_response", "grading reply was not an object");
  }
  const hits = (value as { hits?: unknown }).hits;
  if (!Array.isArray(hits) || hits.length !== rubric.length) {
    throw new ModelError("invalid_response", "grading reply must carry one hit per rubric point");
  }
  return hits.map((entry) => {
    if (entry === null || typeof entry !== "object") {
      throw new ModelError("invalid_response", "grading hit was not an object");
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.point !== "string" ||
      typeof record.hit !== "boolean" ||
      (record.excerpt !== null && typeof record.excerpt !== "string") ||
      (record.why !== null && typeof record.why !== "string")
    ) {
      throw new ModelError("invalid_response", "grading hit has the wrong shape");
    }
    return {
      point: record.point,
      hit: record.hit,
      excerpt: record.excerpt,
      why: record.why,
    };
  });
}

export function createChecksService(
  db: EchoDb,
  dataDir: string,
  options: ChecksServiceOptions = {},
) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sandboxRunner =
    options.sandboxRunner ??
    (async (code: string) => {
      const result = await runSandbox({ code });
      return { status: result.status, stdout: result.stdout };
    });
  const checkSessions = new Map<string, string>();

  function artifactPath(projectId: string, sessionId: string): string {
    return join(dataDir, "projects", projectId, "sessions", sessionId, "artifacts", "checks.json");
  }

  function loadArtifact(projectId: string, sessionId: string): ChecksArtifact {
    const path = artifactPath(projectId, sessionId);
    if (!existsSync(path)) return emptyArtifact();
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ChecksArtifact>;
      return {
        checks: Array.isArray(parsed.checks) ? parsed.checks : [],
        attempts:
          parsed.attempts !== null && typeof parsed.attempts === "object" ? parsed.attempts : {},
        waived: Array.isArray(parsed.waived) ? parsed.waived : [],
        updatedAt:
          typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      };
    } catch {
      return emptyArtifact();
    }
  }

  function saveArtifact(projectId: string, sessionId: string, artifact: ChecksArtifact): void {
    const path = artifactPath(projectId, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    artifact.updatedAt = new Date().toISOString();
    writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
  }

  function resolveConfig(): ModelConfig {
    if (env.ECHO_MODEL === "off") {
      throw new ModelError("model_error", "ECHO_MODEL=off");
    }
    return modelConfigFromEnv(env);
  }

  async function generate(sessionId: string, input: GenerateChecksRequest): Promise<ChecksOutcome> {
    const session = getSession(db, sessionId);
    if (!session) {
      return { status: 404, body: { error: { code: "not_found", message: "unknown session" } } };
    }
    let review: Awaited<ReturnType<typeof buildSessionReview>>;
    try {
      review = await buildSessionReview(db, dataDir, sessionId);
    } catch {
      return {
        status: 500,
        body: { error: { code: "invalid_request", message: "could not build session review" } },
      };
    }
    const waived = new Set(input.waived);
    const opened = new Set(input.opened);
    const dropped: Array<{ hunkId: string; reason: string }> = [];
    const candidates = review.hunks.filter((hunk) => {
      if (waived.has(hunk.id)) {
        dropped.push({ hunkId: hunk.id, reason: "waived" });
        return false;
      }
      if (hunk.addedLines + hunk.removedLines === 0) {
        dropped.push({ hunkId: hunk.id, reason: "empty hunk" });
        return false;
      }
      return true;
    });
    const ranked = rankHunks(candidates.map(toHunkInput));
    // Re-rank with the skipped bonus: rankHunks scores risk only, so a
    // never-opened hunk earns SKIPPED_BONUS on top of its risk score.
    const scored = candidates
      .map((hunk) => {
        const risk = ranked.find(
          (entry) =>
            entry.hunk.path === hunk.path &&
            entry.hunk.addedText === hunk.addedText &&
            entry.hunk.removedText === hunk.removedText,
        );
        const skipped = !opened.has(hunk.id);
        return {
          hunk,
          score: (risk?.score ?? 0) + (skipped ? SKIPPED_BONUS : 0),
          reasons: [...(risk?.reasons ?? []), ...(skipped ? ["never opened in replay"] : [])],
        };
      })
      .sort((a, b) => b.score - a.score || a.hunk.path.localeCompare(b.hunk.path));

    const perFile = new Map<string, number>();
    const selected: ReviewHunk[] = [];
    for (const entry of scored) {
      if (selected.length >= input.limit) break;
      const count = perFile.get(entry.hunk.path) ?? 0;
      if (count >= MAX_PER_FILE) {
        dropped.push({ hunkId: entry.hunk.id, reason: "more than 2 checks from one file" });
        continue;
      }
      perFile.set(entry.hunk.path, count + 1);
      selected.push(entry.hunk);
    }

    const cycle: Array<Exclude<OwnershipKind, "blast_radius">> = [
      "consequence",
      "tradeoff",
      "teach_back",
    ];
    const now = new Date().toISOString();
    const fresh: StoredCheck[] = [];
    for (let index = 0; index < selected.length; index++) {
      const hunk = selected[index] as ReviewHunk;
      let kind: CheckKind = cycle[index % cycle.length] as CheckKind;
      if (kind === "consequence" && hasRevertedAttempt(review.attempts, hunk.path)) {
        kind = "decision";
      }
      const drafted = draftQuestion(kind as Exclude<OwnershipKind, "blast_radius">, hunk);
      let check: PackageCheck;
      try {
        check = makeCheck(kind as OwnershipKind, drafted.question, [hunk.path], drafted.rubric);
      } catch (error) {
        dropped.push({
          hunkId: hunk.id,
          reason: error instanceof Error ? error.message : "draft failed",
        });
        continue;
      }
      const verification = await verifyDemonstration(check, sandboxRunner);
      if (!verification.verified) {
        dropped.push({
          hunkId: hunk.id,
          reason: verification.reason ?? "verification gate failed",
        });
        continue;
      }
      fresh.push({
        id: check.id,
        sessionId,
        hunkId: hunk.id,
        path: hunk.path,
        kind,
        question: check.question,
        evidencePaths: check.evidencePaths,
        rubric: check.rubric,
        demonstration: check.demonstration,
        createdAt: now,
      });
    }

    const ordered = orderForSession(
      fresh.map((stored) => ({
        id: stored.id,
        kind: stored.kind as OwnershipKind,
        question: stored.question,
        evidencePaths: stored.evidencePaths,
        rubric: stored.rubric,
        demonstration: stored.demonstration,
      })),
    );
    const byId = new Map(fresh.map((stored) => [stored.id, stored]));
    const checks = ordered.map((check) => byId.get(check.id) as StoredCheck);

    const artifact = loadArtifact(session.projectId, sessionId);
    const known = new Map(artifact.checks.map((stored) => [stored.id, stored]));
    for (const stored of checks) {
      known.set(stored.id, stored);
      checkSessions.set(stored.id, sessionId);
    }
    artifact.checks = [...known.values()];
    artifact.waived = [...new Set([...artifact.waived, ...input.waived])];
    saveArtifact(session.projectId, sessionId, artifact);

    const sandboxAvailable = pickBackend(describeBackends()) !== null;
    const body: GenerateChecksResponse = { checks, dropped, sandboxAvailable };
    return { status: 200, body };
  }

  function findCheck(
    checkId: string,
  ): { projectId: string; sessionId: string; check: StoredCheck } | null {
    const sessionId = checkSessions.get(checkId);
    if (sessionId) {
      const session = getSession(db, sessionId);
      if (session) {
        const artifact = loadArtifact(session.projectId, sessionId);
        const check = artifact.checks.find((entry) => entry.id === checkId);
        if (check) return { projectId: session.projectId, sessionId, check };
      }
    }
    // Restart fallback: the map is memory-only, so scan persisted artifacts.
    const projectsDir = join(dataDir, "projects");
    if (!existsSync(projectsDir)) return null;
    for (const projectId of readdirSync(projectsDir)) {
      const sessionsDir = join(projectsDir, projectId, "sessions");
      if (!existsSync(sessionsDir)) continue;
      for (const candidate of readdirSync(sessionsDir)) {
        const artifact = loadArtifact(projectId, candidate);
        const check = artifact.checks.find((entry) => entry.id === checkId);
        if (check) {
          checkSessions.set(checkId, candidate);
          return { projectId, sessionId: candidate, check };
        }
      }
    }
    return null;
  }

  async function answer(checkId: string, input: AnswerCheckRequest): Promise<ChecksOutcome> {
    const found = findCheck(checkId);
    if (!found) {
      return { status: 404, body: { error: { code: "not_found", message: "unknown check" } } };
    }
    let config: ModelConfig;
    try {
      config = resolveConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : "model misconfigured";
      const code = error instanceof ModelError ? error.code : "model_error";
      return { status: 503, body: { error: { code, message } } };
    }
    let hits: PackageRubricHit[];
    try {
      const result = await requestJson(
        config,
        [
          { role: "system", content: GRADING_PROMPT },
          {
            role: "user",
            content: `Rubric:\n${found.check.rubric.map((point, index) => `${index + 1}. ${point}`).join("\n")}\n\nUser answer:\n${input.answer}`,
          },
        ],
        (value: unknown) => parseGrading(value, found.check.rubric),
        { fetchImpl, retryMaxTokens: Math.max(config.maxTokens * 2, 8192) },
      );
      hits = result.value;
    } catch (error) {
      const message = error instanceof Error ? error.message : "model call failed";
      const code = error instanceof ModelError ? error.code : "model_error";
      return { status: 502, body: { error: { code, message } } };
    }
    const packageCheck: PackageCheck = {
      id: found.check.id,
      kind: found.check.kind as OwnershipKind,
      question: found.check.question,
      evidencePaths: found.check.evidencePaths,
      rubric: found.check.rubric,
      demonstration: found.check.demonstration,
    };
    const grade = gradeRubric(packageCheck, input.answer, hits);
    const p = CONFIDENCE_P[input.confidence];
    const outcome = grade.correct ? 1 : 0;
    const attempt: CheckAttempt = {
      id: `att_${createHash("sha256").update(`${checkId}:${randomUUID()}`).digest("hex").slice(0, 12)}`,
      checkId,
      confidence: input.confidence,
      confidenceP: p,
      answer: input.answer,
      correct: grade.correct,
      reason: grade.reason,
      hits,
      brier: (p - outcome) ** 2,
      overconfident: !grade.correct && input.confidence === "certain",
      underconfident: grade.correct && input.confidence === "guessing",
      createdAt: new Date().toISOString(),
    };
    const artifact = loadArtifact(found.projectId, found.sessionId);
    artifact.attempts[checkId] = [...(artifact.attempts[checkId] ?? []), attempt];
    saveArtifact(found.projectId, found.sessionId, artifact);
    const body: AnswerCheckResponse = {
      attempt,
      reference: { rubric: found.check.rubric, hits },
    };
    return { status: 200, body };
  }

  async function sessionChecks(sessionId: string): Promise<ChecksOutcome> {
    const session = getSession(db, sessionId);
    if (!session) {
      return { status: 404, body: { error: { code: "not_found", message: "unknown session" } } };
    }
    const artifact = loadArtifact(session.projectId, sessionId);
    for (const stored of artifact.checks) checkSessions.set(stored.id, sessionId);
    const body: SessionChecksResponse = {
      checks: artifact.checks,
      attempts: artifact.attempts,
      waived: artifact.waived,
    };
    return { status: 200, body };
  }

  async function report(sessionId: string): Promise<ChecksOutcome> {
    const session = getSession(db, sessionId);
    if (!session) {
      return { status: 404, body: { error: { code: "not_found", message: "unknown session" } } };
    }
    let review: Awaited<ReturnType<typeof buildSessionReview>> | null = null;
    try {
      review = await buildSessionReview(db, dataDir, sessionId);
    } catch {
      review = null;
    }
    const artifact = loadArtifact(session.projectId, sessionId);
    const attempts = Object.values(artifact.attempts).flat();
    const latestByCheck = new Map<string, CheckAttempt>();
    for (const [checkId, list] of Object.entries(artifact.attempts)) {
      const latest = list[list.length - 1];
      if (latest) latestByCheck.set(checkId, latest);
    }
    const latest = [...latestByCheck.values()];
    const perConfidence = (["guessing", "think_so", "certain"] as AnswerConfidence[]).map(
      (confidence) => {
        const scoped = attempts.filter((attempt) => attempt.confidence === confidence);
        return {
          confidence,
          answered: scoped.length,
          correct: scoped.filter((attempt) => attempt.correct).length,
        };
      },
    );
    const body: SessionReport = {
      sessionId,
      generatedAt: new Date().toISOString(),
      hunksTotal: review?.hunks.length ?? 0,
      checksTotal: artifact.checks.length,
      answered: latest.length,
      correct: latest.filter((attempt) => attempt.correct).length,
      waived: artifact.waived,
      calibration: {
        meanBrier:
          attempts.length === 0
            ? null
            : attempts.reduce((sum, attempt) => sum + attempt.brier, 0) / attempts.length,
        overconfidenceCount: attempts.filter((attempt) => attempt.overconfident).length,
        perConfidence,
      },
      gaps: review?.diagnostics ?? [],
    };
    return { status: 200, body };
  }

  return { generate, answer, sessionChecks, report };
}
