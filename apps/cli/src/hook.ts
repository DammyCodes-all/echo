import { readStdinCapped, runMuseHook } from "@echo/capture-muse";
import { loadEchoConfig, resolveEchoPaths } from "@echo/config";

export interface HookRunInput {
  agent: string;
  event: string;
  rawStdin?: string;
  stdinTruncated?: boolean;
  stdinFd?: number;
  dataDir?: string;
  projects?: string[];
  receivedAt?: string;
}

export interface HookRunResult {
  exitCode: number;
  spooled: boolean;
  path: string | null;
  pruned: number;
}

// Total function: translation, redaction and spooling never throw outward,
// and every path returns exit 0. A hook helper must never block the agent,
// so failures become dropped spool entries, never exceptions or output.
export function runHookCommand(input: HookRunInput): HookRunResult {
  const done = (partial: Omit<HookRunResult, "exitCode">): HookRunResult => ({
    exitCode: 0,
    ...partial,
  });
  try {
    if (input.agent !== "muse") return done({ spooled: false, path: null, pruned: 0 });
    const dataDir = input.dataDir ?? resolveEchoPaths().dataDir;
    const projects = input.projects ?? loadEchoConfig().projects;
    let raw = input.rawStdin;
    let truncated = input.stdinTruncated ?? false;
    if (raw === undefined) {
      const read = readStdinCapped(input.stdinFd ?? 0);
      raw = read.raw;
      truncated = truncated || read.truncated;
    }
    const { path, pruned } = runMuseHook({
      dataDir,
      event: input.event,
      rawStdin: raw,
      stdinTruncated: truncated,
      projects,
      receivedAt: input.receivedAt,
    });
    return done({ spooled: true, path, pruned });
  } catch {
    return done({ spooled: false, path: null, pruned: 0 });
  }
}
