import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  ECHO_HOOK_MARKER,
  installMuseHooks,
  MUSE_HOOK_EVENTS,
  resolveMuseSettingsPath,
} from "@echo/capture-muse";
import { loadEchoConfig, saveEchoConfig } from "@echo/config";
import type { HooksStatus, SettingsGetResponse } from "@echo/contracts";
import type { EchoDb } from "@echo/db";
import { ensureEnabledProjects } from "./enabled-projects";

type ErrorLog = { error: (obj: unknown, message?: string) => void };

type Outcome = { status: number; body: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Which hook events already carry an Echo entry. Unreadable or unparseable settings read as none installed — install refuses loudly instead of guessing. */
export function readHooksStatus(env: NodeJS.ProcessEnv = process.env): HooksStatus {
  const settingsPath = resolveMuseSettingsPath(env);
  let parsed: unknown = null;
  try {
    if (existsSync(settingsPath)) parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    parsed = null;
  }
  const hooks = isRecord(parsed) && isRecord(parsed.hooks) ? parsed.hooks : {};
  const eventsInstalled = MUSE_HOOK_EVENTS.filter((event) => {
    const current = (hooks as Record<string, unknown>)[event];
    return (
      Array.isArray(current) &&
      current.some(
        (entry) =>
          isRecord(entry) &&
          typeof entry.command === "string" &&
          entry.command.includes(ECHO_HOOK_MARKER),
      )
    );
  });
  return {
    settingsPath,
    totalEvents: MUSE_HOOK_EVENTS.length,
    eventsInstalled: [...eventsInstalled],
    installed: eventsInstalled.length === MUSE_HOOK_EVENTS.length,
  };
}

export function getSettings(env: NodeJS.ProcessEnv = process.env): Outcome {
  const body: SettingsGetResponse = {
    projects: loadEchoConfig(env).projects,
    hooks: readHooksStatus(env),
  };
  return { status: 200, body };
}

/** Run the CLI's hooks installer from the daemon: same merge, same one-time backup, same idempotency. */
export function installSettingsHooks(env: NodeJS.ProcessEnv = process.env): Outcome {
  try {
    const result = installMuseHooks({ env });
    return {
      status: 200,
      body: {
        settingsPath: result.settingsPath,
        changed: result.changed,
        backupPath: result.backupPath,
        eventsInstalled: result.eventsInstalled,
      },
    };
  } catch (error) {
    // Refusals name a user-fixable settings problem; anything else is the
    // daemon's own environment (unresolvable binary, unwritable home).
    const message = error instanceof Error ? error.message : String(error);
    const refusal =
      message.includes("refusing to write") ||
      message.includes("unparseable") ||
      message.includes("cannot read") ||
      message.includes("not an object") ||
      message.includes("not an array");
    return {
      status: refusal ? 400 : 500,
      body: { error: { code: refusal ? "invalid_request" : "install_failed", message } },
    };
  }
}

/** Mirror `echo-cli enable`: validate at the boundary, persist the allowlist, then materialize the project row. The ingest loops re-read config fresh, so capture starts without a restart. */
export async function enableSettingsProject(
  db: EchoDb,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  log?: ErrorLog,
): Promise<Outcome> {
  const root = resolve(path);
  let stat: ReturnType<typeof statSync> | null = null;
  try {
    stat = statSync(root);
  } catch {
    stat = null;
  }
  if (stat === null) {
    return {
      status: 404,
      body: {
        error: { code: "not_found", message: "no folder at that path on the daemon machine" },
      },
    };
  }
  if (!stat.isDirectory()) {
    return {
      status: 400,
      body: { error: { code: "invalid_request", message: "that path is a file, not a folder" } },
    };
  }
  const config = loadEchoConfig(env);
  if (!config.projects.includes(root)) {
    config.projects.push(root);
    saveEchoConfig(config, env);
  }
  const ids = await ensureEnabledProjects(db, [root], log);
  if (ids.length === 0) {
    log?.error({ root }, "settings enable could not identify repository");
    return {
      status: 500,
      body: {
        error: { code: "enable_failed", message: "could not identify a repository at that path" },
      },
    };
  }
  return { status: 200, body: { path: root, projectId: ids[0] } };
}

/** Mirror `echo-cli disable`: drop the path from the allowlist. History already captured stays readable. */
export function disableSettingsProject(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Outcome {
  const root = resolve(path);
  const config = loadEchoConfig(env);
  const removed = config.projects.includes(root);
  if (removed) {
    config.projects = config.projects.filter((candidate) => candidate !== root);
    saveEchoConfig(config, env);
  }
  return { status: 200, body: { path: root, removed } };
}

/** Bounds for the native-picker name search: deep enough for ~/a/b/c/repo, capped so a huge home never stalls the menu. */
const RESOLVE_MAX_DEPTH = 4;
const RESOLVE_MAX_VISITED = 3000;
const RESOLVE_MAX_MATCHES = 20;

/** Locate a picker-chosen folder name under the daemon user's home. Exact segment match only; dotfiles and node_modules are never descended. Zero or many matches is a normal answer — the menu says so or lists them. */
export function resolveSettingsFolder(name: string, startDir: string = homedir()): Outcome {
  const clean = name.trim();
  if (
    clean.length === 0 ||
    clean === "." ||
    clean === ".." ||
    clean.includes("/") ||
    clean.includes("\\")
  ) {
    return {
      status: 400,
      body: { error: { code: "invalid_request", message: "pick a single folder name" } },
    };
  }
  const matches: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: startDir, depth: 0 }];
  let visited = 0;
  while (
    stack.length > 0 &&
    matches.length < RESOLVE_MAX_MATCHES &&
    visited < RESOLVE_MAX_VISITED
  ) {
    const next = stack.pop();
    if (next === undefined) break;
    visited += 1;
    let entries: Array<{ name: string; isDir: boolean }>;
    try {
      entries = readdirSync(next.dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDir: entry.isDirectory(),
      }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDir || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.name === clean) {
        matches.push(join(next.dir, entry.name));
        if (matches.length >= RESOLVE_MAX_MATCHES) break;
      } else if (next.depth < RESOLVE_MAX_DEPTH) {
        stack.push({ dir: join(next.dir, entry.name), depth: next.depth + 1 });
      }
    }
  }
  matches.sort();
  return {
    status: 200,
    body: { name: clean, matches, truncated: stack.length > 0 },
  };
}
