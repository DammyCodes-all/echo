import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ChecksV2ArtifactSchema, SessionStorySchema } from "@echo/contracts";
import { openEchoDb } from "@echo/db";
import { scanBundleFiles } from "./scan";

export class DemoBuildError extends Error {}

export type GitRunner = (args: string[], cwd?: string) => string;

export interface DemoBuildOptions {
  dataDir: string;
  sessionIds: string[];
  outDir: string;
  /** Baked web assets (apps/web/dist). Required: the demo is a UI demo. */
  webDir: string;
  allowSecrets?: string[];
  report?: (step: string) => void;
  now?: () => Date;
  git?: GitRunner;
}

export interface DemoBundleMeta {
  version: 1;
  builtAt: string;
  projectId: string;
  projectName: string;
  sessions: string[];
  tapeSha256: Record<string, string>;
}

function defaultGit(args: string[], cwd?: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error)
      .split("\n")[0]
      ?.slice(0, 200);
    throw new DemoBuildError(`git ${args.join(" ").slice(0, 80)} failed: ${detail}`);
  }
}

function assertSafeOutDir(outDir: string): void {
  const resolved = resolve(outDir);
  if (resolved === "/" || resolved === homedir()) {
    throw new DemoBuildError(`refusing to build into ${resolved}`);
  }
}

// The bundle allowlist: one project, one or two sessions, and only the rows
// and files those sessions need. Everything else is deleted or never copied.
const FULL_WIPE_TABLES = [
  "reader_checkpoints",
  "engagement_events",
  "review_transition_cache",
  "code_files",
  "code_symbols",
  "code_edges",
  "code_index_state",
  "project_artifacts",
  "project_stack_state",
  "project_architecture_versions",
] as const;

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

export function buildDemoBundle(options: DemoBuildOptions): {
  outDir: string;
  meta: DemoBundleMeta;
} {
  const report = options.report ?? (() => undefined);
  const git = options.git ?? defaultGit;
  const dataDir = resolve(options.dataDir);
  const outDir = resolve(options.outDir);
  const webDir = resolve(options.webDir);
  const sessionIds = [...new Set(options.sessionIds)];
  if (sessionIds.length < 1 || sessionIds.length > 2) {
    throw new DemoBuildError(`demo bakes one or two sessions, got ${sessionIds.length}`);
  }

  const sourceSqlite = join(dataDir, "echo.sqlite");
  if (!existsSync(sourceSqlite)) throw new DemoBuildError(`no database at ${sourceSqlite}`);

  report("validating sessions");
  const source = openEchoDb(sourceSqlite);
  let projectId: string;
  let projectName: string;
  try {
    const rows = source
      .prepare(
        `SELECT id, project_id FROM sessions WHERE id IN (${placeholders(sessionIds.length)})`,
      )
      .all(...sessionIds) as Array<{ id: string; project_id: string }>;
    const found = new Set(rows.map((row) => row.id));
    const missing = sessionIds.filter((id) => !found.has(id));
    if (missing.length > 0) throw new DemoBuildError(`unknown sessions: ${missing.join(", ")}`);
    const projects = new Set(rows.map((row) => row.project_id));
    if (projects.size !== 1) throw new DemoBuildError("demo sessions must share one project");
    projectId = rows[0]?.project_id ?? "";
    const project = source.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as
      | { name: string | null }
      | undefined;
    if (!project) throw new DemoBuildError(`unknown project ${projectId}`);
    projectName = project.name ?? projectId;
  } finally {
    source.close();
  }

  report("checking bake-readiness");
  for (const sessionId of sessionIds) {
    const storyPath = join(dataDir, "projects", projectId, "sessions", sessionId, "story.json");
    const checksPath = join(
      dataDir,
      "projects",
      projectId,
      "sessions",
      sessionId,
      "artifacts",
      "checks_v2.json",
    );
    const tapePath = join(dataDir, "projects", projectId, "sessions", sessionId, "tape.jsonl");
    if (!existsSync(storyPath)) throw new DemoBuildError(`session ${sessionId} has no story.json`);
    if (!existsSync(tapePath)) throw new DemoBuildError(`session ${sessionId} has no tape.jsonl`);
    if (!existsSync(checksPath)) {
      throw new DemoBuildError(`session ${sessionId} has no pre-generated checks_v2.json`);
    }
    const story = SessionStorySchema.safeParse(JSON.parse(readFileSync(storyPath, "utf8")));
    if (!story.success) throw new DemoBuildError(`session ${sessionId} story.json failed schema`);
    const checks = ChecksV2ArtifactSchema.safeParse(JSON.parse(readFileSync(checksPath, "utf8")));
    if (!checks.success || checks.data.questions.length === 0) {
      throw new DemoBuildError(`session ${sessionId} checks_v2.json has no baked questions`);
    }
  }
  const shadowGit = join(dataDir, "projects", projectId, "shadow.git");
  if (!existsSync(shadowGit)) throw new DemoBuildError(`project ${projectId} has no shadow.git`);
  for (const sessionId of sessionIds) {
    try {
      git(["--git-dir", shadowGit, "rev-parse", "--verify", `refs/echo/sessions/${sessionId}`]);
    } catch {
      throw new DemoBuildError(`session ${sessionId} has no shadow ref`);
    }
  }
  if (!existsSync(join(webDir, "index.html"))) {
    throw new DemoBuildError(`web assets missing index.html: ${webDir}`);
  }

  report("preparing output");
  assertSafeOutDir(outDir);
  rmSync(outDir, { recursive: true, force: true });
  const outData = join(outDir, "data");
  mkdirSync(outData, { recursive: true });

  report("copying database");
  const copy = openEchoDb(sourceSqlite);
  try {
    copy.exec(`VACUUM INTO '${join(outData, "echo.sqlite").replace(/'/g, "''")}'`);
  } finally {
    copy.close();
  }
  const baked = openEchoDb(join(outData, "echo.sqlite"));
  try {
    const inSessions = placeholders(sessionIds.length);
    baked.exec("BEGIN");
    try {
      baked
        .prepare(
          `DELETE FROM snapshot_files WHERE snapshot_id NOT IN (SELECT id FROM snapshots WHERE session_id IN (${inSessions}))`,
        )
        .run(...sessionIds);
      baked
        .prepare(`DELETE FROM snapshots WHERE session_id NOT IN (${inSessions})`)
        .run(...sessionIds);
      baked
        .prepare(`DELETE FROM events WHERE session_id NOT IN (${inSessions})`)
        .run(...sessionIds);
      baked
        .prepare(`DELETE FROM session_artifacts WHERE session_id NOT IN (${inSessions})`)
        .run(...sessionIds);
      baked
        .prepare(`DELETE FROM session_build_pins WHERE session_id NOT IN (${inSessions})`)
        .run(...sessionIds);
      baked.prepare(`DELETE FROM sessions WHERE id NOT IN (${inSessions})`).run(...sessionIds);
      baked.prepare("DELETE FROM projects WHERE id != ?").run(projectId);
      for (const table of FULL_WIPE_TABLES) baked.exec(`DELETE FROM ${table}`);
      // Builder paths never ship: the demo has no source tree, so these are
      // display-only. Scrubbed before the scan runs.
      const safeName = projectName.replace(/[^A-Za-z0-9_-]+/g, "_");
      baked
        .prepare("UPDATE projects SET canonical_root = ? WHERE id = ?")
        .run(`/demo/${safeName}`, projectId);
      baked.prepare("UPDATE sessions SET directory = ?").run(`/demo/${safeName}`);
      baked.exec("COMMIT");
    } catch (error) {
      baked.exec("ROLLBACK");
      throw error;
    }
    baked.exec("VACUUM");
    const integrity = baked.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok")
      throw new DemoBuildError("baked database failed integrity_check");
  } finally {
    baked.close();
  }

  report("copying session files");
  const tapeSha256: Record<string, string> = {};
  for (const sessionId of sessionIds) {
    const src = join(dataDir, "projects", projectId, "sessions", sessionId);
    const dest = join(outData, "projects", projectId, "sessions", sessionId);
    mkdirSync(join(dest, "artifacts"), { recursive: true });
    for (const file of ["tape.jsonl", "story.json"]) {
      cpSync(join(src, file), join(dest, file));
    }
    const artifacts = join(src, "artifacts");
    if (existsSync(artifacts)) {
      for (const file of readdirSync(artifacts)) {
        if (statSync(join(artifacts, file)).isFile())
          cpSync(join(artifacts, file), join(dest, "artifacts", file));
      }
    }
    const manifest = join(dataDir, "projects", projectId, "manifests", `${sessionId}.json`);
    if (existsSync(manifest)) {
      mkdirSync(join(outData, "projects", projectId, "manifests"), { recursive: true });
      cpSync(manifest, join(outData, "projects", projectId, "manifests", `${sessionId}.json`));
    }
    tapeSha256[sessionId] = createHash("sha256")
      .update(readFileSync(join(dest, "tape.jsonl")))
      .digest("hex");
  }

  report("bundling shadow git");
  const bundlePath = join(outDir, "shadow.bundle");
  git([
    "--git-dir",
    shadowGit,
    "bundle",
    "create",
    bundlePath,
    ...sessionIds.map((id) => `refs/echo/sessions/${id}`),
  ]);
  const outShadow = join(outData, "projects", projectId, "shadow.git");
  // Clone drops non-standard refs, so materialize with an explicit fetch of
  // exactly the allowlisted session refs.
  git(["init", "--quiet", "--bare", outShadow]);
  git([
    "--git-dir",
    outShadow,
    "fetch",
    "--quiet",
    bundlePath,
    ...sessionIds.map((id) => `refs/echo/sessions/${id}:refs/echo/sessions/${id}`),
  ]);
  const outRefs = git(["--git-dir", outShadow, "for-each-ref", "--format=%(refname)"]);
  for (const sessionId of sessionIds) {
    if (!outRefs.includes(`refs/echo/sessions/${sessionId}`)) {
      throw new DemoBuildError(`cloned shadow.git lost session ${sessionId}`);
    }
  }

  report("copying web assets");
  cpSync(webDir, join(outDir, "web"), { recursive: true });

  report("scanning bundle");
  const findings = scanBundleFiles(
    collectScanTexts({ outData, outShadow, git }),
    options.allowSecrets ?? [],
  );
  if (findings.length > 0) {
    const summary = findings
      .map((finding) => `${finding.file} (${finding.rule} x${finding.matches})`)
      .join("; ");
    throw new DemoBuildError(`bundle scan failed (output left for forensics): ${summary}`);
  }

  report("writing meta");
  const meta: DemoBundleMeta = {
    version: 1,
    builtAt: (options.now?.() ?? new Date()).toISOString(),
    projectId,
    projectName,
    sessions: sessionIds,
    tapeSha256,
  };
  writeFileSync(join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return { outDir, meta };
}

function walkTextFiles(root: string, labels: Array<{ label: string; file: string }>): void {
  for (const entry of readdirSync(root)) {
    const file = join(root, entry);
    const stat = statSync(file);
    if (stat.isDirectory()) {
      if (entry === "shadow.git") continue;
      walkTextFiles(file, labels);
    } else if (file.endsWith(".json") || file.endsWith(".jsonl")) {
      labels.push({ label: file, file });
    }
  }
}

function collectScanTexts(args: { outData: string; outShadow: string; git: GitRunner }): Array<{
  label: string;
  text: string;
}> {
  const { outData, outShadow, git } = args;
  const texts: Array<{ label: string; text: string }> = [];
  const files: Array<{ label: string; file: string }> = [];
  walkTextFiles(outData, files);
  for (const file of files)
    texts.push({ label: file.label, text: readFileSync(file.file, "utf8") });
  // Database text columns: titles, summaries, names, and every event payload.
  const db = openEchoDb(join(outData, "echo.sqlite"));
  try {
    const payloads = db.prepare("SELECT payload_json FROM events").all() as Array<{
      payload_json: string;
    }>;
    texts.push({
      label: "echo.sqlite:events",
      text: payloads.map((row) => row.payload_json).join("\n"),
    });
    const meta = db.prepare("SELECT title, story_summary, directory FROM sessions").all() as Array<
      Record<string, string | null>
    >;
    const projects = db.prepare("SELECT name, canonical_root FROM projects").all() as Array<
      Record<string, string | null>
    >;
    texts.push({
      label: "echo.sqlite:meta",
      text: [...meta, ...projects].map((row) => Object.values(row).join("\n")).join("\n"),
    });
  } finally {
    db.close();
  }
  // Every blob reachable in the baked shadow history, decoded lossily.
  const objects = git(["--git-dir", outShadow, "rev-list", "--objects", "--all"]);
  for (const line of objects.split("\n")) {
    const oid = line.split(" ")[0]?.trim();
    if (!oid) continue;
    const kind = git(["--git-dir", outShadow, "cat-file", "-t", oid]).trim();
    if (kind !== "blob") continue;
    const size = Number(git(["--git-dir", outShadow, "cat-file", "-s", oid]).trim());
    if (!Number.isFinite(size) || size > 1024 * 1024) {
      throw new DemoBuildError(`blob ${oid} too large to scan; narrow the session`);
    }
    texts.push({
      label: `shadow.git:${oid.slice(0, 12)}`,
      text: git(["--git-dir", outShadow, "cat-file", "-p", oid]),
    });
  }
  return texts;
}
