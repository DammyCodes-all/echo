import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CardPicture,
  type ChecksV2State,
  ChecksV2StateSchema,
  type PictureBucket,
  ProjectLearnResponseSchema,
  type SessionStory,
  SessionStorySchema,
} from "@echo/contracts";
import { type EchoDb, getArtifactRef, getProject, listSessions } from "@echo/db";

export interface LearnOutcome {
  status: number;
  body: unknown;
}

const BUCKETS: PictureBucket[] = [
  "solid",
  "right_but_unsure",
  "confident_but_wrong",
  "wrong_and_knew_it",
  "never_looked",
];

function emptyTotals(): Record<PictureBucket, number> {
  return {
    solid: 0,
    right_but_unsure: 0,
    confident_but_wrong: 0,
    wrong_and_knew_it: 0,
    never_looked: 0,
  };
}

function artifactCandidates(
  db: EchoDb,
  dataDir: string,
  sessionId: string,
  projectId: string,
  kind: "story" | "checks_v2",
): string[] {
  const file = kind === "story" ? "story.json" : "checks_v2.json";
  const ref = getArtifactRef(db, sessionId, kind);
  const fallback = join(dataDir, "projects", projectId, "sessions", sessionId, "artifacts", file);
  if (ref && typeof ref.path === "string" && ref.path.length > 0) {
    return ref.path === fallback ? [fallback] : [ref.path, fallback];
  }
  return [fallback];
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function loadStory(
  db: EchoDb,
  dataDir: string,
  sessionId: string,
  projectId: string,
): SessionStory | null {
  for (const path of artifactCandidates(db, dataDir, sessionId, projectId, "story")) {
    const parsed = SessionStorySchema.safeParse(readJson(path));
    if (parsed.success) return parsed.data;
  }
  return null;
}

interface ChecksLoad {
  status: "offered" | "in_progress" | "completed" | "skipped" | "none";
  picture: CardPicture[];
}

function loadChecks(db: EchoDb, dataDir: string, sessionId: string, projectId: string): ChecksLoad {
  for (const path of artifactCandidates(db, dataDir, sessionId, projectId, "checks_v2")) {
    const raw = readJson(path);
    if (raw === null) continue;
    const parsed = ChecksV2StateSchema.safeParse(raw);
    if (parsed.success) {
      const state: ChecksV2State = parsed.data;
      return { status: state.status, picture: state.picture };
    }
    // Stored questions are never public, but a public-shaped file can still
    // carry the picture this endpoint needs. Shape-check manually instead of
    // widening the contract: status plus a cardId/bucket picture array.
    const loose = raw as { status?: unknown; picture?: unknown };
    if (
      (loose.status === "offered" ||
        loose.status === "in_progress" ||
        loose.status === "completed" ||
        loose.status === "skipped") &&
      Array.isArray(loose.picture)
    ) {
      const picture: CardPicture[] = [];
      for (const entry of loose.picture) {
        const candidate = entry as { cardId?: unknown; bucket?: unknown; questionId?: unknown };
        if (
          typeof candidate.cardId === "string" &&
          /^h_[0-9a-f]{16}$/.test(candidate.cardId) &&
          typeof candidate.bucket === "string" &&
          (BUCKETS as string[]).includes(candidate.bucket)
        ) {
          picture.push({
            cardId: candidate.cardId as CardPicture["cardId"],
            bucket: candidate.bucket as PictureBucket,
            questionId: typeof candidate.questionId === "string" ? candidate.questionId : null,
          });
        }
      }
      return { status: loose.status, picture };
    }
  }
  return { status: "none", picture: [] };
}

export function createLearnService(deps: { db: EchoDb; dataDir: string }): {
  summary: (projectId: string) => LearnOutcome;
} {
  const { db, dataDir } = deps;

  function summary(projectId: string): LearnOutcome {
    if (!getProject(db, projectId)) {
      return { status: 404, body: { error: { code: "not_found", message: "unknown project" } } };
    }
    const sessions = listSessions(db, projectId);
    const bucketTotals = emptyTotals();
    const perFile = new Map<string, { confidentWrong: number; total: number }>();
    const entries: Array<{
      sessionId: string;
      title: string | null;
      summary: string | null;
      checkStatus: "not_checked" | "checked" | "skipped";
      lastActivity: string;
      checksStatus: ChecksLoad["status"];
      picture: CardPicture[];
    }> = [];
    let checkedCount = 0;
    let skippedCount = 0;

    for (const session of sessions) {
      if (session.checkStatus === "checked") checkedCount += 1;
      if (session.checkStatus === "skipped") skippedCount += 1;
      const checks = loadChecks(db, dataDir, session.id, projectId);
      const story = loadStory(db, dataDir, session.id, projectId);
      const touchesByCard = new Map<string, string[]>();
      if (story) {
        for (const card of story.cards) touchesByCard.set(card.id, card.touches);
      }
      for (const entry of checks.picture) {
        bucketTotals[entry.bucket] += 1;
        const touches = touchesByCard.get(entry.cardId) ?? [];
        const bad = entry.bucket === "confident_but_wrong" || entry.bucket === "wrong_and_knew_it";
        for (const file of touches) {
          const slot = perFile.get(file) ?? { confidentWrong: 0, total: 0 };
          slot.total += 1;
          if (bad) slot.confidentWrong += 1;
          perFile.set(file, slot);
        }
      }
      entries.push({
        sessionId: session.id,
        title: session.title,
        summary: session.summary,
        checkStatus: session.checkStatus,
        lastActivity: session.lastActivity,
        checksStatus: checks.status,
        picture: checks.picture,
      });
    }

    const weakAreas = [...perFile.entries()]
      .filter(([, counts]) => counts.confidentWrong > 0)
      .sort(
        (a, b) =>
          b[1].confidentWrong - a[1].confidentWrong ||
          b[1].total - a[1].total ||
          (a[0] < b[0] ? -1 : 1),
      )
      .slice(0, 8)
      .map(([file, counts]) => ({
        file,
        confidentWrong: counts.confidentWrong,
        total: counts.total,
      }));

    const body = {
      projectId,
      sessionCount: sessions.length,
      checkedCount,
      skippedCount,
      notCheckedCount: sessions.length - checkedCount - skippedCount,
      bucketTotals,
      weakAreas,
      sessions: entries,
    };
    // Fail fast if the response ever drifts from the contract.
    return { status: 200, body: ProjectLearnResponseSchema.parse(body) };
  }

  return { summary };
}

export type LearnService = ReturnType<typeof createLearnService>;
