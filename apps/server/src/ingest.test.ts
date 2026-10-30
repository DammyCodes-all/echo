import fs, { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  getSession,
  openEchoDb,
  recordEngagementEvents,
  upsertArtifactRef,
  upsertSession,
} from "@echo/db";
import { resolveRepositoryIdentity } from "@echo/snapshots";
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { createIngest } from "./ingest";

const log = { info: () => {}, error: () => {} };

async function makeGitProject(): Promise<{ root: string; workDir: string }> {
  const root = mkdtempSync(join(tmpdir(), "echo-opencode-identity-"));
  await git.init({ fs, dir: root });
  await git.setConfig({
    fs,
    dir: root,
    path: "remote.origin.url",
    value: "https://github.com/example/echo.git",
  });
  const workDir = join(root, "packages", "app");
  return { root, workDir };
}

function makeSource(sessionId: string, directory: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "echo-opencode-source-")), `${sessionId}.db`);
  const store = new DatabaseSync(path);
  store.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT, agent TEXT,
      time_created INTEGER, time_updated INTEGER, parent_id TEXT
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, data TEXT
    );
  `);
  store
    .prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(sessionId, "identity", directory, null, "opencode", 1793097800000, 1793097801000, null);
  store
    .prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      "msg_user",
      sessionId,
      "user",
      1,
      1793097800000,
      JSON.stringify({ text: "read the file", time: { created: 1793097800000 } }),
    );
  store.close();
  return path;
}

function makeTwoSessionSource(
  sessions: Array<{ id: string; directory: string; timeCreated: number; parentId?: string }>,
): string {
  const path = join(mkdtempSync(join(tmpdir(), "echo-opencode-source-")), "multi.db");
  const store = new DatabaseSync(path);
  store.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT, agent TEXT,
      time_created INTEGER, time_updated INTEGER, parent_id TEXT
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, data TEXT
    );
  `);
  for (const session of sessions) {
    store
      .prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        session.id,
        session.id,
        session.directory,
        null,
        "opencode",
        session.timeCreated,
        session.timeCreated,
        session.parentId ?? null,
      );
    store
      .prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        `msg_${session.id}`,
        session.id,
        "user",
        1,
        session.timeCreated,
        JSON.stringify({ text: "read the file", time: { created: session.timeCreated } }),
      );
  }
  store.close();
  return path;
}

describe("createIngest project identity", () => {
  it("joins an OpenCode session in a subdirectory to its repository project", async () => {
    const { workDir } = await makeGitProject();
    const dataDir = mkdtempSync(join(tmpdir(), "echo-opencode-identity-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "echo-opencode-identity-config-"));
    const source = makeSource("ses_opencode_identity", workDir);
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ projects: [workDir], opencode_db: source, poll_interval_ms: 250 }),
    );
    const previousConfigDir = process.env.ECHO_CONFIG_DIR;
    process.env.ECHO_CONFIG_DIR = configDir;
    try {
      const db = openEchoDb(join(dataDir, "echo.sqlite"));
      try {
        const result = await createIngest({ dataDir, db, log }).runOnce();
        expect(result.capturedSessions).toBe(1);
        expect(result.eventsAdded).toBeGreaterThan(0);

        const identity = await resolveRepositoryIdentity(workDir);
        expect(identity.remoteUrl).toBe("github.com/example/echo");
        const tape = await readFile(
          join(
            dataDir,
            "projects",
            identity.projectId,
            "sessions",
            "ses_opencode_identity",
            "tape.jsonl",
          ),
          "utf8",
        );
        expect(tape).toContain("ses_opencode_identity");
      } finally {
        db.close();
      }
    } finally {
      if (previousConfigDir === undefined) delete process.env.ECHO_CONFIG_DIR;
      else process.env.ECHO_CONFIG_DIR = previousConfigDir;
    }
  });

  it("does not capture a sibling directory just because it shares the repo", async () => {
    const { root, workDir } = await makeGitProject();
    const otherDir = join(root, "packages", "other");
    const dataDir = mkdtempSync(join(tmpdir(), "echo-opencode-scope-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "echo-opencode-scope-config-"));
    const source = makeSource("ses_opencode_scope", otherDir);
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ projects: [workDir], opencode_db: source, poll_interval_ms: 250 }),
    );
    const previousConfigDir = process.env.ECHO_CONFIG_DIR;
    process.env.ECHO_CONFIG_DIR = configDir;
    try {
      const db = openEchoDb(join(dataDir, "echo.sqlite"));
      try {
        const result = await createIngest({ dataDir, db, log }).runOnce();
        expect(result.capturedSessions).toBe(0);
        expect(result.eventsAdded).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      if (previousConfigDir === undefined) delete process.env.ECHO_CONFIG_DIR;
      else process.env.ECHO_CONFIG_DIR = previousConfigDir;
    }
  });
});

describe("createIngest identity migration", () => {
  it("keeps the historic project id when a remote appears mid-life", async () => {
    const { root, workDir } = await makeGitProject();
    const dataDir = mkdtempSync(join(tmpdir(), "echo-opencode-migrate-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "echo-opencode-migrate-config-"));
    const source = makeTwoSessionSource([
      { id: "ses_migrate_new", directory: workDir, timeCreated: 1793097800000 },
    ]);
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ projects: [workDir], opencode_db: source, poll_interval_ms: 250 }),
    );
    const previousConfigDir = process.env.ECHO_CONFIG_DIR;
    process.env.ECHO_CONFIG_DIR = configDir;
    try {
      const { projectIdForDirectory } = await import("@echo/core");
      const db = openEchoDb(join(dataDir, "echo.sqlite"));
      try {
        // Project captured before the remote existed: root-derived id, no remote.
        const { upsertProject, listProjects } = await import("@echo/db");
        upsertProject(db, {
          id: projectIdForDirectory(root),
          root,
          remoteUrl: null,
          name: "echo",
        });
        const result = await createIngest({ dataDir, db, log }).runOnce();
        expect(result.capturedSessions).toBe(1);
        expect(result.eventsAdded).toBeGreaterThan(0);
        // One row, historic id kept, remote recorded — no UNIQUE crash and no
        // orphaned second project.
        const projects = listProjects(db);
        expect(projects).toHaveLength(1);
        expect(projects[0]?.id).toBe(projectIdForDirectory(root));
        expect(projects[0]?.remoteUrl).toBe("github.com/example/echo");
      } finally {
        db.close();
      }
    } finally {
      if (previousConfigDir === undefined) delete process.env.ECHO_CONFIG_DIR;
      else process.env.ECHO_CONFIG_DIR = previousConfigDir;
    }
  });

  it("a poison session does not starve the rest of the poll", async () => {
    const { workDir } = await makeGitProject();
    const dataDir = mkdtempSync(join(tmpdir(), "echo-opencode-poison-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "echo-opencode-poison-config-"));
    const source = makeTwoSessionSource([
      { id: "ses_poison_new", directory: workDir, timeCreated: 1793097801000 },
      { id: "ses_poison_ok", directory: workDir, timeCreated: 1793097800000 },
    ]);
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ projects: [workDir], opencode_db: source, poll_interval_ms: 250 }),
    );
    const previousConfigDir = process.env.ECHO_CONFIG_DIR;
    process.env.ECHO_CONFIG_DIR = configDir;
    try {
      const identity = await resolveRepositoryIdentity(workDir);
      // A stray file where the session dir belongs makes tape setup throw
      // ENOTDIR for exactly one session.
      fs.mkdirSync(join(dataDir, "projects", identity.projectId, "sessions"), {
        recursive: true,
      });
      writeFileSync(
        join(dataDir, "projects", identity.projectId, "sessions", "ses_poison_new"),
        "stray",
      );
      const db = openEchoDb(join(dataDir, "echo.sqlite"));
      try {
        const result = await createIngest({ dataDir, db, log }).runOnce();
        expect(result.capturedSessions).toBe(1);
        expect(result.eventsAdded).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    } finally {
      if (previousConfigDir === undefined) delete process.env.ECHO_CONFIG_DIR;
      else process.env.ECHO_CONFIG_DIR = previousConfigDir;
    }
  });
});

describe("createIngest subagent lanes", () => {
  async function ingestOnce(
    source: string,
    workDir: string,
    assert: (ctx: {
      db: ReturnType<typeof openEchoDb>;
      dataDir: string;
      result: Awaited<ReturnType<ReturnType<typeof createIngest>["runOnce"]>>;
    }) => void | Promise<void>,
  ): Promise<void> {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-opencode-lane-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "echo-opencode-lane-config-"));
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ projects: [workDir], opencode_db: source, poll_interval_ms: 250 }),
    );
    const previousConfigDir = process.env.ECHO_CONFIG_DIR;
    process.env.ECHO_CONFIG_DIR = configDir;
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    try {
      const result = await createIngest({ dataDir, db, log }).runOnce();
      await assert({ db, dataDir, result });
    } finally {
      db.close();
      if (previousConfigDir === undefined) delete process.env.ECHO_CONFIG_DIR;
      else process.env.ECHO_CONFIG_DIR = previousConfigDir;
    }
  }

  it("routes child messages to the parent tape without a child card", async () => {
    const { workDir } = await makeGitProject();
    const source = makeTwoSessionSource([
      { id: "ses_lane_parent", directory: workDir, timeCreated: 1793097800000 },
      {
        id: "ses_lane_child",
        directory: workDir,
        timeCreated: 1793097801000,
        parentId: "ses_lane_parent",
      },
    ]);
    await ingestOnce(source, workDir, async ({ db, dataDir, result }) => {
      // One card (the parent); the child never becomes a session row.
      expect(result.capturedSessions).toBe(1);
      expect(result.eventsAdded).toBeGreaterThan(0);
      expect(getSession(db, "ses_lane_child")).toBeNull();
      expect(getSession(db, "ses_lane_parent")).not.toBeNull();
      const identity = await resolveRepositoryIdentity(workDir);
      expect(identity.remoteUrl).toBe("github.com/example/echo");
      const tape = await readFile(
        join(dataDir, "projects", identity.projectId, "sessions", "ses_lane_parent", "tape.jsonl"),
        "utf8",
      );
      expect(tape).toContain('"kind":"subagent.started"');
      expect(tape).toContain('"subagent_id":"ses_lane_child"');
      expect(tape).toContain('"parent_session_id":"ses_lane_parent"');
      // The child prompt lands on the parent tape under the lane key.
      expect(tape).toContain(
        "opencode:ses_lane_parent:subagent:ses_lane_child:msg:msg_ses_lane_child",
      );
      expect(tape).toContain("read the file");
    });
  });

  it("skips children whose parent never lands", async () => {
    const { workDir } = await makeGitProject();
    const source = makeTwoSessionSource([
      {
        id: "ses_lane_orphan",
        directory: workDir,
        timeCreated: 1793097800000,
        parentId: "ses_lane_absent",
      },
    ]);
    await ingestOnce(source, workDir, ({ db, result }) => {
      expect(result.capturedSessions).toBe(0);
      expect(result.eventsAdded).toBe(0);
      expect(getSession(db, "ses_lane_orphan")).toBeNull();
      expect(getSession(db, "ses_lane_absent")).toBeNull();
    });
  });

  it("removes untouched pre-lane orphan rows and re-ingests them as a lane", async () => {
    const { workDir } = await makeGitProject();
    const source = makeTwoSessionSource([
      { id: "ses_lane_parent", directory: workDir, timeCreated: 1793097800000 },
      {
        id: "ses_lane_child",
        directory: workDir,
        timeCreated: 1793097801000,
        parentId: "ses_lane_parent",
      },
    ]);
    const dataDir = mkdtempSync(join(tmpdir(), "echo-opencode-lane-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "echo-opencode-lane-config-"));
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ projects: [workDir], opencode_db: source, poll_interval_ms: 250 }),
    );
    const previousConfigDir = process.env.ECHO_CONFIG_DIR;
    process.env.ECHO_CONFIG_DIR = configDir;
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    try {
      const identity = await resolveRepositoryIdentity(workDir);
      // Simulate the pre-fix row: a session minted for the child id.
      const { upsertProject } = await import("@echo/db");
      upsertProject(db, {
        id: identity.projectId,
        root: identity.canonicalRoot,
        remoteUrl: identity.remoteUrl,
        name: "echo",
      });
      const orphanTapeDir = join(
        dataDir,
        "projects",
        identity.projectId,
        "sessions",
        "ses_lane_child",
      );
      fs.mkdirSync(orphanTapeDir, { recursive: true });
      writeFileSync(join(orphanTapeDir, "tape.jsonl"), '{"stale":true}\n');
      upsertSession(db, {
        id: "ses_lane_child",
        projectId: identity.projectId,
        agent: "opencode",
        model: null,
        directory: workDir,
        title: "child work",
        startedAt: null,
        tapePath: join(orphanTapeDir, "tape.jsonl"),
        captureQuality: "import_only",
      });
      // An auto-generated story alone does not protect the orphan: it
      // rebuilds from the parent lane, matching the live rows which all
      // carry exactly one story artifact.
      upsertArtifactRef(db, {
        sessionId: "ses_lane_child",
        kind: "story",
        path: join(orphanTapeDir, "artifacts", "story.json"),
        tapeWatermark: { eventCount: 1, sha256: "orphan" },
        generator: "story-v1",
        generatedAt: "2026-10-28T10:00:00.000Z",
      });
      const result = await createIngest({ dataDir, db, log }).runOnce();
      expect(result.capturedSessions).toBe(1);
      // Orphan row gone, dir gone, history restored on the parent lane.
      expect(getSession(db, "ses_lane_child")).toBeNull();
      expect(fs.existsSync(orphanTapeDir)).toBe(false);
      const tape = await readFile(
        join(dataDir, "projects", identity.projectId, "sessions", "ses_lane_parent", "tape.jsonl"),
        "utf8",
      );
      expect(tape).toContain('"kind":"subagent.started"');
      expect(tape).toContain("read the file");
    } finally {
      db.close();
      if (previousConfigDir === undefined) delete process.env.ECHO_CONFIG_DIR;
      else process.env.ECHO_CONFIG_DIR = previousConfigDir;
    }
  });

  it("keeps orphan rows the user has touched and skips their lane", async () => {
    const { workDir } = await makeGitProject();
    const source = makeTwoSessionSource([
      { id: "ses_lane_parent", directory: workDir, timeCreated: 1793097800000 },
      {
        id: "ses_lane_child",
        directory: workDir,
        timeCreated: 1793097801000,
        parentId: "ses_lane_parent",
      },
    ]);
    const dataDir = mkdtempSync(join(tmpdir(), "echo-opencode-lane-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "echo-opencode-lane-config-"));
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ projects: [workDir], opencode_db: source, poll_interval_ms: 250 }),
    );
    const previousConfigDir = process.env.ECHO_CONFIG_DIR;
    process.env.ECHO_CONFIG_DIR = configDir;
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    try {
      const identity = await resolveRepositoryIdentity(workDir);
      const { upsertProject } = await import("@echo/db");
      upsertProject(db, {
        id: identity.projectId,
        root: identity.canonicalRoot,
        remoteUrl: identity.remoteUrl,
        name: "echo",
      });
      upsertSession(db, {
        id: "ses_lane_child",
        projectId: identity.projectId,
        agent: "opencode",
        model: null,
        directory: workDir,
        title: "child work",
        startedAt: null,
        tapePath: join(
          dataDir,
          "projects",
          identity.projectId,
          "sessions",
          "ses_lane_child",
          "tape.jsonl",
        ),
        captureQuality: "import_only",
      });
      recordEngagementEvents(db, "ses_lane_child", [
        {
          id: "eng_lane",
          cardId: null,
          kind: "story_opened",
          occurredAt: "2026-10-28T10:00:00.000Z",
        },
      ]);
      await createIngest({ dataDir, db, log }).runOnce();
      // The touched card stays, and its messages stay out of the parent tape.
      expect(getSession(db, "ses_lane_child")).not.toBeNull();
      const tape = await readFile(
        join(dataDir, "projects", identity.projectId, "sessions", "ses_lane_parent", "tape.jsonl"),
        "utf8",
      );
      expect(tape).not.toContain("subagent.started");
    } finally {
      db.close();
      if (previousConfigDir === undefined) delete process.env.ECHO_CONFIG_DIR;
      else process.env.ECHO_CONFIG_DIR = previousConfigDir;
    }
  });
});

describe("createIngest poll stability", () => {
  it("does not touch session timestamps when a poll captures nothing new", async () => {
    const { workDir } = await makeGitProject();
    const source = makeSource("ses_stable", workDir);
    const dataDir = mkdtempSync(join(tmpdir(), "echo-opencode-stable-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "echo-opencode-stable-config-"));
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ projects: [workDir], opencode_db: source, poll_interval_ms: 250 }),
    );
    const previousConfigDir = process.env.ECHO_CONFIG_DIR;
    process.env.ECHO_CONFIG_DIR = configDir;
    const db = openEchoDb(join(dataDir, "echo.sqlite"));
    try {
      const first = await createIngest({ dataDir, db, log }).runOnce();
      expect(first.capturedSessions).toBe(1);
      const row = db.prepare("SELECT updated_at FROM sessions WHERE id = ?").get("ses_stable") as {
        updated_at: string;
      };
      const second = await createIngest({ dataDir, db, log }).runOnce();
      expect(second.eventsAdded).toBe(0);
      // No fresh events, no snapshots, no row rewrite: the / grid and inbox
      // order stay put instead of reshuffling every 5s.
      expect(
        (
          db.prepare("SELECT updated_at FROM sessions WHERE id = ?").get("ses_stable") as {
            updated_at: string;
          }
        ).updated_at,
      ).toBe(row.updated_at);
    } finally {
      db.close();
      if (previousConfigDir === undefined) delete process.env.ECHO_CONFIG_DIR;
      else process.env.ECHO_CONFIG_DIR = previousConfigDir;
    }
  });
});
