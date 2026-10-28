import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStorySchema } from "@echo/contracts";
import { openEchoDb, upsertArtifactRef, upsertProject, upsertSession } from "@echo/db";
import { computeWatermark } from "./apps/server/src/story-facts";

const dataDir = mkdtempSync(join(tmpdir(), "echo-probe-"));
const db = openEchoDb(join(dataDir, "echo.sqlite"));
const projectId = "prj_probe";
const sessionId = "ses_probe";
upsertProject(db, { id: projectId, root: "/tmp/probe-repo", name: "probe" });
upsertSession(db, {
  id: sessionId,
  projectId,
  agent: "opencode",
  model: null,
  directory: "/tmp/probe-repo",
  title: null,
  startedAt: "2026-10-28T10:00:00.000Z",
  tapePath: join(dataDir, "tape.jsonl"),
  captureQuality: "full",
});
db.prepare(
  "INSERT INTO events (id, session_id, tape_seq, kind, ts, observed_at, payload_json, redaction_json, created_at) VALUES ('e1', ?, 1, 'prompt.submitted', '2026-10-28T10:00:00.000Z', '2026-10-28T10:00:00.000Z', '{\"text\":\"add greeting\"}', '{\"version\":\"r1\",\"findings\":0}', '2026-10-28T10:00:00.000Z')",
).run(sessionId);
const watermark = computeWatermark([{ event_id: "e1" }]);
const story = SessionStorySchema.parse({
  schemaVersion: 1,
  sessionId,
  generatedAt: "2026-10-28T10:00:00.000Z",
  generator: { kind: "skeleton", model: null, promptVersion: "skeleton-v1" },
  tapeWatermark: watermark,
  summary: "Add a greeting.",
  skeleton: true,
  shortVersion: [],
  askVsResult: { asked: [], delivered: [], extras: [], missing: [] },
  cards: [
    {
      id: "h_probe1",
      headline: "Add greeting line to notes",
      constituentHunkIds: ["h_probe1"],
      constituentActionIds: [],
      rank: 1,
      sessionOrder: 0,
      highRisk: false,
      riskReasons: [],
      verification: "nothing",
      why: [],
      before: [],
      now: [],
      checkedBy: [],
      touches: ["notes.txt"],
      moment: { eventId: null, toolCallId: null, ts: null, excerpt: "", label: "observed" },
      history: { priorSessionIds: [], previousPicture: null, note: null },
    },
  ],
  routineSummary: null,
  detours: [],
  looseEnds: [],
  blindSpots: [],
  gaps: [],
  verifiedCounts: { observed: 0, partlyObserved: 0, agentStated: 0, nothing: 1, total: 1 },
});
const dir = join(dataDir, "projects", projectId, "sessions", sessionId, "artifacts");
mkdirSync(dir, { recursive: true });
const storyPath = join(dir, "story.json");
writeFileSync(storyPath, JSON.stringify(story, null, 2));
upsertArtifactRef(db, {
  sessionId,
  kind: "story",
  path: storyPath,
  tapeWatermark: watermark,
  generator: "skeleton-v1",
  generatedAt: "2026-10-28T10:00:00.000Z",
});
db.close();
console.log(dataDir);
