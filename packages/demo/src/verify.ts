import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoBundleMeta } from "./build";
import { findFreePort, spawnDemoServer } from "./serve";

export interface DemoCheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

function sessionOf(meta: DemoBundleMeta): string {
  const first = meta.sessions[0];
  if (!first) throw new Error("bundle meta has no sessions");
  return first;
}

/**
 * ARCH §18 build step 5 as pure HTTP: project, session, story, baked
 * generate, MCQ answer, ask refusal, readonly rejection, unknown-session
 * 404, web index. Runs model-free (the server boots ECHO_MODEL=off), so the
 * ask check uses a question the tape cannot answer and expects refusal.
 */
export async function runDemoChecks(
  fetchImpl: FetchLike,
  baseUrl: string,
  meta: DemoBundleMeta,
): Promise<DemoCheckResult[]> {
  const results: DemoCheckResult[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    results.push({ name, ok, detail });
  };
  const get = (path: string) => fetchImpl(`${baseUrl}${path}`);
  const post = (path: string, body: unknown) =>
    fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const sessionId = sessionOf(meta);

  const projects = await get("/api/projects");
  const projectList = (await projects.json()) as Array<{ id: string }>;
  check(
    "project loads",
    projects.status === 200 && projectList.some((p) => p.id === meta.projectId),
  );

  const story = await get(`/api/sessions/${sessionId}/story`);
  const storyBody = (await story.json()) as { cards?: unknown[] };
  check(
    "story renders with cards",
    story.status === 200 && Array.isArray(storyBody.cards) && storyBody.cards.length > 0,
  );

  const generated = await post(`/api/sessions/${sessionId}/checks-v2/generate`, {});
  const generatedBody = (await generated.json()) as {
    status?: string;
    questions?: Array<{ id: string; format: string; options?: Array<{ id: string }> }>;
  };
  const mcq = generatedBody.questions?.find((q) => q.format === "mcq");
  check(
    "generate serves baked questions",
    generated.status === 200 && (generatedBody.questions?.length ?? 0) > 0,
  );

  if (mcq?.options?.[0]) {
    const answered = await post(`/api/sessions/${sessionId}/checks-v2/answer`, {
      questionId: mcq.id,
      confidence: "certain",
      selectedOptionId: mcq.options[0].id,
      answerText: null,
    });
    const answeredBody = (await answered.json()) as { attempt?: { correct?: boolean } };
    check(
      "check answer grades",
      answered.status === 200 && typeof answeredBody.attempt?.correct === "boolean",
    );
  } else {
    check("check answer grades", false, "no mcq question in the baked set");
  }

  // France has no terms on any tape: pre-model refusal, no model needed.
  const refused = await post(`/api/sessions/${sessionId}/ask`, {
    question: "What is the capital of France?",
  });
  const refusedBody = (await refused.json()) as { status?: string };
  check("ask refuses off-tape", refused.status === 200 && refusedBody.status === "refused");

  // A question with evidence but no model fails closed instead of guessing.
  const unanswerable = await post(`/api/sessions/${sessionId}/ask`, {
    question: "What discussions led to this software design?",
  });
  const unanswerableBody = (await unanswerable.json()) as { error?: { code?: string } };
  check(
    "ask needs a model for judgment calls",
    unanswerable.status === 503 && unanswerableBody.error?.code === "model_error",
  );

  const skipped = await post(`/api/sessions/${sessionId}/checks-v2/skip`, {});
  const skippedBody = (await skipped.json()) as { error?: { code?: string } };
  check(
    "readonly mutation rejected",
    skipped.status === 403 && skippedBody.error?.code === "readonly_demo",
  );

  const unknown = await get("/api/sessions/ses_unknown/story");
  check("unknown session 404s", unknown.status === 404);

  const index = await get("/");
  const html = await index.text();
  check("web index serves", index.status === 200 && html.includes("<html"));

  return results;
}

export async function verifyDemoBundle(args: {
  serverBin: string;
  bundleDir: string;
  port?: number;
  timeoutMs?: number;
}): Promise<DemoCheckResult[]> {
  const metaPath = join(args.bundleDir, "meta.json");
  if (!existsSync(metaPath)) throw new Error(`no meta.json in ${args.bundleDir}`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as DemoBundleMeta;
  const port = args.port ?? (await findFreePort());
  const timeoutMs = args.timeoutMs ?? 30_000;
  const server = spawnDemoServer({ serverBin: args.serverBin, bundleDir: args.bundleDir, port });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const started = Date.now();
    for (;;) {
      try {
        const health = await fetch(`${baseUrl}/api/health`);
        const body = (await health.json()) as { mode?: string };
        if (health.status === 200 && body.mode === "demo") break;
      } catch {
        // Still booting.
      }
      if (server.child.exitCode !== null) {
        throw new Error(`demo server exited during boot: ${server.stderrTail().slice(-500)}`);
      }
      if (Date.now() - started > timeoutMs) throw new Error("demo server boot timed out");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return await runDemoChecks(fetch, baseUrl, meta);
  } finally {
    await server.stop();
  }
}
