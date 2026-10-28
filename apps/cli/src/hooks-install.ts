import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { MUSE_HOOK_EVENTS } from "@echo/capture-muse";

export const ECHO_HOOK_MARKER = "hook muse";

export interface HookEntry {
  type: string;
  command: string;
  timeout: number;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function resolveMuseSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ECHO_MUSE_SETTINGS_PATH;
  if (typeof override === "string" && override.length > 0) return override;
  return join(homedir(), ".muse", "settings.json");
}

export function resolveEchoCliBin(
  env: NodeJS.ProcessEnv = process.env,
  argvEntry: string | undefined = process.argv[1],
): string {
  const override = env.ECHO_CLI_BIN;
  if (typeof override === "string" && override.length > 0) return resolve(override);
  if (typeof argvEntry === "string" && argvEntry.length > 0) return resolve(argvEntry);
  throw new Error("cannot resolve the absolute echo-cli binary path");
}

export function museHookEntry(cliBin: string, event: string): HookEntry {
  return { type: "command", command: `"${cliBin}" hook muse ${event}`, timeout: 5 };
}

function isSameEntry(entry: unknown, wanted: HookEntry): boolean {
  if (!isRecord(entry)) return false;
  return (
    entry.type === wanted.type &&
    entry.command === wanted.command &&
    entry.timeout === wanted.timeout
  );
}

function isStaleEchoEntry(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  return typeof entry.command === "string" && entry.command.includes(ECHO_HOOK_MARKER);
}

export interface InstallMuseHooksInput {
  settingsPath?: string;
  cliBin?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface InstallMuseHooksResult {
  settingsPath: string;
  cliBin: string;
  changed: boolean;
  backupPath: string | null;
  eventsInstalled: string[];
}

function backupStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function existingBackup(settingsPath: string): string | null {
  const dir = dirname(settingsPath);
  const base = basename(settingsPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const found = names
    .filter((name) => name.startsWith(`${base}.echo-backup-`) && name.endsWith(".json"))
    .sort();
  return found.length > 0 ? join(dir, found[0] as string) : null;
}

// Merge Echo command hooks into the user's Muse settings. Existing handler
// entries are preserved in order; only stale Echo entries (a previous binary
// path carrying the Echo marker) are replaced. Idempotent: a re-run with no
// user edits is byte-identical.
export function installMuseHooks(input: InstallMuseHooksInput = {}): InstallMuseHooksResult {
  const env = input.env ?? process.env;
  const settingsPath = input.settingsPath ?? resolveMuseSettingsPath(env);
  const cliBin = input.cliBin ?? resolveEchoCliBin(env);
  const now = input.now ?? new Date();

  let parsed: unknown = {};
  let fileExisted = false;
  if (existsSync(settingsPath)) {
    fileExisted = true;
    let raw: string;
    try {
      raw = readFileSync(settingsPath, "utf8");
    } catch (error) {
      throw new Error(`cannot read Muse settings at ${settingsPath}: ${String(error)}`);
    }
    try {
      parsed = raw.trim().length === 0 ? {} : JSON.parse(raw);
    } catch {
      throw new Error(`refusing to write ${settingsPath}: unparseable JSON`);
    }
  }
  if (!isRecord(parsed)) {
    throw new Error(`refusing to write ${settingsPath}: settings root is not an object`);
  }
  const settings: Record<string, unknown> = { ...parsed };
  const hooksValue = settings.hooks;
  if (hooksValue !== undefined && (!isRecord(hooksValue) || Array.isArray(hooksValue))) {
    throw new Error(`refusing to write ${settingsPath}: "hooks" is not an object`);
  }
  const hooks: Record<string, unknown> = { ...(hooksValue as Record<string, unknown> | undefined) };

  let changed = false;
  for (const event of MUSE_HOOK_EVENTS) {
    const wanted = museHookEntry(cliBin, event);
    const current = hooks[event];
    if (current === undefined) {
      hooks[event] = [wanted];
      changed = true;
      continue;
    }
    if (!Array.isArray(current)) {
      throw new Error(`refusing to write ${settingsPath}: hooks.${event} is not an array`);
    }
    if (current.some((entry) => isSameEntry(entry, wanted))) {
      continue;
    }
    // Same binary path but hand-tuned fields (timeout, extra handler keys):
    // the entry is ours and the tuning wins, so leave it untouched.
    if (
      current.some(
        (entry) =>
          isRecord(entry) && typeof entry.command === "string" && entry.command === wanted.command,
      )
    ) {
      continue;
    }
    const stale = current.filter(isStaleEchoEntry);
    // Carry extra handler keys (e.g. commandWindows) from the replaced stale
    // entries onto the fresh one; type/command/timeout always come from wanted.
    const extras: Record<string, unknown> = {};
    for (const entry of stale) {
      if (!isRecord(entry)) continue;
      for (const [key, value] of Object.entries(entry)) {
        if (!(key in wanted)) extras[key] = value;
      }
    }
    const kept = current.filter((entry) => !isStaleEchoEntry(entry));
    hooks[event] = [...kept, { ...extras, ...wanted }];
    changed = true;
  }

  if (!changed) {
    return {
      settingsPath,
      cliBin,
      changed: false,
      backupPath: null,
      eventsInstalled: [...MUSE_HOOK_EVENTS],
    };
  }

  let backupPath: string | null = null;
  if (fileExisted) {
    const prior = existingBackup(settingsPath);
    if (prior) {
      backupPath = prior;
    } else {
      backupPath = `${settingsPath}.echo-backup-${backupStamp(now)}.json`;
      writeFileSync(backupPath, readFileSync(settingsPath, "utf8"));
      chmodSync(backupPath, 0o600);
    }
  }

  settings.hooks = hooks;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  // The user's settings file keeps its own permissions; only the Echo backup
  // we create is locked down to 0600.
  return {
    settingsPath,
    cliBin,
    changed: true,
    backupPath,
    eventsInstalled: [...MUSE_HOOK_EVENTS],
  };
}
