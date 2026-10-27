import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { finalizeMuseSession } from "@echo/capture-muse";
import type { CaptureQuality, TapeEvent } from "@echo/contracts";
import {
  type EchoDb,
  getSessionEventIds,
  insertStampedEvents,
  maxTapeSeq,
  upsertProject,
  upsertSession,
} from "@echo/db";
import { TapeWriter } from "@echo/tape";

export interface MuseIngestLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export interface MuseIngestOptions {
  dataDir: string;
  db: EchoDb;
  log: MuseIngestLogger;
  sessionsDir?: string;
  projects: string[];
}

export interface MuseIngestResult {
  scanned: number;
  capturedSessions: number;
  eventsAdded: number;
}

const MAX_LOG_BYTES = 128 * 1024 * 1024;

export function resolveMuseSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MUSE_SESSIONS_DIR) return env.MUSE_SESSIONS_DIR;
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "muse", "sessions");
}

// Same project identity as the OpenCode adapter (prj_<sha16 of directory)):
// session rows join across agents on this id.
export function museProjectIdForDirectory(directory: string): string {
  return `prj_${createHash("sha256").update(directory).digest("hex").slice(0, 16)}`;
}

function isUnder(directory: string, root: string): boolean {
  const normalizedDirectory = resolve(directory);
  const normalizedRoot = resolve(root);
  return (
    normalizedDirectory === normalizedRoot || normalizedDirectory.startsWith(normalizedRoot + sep)
  );
}

function walkSessionLogs(sessionsDir: string): string[] {
  const found: string[] = [];
  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "subagent") continue;
      const abs = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (entry === "session.jsonl") continue;
        stack.push(abs);
      } else if (entry === "session.jsonl") {
        found.push(abs);
      }
    }
  }
  return found;
}

function childContents(sessionFile: string): string[] {
  const out: string[] = [];
  const dir = join(dirname(sessionFile), "subagent");
  let children: string[];
  try {
    children = readdirSync(dir);
  } catch {
    return out;
  }
  for (const child of children) {
    const log = join(dir, child, "session.jsonl");
    try {
      if (statSync(log).size <= MAX_LOG_BYTES) out.push(readFileSync(log, "utf8"));
    } catch {
      // Unreadable child logs are skipped; the parent notes a gap downstream.
    }
  }
  return out;
}

function extractWorkspaceRoot(content: string): string | null {
  // Attribution without guessing: only explicit workspace markers count.
  for (const line of content.split("\n", 200)) {
    if (!line.includes("workspace_root") && !line.includes("route_facts")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const payload = (parsed as Record<string, unknown>).payload;
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
      const record = payload as Record<string, unknown>;
      const metadata = record.metadata;
      if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
        const root = (metadata as Record<string, unknown>).workspace_root;
        if (typeof root === "string" && root.length > 0) return root;
      }
      const facts = record.route_facts;
      if (facts !== null && typeof facts === "object" && !Array.isArray(facts)) {
        const cwd = (facts as Record<string, unknown>).cwd;
        if (typeof cwd === "string" && cwd.length > 0) return cwd;
      }
    } catch {
      // Unparseable lines are not evidence; the reader counts them.
    }
  }
  return null;
}

export function createMuseIngest(options: MuseIngestOptions) {
  const { dataDir, db, log, projects } = options;
  const sessionsDir = options.sessionsDir ?? resolveMuseSessionsDir();
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  function emptyResult(): MuseIngestResult {
    return { scanned: 0, capturedSessions: 0, eventsAdded: 0 };
  }

  async function scan(): Promise<MuseIngestResult> {
    const result = emptyResult();
    if (projects.length === 0 || !existsSync(sessionsDir)) return result;
    const observedAt = new Date().toISOString();
    for (const sessionFile of walkSessionLogs(sessionsDir)) {
      result.scanned += 1;
      let content: string;
      try {
        if (statSync(sessionFile).size > MAX_LOG_BYTES) continue;
        content = readFileSync(sessionFile, "utf8");
      } catch (error) {
        log.error({ err: String(error), session_file: sessionFile }, "muse log unreadable");
        continue;
      }
      const workspaceRoot = extractWorkspaceRoot(content);
      if (!workspaceRoot) continue;
      const root = projects.find((candidate) => isUnder(workspaceRoot, candidate));
      if (!root) continue;
      const sessionId = basename(dirname(sessionFile));
      const projectId = museProjectIdForDirectory(resolve(root));
      let finalized: ReturnType<typeof finalizeMuseSession> | undefined;
      try {
        finalized = finalizeMuseSession({
          sessionId,
          projectId,
          build: null,
          liveContent: content,
          childContents: childContents(sessionFile),
          observedAt: new Date(observedAt),
        });
      } catch (error) {
        log.error({ err: String(error), session_id: sessionId }, "muse finalize failed");
        continue;
      }
      const quality: CaptureQuality = finalized.quality;
      const tapePath = join(dataDir, "projects", projectId, "sessions", sessionId, "tape.jsonl");
      mkdirSync(dirname(tapePath), { recursive: true });
      upsertProject(db, { id: projectId, root: resolve(root), name: basename(root) });
      upsertSession(db, {
        id: sessionId,
        projectId,
        agent: "muse",
        model: null,
        directory: workspaceRoot,
        title: null,
        startedAt: finalized.events[0]?.ts ?? null,
        tapePath,
        captureQuality: quality,
      });
      const existing = getSessionEventIds(db, sessionId);
      const fresh = finalized.events.filter((event: TapeEvent) => !existing.has(event.event_id));
      if (fresh.length > 0) {
        let seq = maxTapeSeq(db, sessionId);
        for (const event of fresh) {
          seq += 1;
          event.tape_seq = seq;
        }
        const writer = new TapeWriter(tapePath);
        try {
          for (const event of fresh) writer.append(event);
          writer.flush();
        } finally {
          writer.close();
        }
        result.eventsAdded += insertStampedEvents(db, sessionId, fresh);
        result.capturedSessions += 1;
      }
    }
    return result;
  }

  async function runOnce(): Promise<MuseIngestResult> {
    if (running) return emptyResult();
    running = true;
    try {
      return await scan();
    } finally {
      running = false;
    }
  }

  function start(pollMs: number): void {
    if (timer) return;
    timer = setInterval(() => {
      void runOnce()
        .then((result) => {
          if (result.eventsAdded > 0) log.info({ ...result }, "ingested muse sessions");
        })
        .catch((error) => {
          log.error({ err: String(error) }, "muse ingest failed");
        });
    }, pollMs);
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop };
}
