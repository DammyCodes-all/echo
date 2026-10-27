import { spawnSync } from "node:child_process";
import { spawnGuarded, stageBundle } from "./harness";
import { type BackendInfo, type RunRequest, type RunResult, resolveLimits } from "./types";

function available(cmd: string, args: string[], timeoutMs: number): boolean {
  try {
    return spawnSync(cmd, args, { timeout: timeoutMs, stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export function probeBwrap(): BackendInfo {
  if (!available("bwrap", ["--version"], 5000)) {
    return {
      name: "bwrap",
      available: false,
      reason: "bwrap not found",
      version: null,
      image: null,
    };
  }
  // User + network namespaces are the isolation that matters. /bin/true keeps
  // the probe free of any interpreter dependency.
  const probe = available(
    "bwrap",
    [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-uts",
      "--unshare-net",
      "--unshare-ipc",
      "--unshare-cgroup",
      "--die-with-parent",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--ro-bind",
      "/etc",
      "/etc",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "/usr/bin/true",
    ],
    8000,
  );
  if (!probe) {
    return {
      name: "bwrap",
      available: false,
      reason: "bwrap cannot create user/network namespaces on this kernel",
      version: "present",
      image: null,
    };
  }
  return { name: "bwrap", available: true, reason: null, version: "present", image: null };
}

export async function runBwrap(request: RunRequest): Promise<RunResult> {
  const limits = resolveLimits(request.limits);
  const bundle = stageBundle(request.code);
  try {
    const nodePath = process.execPath;
    const guarded = await spawnGuarded(
      "bwrap",
      [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-uts",
        "--unshare-net",
        "--unshare-ipc",
        "--unshare-cgroup",
        "--die-with-parent",
        "--tmpfs",
        "/",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind",
        "/lib64",
        "/lib64",
        "--ro-bind",
        "/etc",
        "/etc",
        "--tmpfs",
        "/tmp",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--ro-bind",
        bundle.dir,
        "/tmp/work",
        "--remount-ro",
        "/",
        "--chdir",
        "/tmp/work",
        "--setenv",
        "HOME",
        "/tmp",
        "--setenv",
        "PATH",
        "/usr/bin:/bin",
        "--setenv",
        "TZ",
        "UTC",
        "--setenv",
        "LANG",
        "C",
        "--setenv",
        "NODE_OPTIONS",
        "",
        nodePath,
        "/tmp/work/main.mjs",
      ],
      {
        timeoutMs: limits.timeoutMs,
        maxOutputBytes: limits.maxOutputBytes,
        env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
      },
    );
    if (guarded.spawnError !== null) {
      return {
        backend: "bwrap",
        image: null,
        status: "error",
        exitCode: null,
        stdout: "",
        stderr: guarded.spawnError,
        truncated: false,
        timedOut: false,
        durationMs: guarded.durationMs,
        reason: guarded.spawnError,
      };
    }
    if (guarded.timedOut) {
      return {
        backend: "bwrap",
        image: null,
        status: "timeout",
        exitCode: guarded.exitCode,
        stdout: guarded.stdout,
        stderr: guarded.stderr,
        truncated: guarded.truncated,
        timedOut: true,
        durationMs: guarded.durationMs,
        reason: `exceeded ${limits.timeoutMs} ms; process group killed`,
      };
    }
    return {
      backend: "bwrap",
      image: null,
      status: guarded.exitCode === 0 ? "ok" : "error",
      exitCode: guarded.exitCode,
      stdout: guarded.stdout,
      stderr: guarded.stderr,
      truncated: guarded.truncated,
      timedOut: false,
      durationMs: guarded.durationMs,
      reason: guarded.exitCode === 0 ? null : `node exited ${guarded.exitCode ?? "unknown"}`,
    };
  } finally {
    bundle.cleanup();
  }
}
