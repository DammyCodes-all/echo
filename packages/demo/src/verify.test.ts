import { describe, expect, it } from "vitest";
import type { DemoBundleMeta } from "./build";
import { runDemoChecks } from "./verify";

const META: DemoBundleMeta = {
  version: 2,
  builtAt: "2026-10-31T00:00:00.000Z",
  projectId: "prj_demo",
  projectName: "demo",
  sessions: ["ses_demo"],
  tapeSha256: { ses_demo: "abc" },
};

function mockFetch(routes: Record<string, { status: number; body: unknown }>): (
  url: string,
  init?: { method?: string; body?: string },
) => Promise<{
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}> {
  return async (url: string, init?: { method?: string; body?: string }) => {
    const path = url.replace("http://demo", "");
    const method = init?.method ?? "GET";
    const flag = (init?.body ?? "").includes("France") ? " [france]" : "";
    const key = `${method} ${path}${flag}`;
    const route = routes[key] ?? routes[`${method} ${path}`] ?? { status: 500, body: {} };
    return {
      status: route.status,
      json: async () => route.body,
      text: async () => (typeof route.body === "string" ? route.body : JSON.stringify(route.body)),
    };
  };
}

const HEALTHY = {
  "GET /api/projects": { status: 200, body: [{ id: "prj_demo" }] },
  "GET /api/sessions/ses_demo/changes": {
    status: 200,
    body: {
      changes: [{ id: "c_0123456789abcdef", version: 1 }],
      progress: [],
      summary: "One reviewed change.",
      isLive: false,
    },
  },
  "GET /api/sessions/ses_demo/changes/c_0123456789abcdef/code": {
    status: 200,
    body: { changeId: "c_0123456789abcdef", version: 1, files: [] },
  },
  "POST /api/sessions/ses_demo/checks-v2/generate": {
    status: 200,
    body: {
      status: "in_progress",
      questions: [{ id: "q1", format: "mcq", options: [{ id: "A" }, { id: "B" }] }],
    },
  },
  "POST /api/sessions/ses_demo/checks-v2/answer": {
    status: 200,
    body: { attempt: { correct: true } },
  },
  "POST /api/sessions/ses_demo/ask [france]": { status: 200, body: { status: "refused" } },
  "POST /api/sessions/ses_demo/ask": {
    status: 503,
    body: { error: { code: "model_error" } },
  },
  "POST /api/sessions/ses_demo/checks-v2/skip": {
    status: 403,
    body: { error: { code: "readonly_demo" } },
  },
  "POST /api/sessions/ses_demo/progress": {
    status: 403,
    body: { error: { code: "readonly_demo" } },
  },
  "GET /api/sessions/ses_unknown/changes": { status: 404, body: {} },
  "GET /": { status: 200, body: "<html></html>" },
};

describe("demo verify checks", () => {
  it("passes a healthy demo server", async () => {
    const results = await runDemoChecks(mockFetch(HEALTHY), "http://demo", META);
    expect(results).toHaveLength(11);
    expect(results.filter((result) => !result.ok)).toEqual([]);
  });

  it("reports each failure by name", async () => {
    const results = await runDemoChecks(
      mockFetch({
        ...HEALTHY,
        "GET /api/sessions/ses_demo/changes": {
          status: 200,
          body: { changes: [], progress: [], summary: "", isLive: false },
        },
        "POST /api/sessions/ses_demo/checks-v2/generate": { status: 503, body: {} },
        "POST /api/sessions/ses_demo/checks-v2/skip": { status: 200, body: {} },
        "POST /api/sessions/ses_demo/progress": { status: 200, body: {} },
      }),
      "http://demo",
      META,
    );
    const failed = results.filter((result) => !result.ok).map((result) => result.name);
    expect(failed).toContain("reader renders changes");
    expect(failed).toContain("change code serves diffs");
    expect(failed).toContain("generate serves baked questions");
    expect(failed).toContain("readonly mutation rejected");
    expect(failed).toContain("progress write rejected");
  });

  it("fails the answer check when the baked set has no mcq", async () => {
    const results = await runDemoChecks(
      mockFetch({
        ...HEALTHY,
        "POST /api/sessions/ses_demo/checks-v2/generate": {
          status: 200,
          body: { status: "in_progress", questions: [{ id: "q1", format: "free_text" }] },
        },
      }),
      "http://demo",
      META,
    );
    const answer = results.find((result) => result.name === "check answer grades");
    expect(answer?.ok).toBe(false);
    expect(answer?.detail).toContain("no mcq");
  });
});
