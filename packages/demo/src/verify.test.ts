import { describe, expect, it } from "vitest";
import type { DemoBundleMeta } from "./build";
import { runDemoChecks } from "./verify";

const META: DemoBundleMeta = {
  version: 1,
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
  "GET /api/sessions/ses_demo/story": { status: 200, body: { cards: [{ id: "h_1" }] } },
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
  "GET /api/sessions/ses_unknown/story": { status: 404, body: {} },
  "GET /": { status: 200, body: "<html></html>" },
};

describe("demo verify checks", () => {
  it("passes a healthy demo server", async () => {
    const results = await runDemoChecks(mockFetch(HEALTHY), "http://demo", META);
    expect(results).toHaveLength(9);
    expect(results.filter((result) => !result.ok)).toEqual([]);
  });

  it("reports each failure by name", async () => {
    const results = await runDemoChecks(
      mockFetch({
        ...HEALTHY,
        "GET /api/sessions/ses_demo/story": { status: 200, body: { cards: [] } },
        "POST /api/sessions/ses_demo/checks-v2/generate": { status: 503, body: {} },
        "POST /api/sessions/ses_demo/checks-v2/skip": { status: 200, body: {} },
      }),
      "http://demo",
      META,
    );
    const failed = results.filter((result) => !result.ok).map((result) => result.name);
    expect(failed).toContain("story renders with cards");
    expect(failed).toContain("generate serves baked questions");
    expect(failed).toContain("readonly mutation rejected");
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
