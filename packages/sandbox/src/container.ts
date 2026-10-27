import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { spawnGuarded, stageBundle } from "./harness";
import { type BackendInfo, type RunRequest, type RunResult, resolveLimits } from "./types";

export const CONTAINER_IMAGE = "node:20-slim";

function succeeded(cmd: string, args: string[], timeoutMs: number): boolean {
  try {
    return spawnSync(cmd, args, { timeout: timeoutMs, stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function firstLine(output: Buffer | string | null | undefined): string {
  if (output === null || output === undefined) return "";
  return output.toString("utf8").trim().split("\n")[0] ?? "";
}

export function probeContainer(): BackendInfo {
  if (!succeeded("docker", ["--version"], 5000)) {
    return {
      name: "docker",
      available: false,
      reason: "docker CLI not found",
      version: null,
      image: null,
    };
  }
  const version = spawnSync("docker", ["--version"], { timeout: 5000 });
  if (!succeeded("docker", ["info"], 8000)) {
    return {
      name: "docker",
      available: false,
      reason: "docker daemon unreachable",
      version: firstLine(version.stdout),
      image: null,
    };
  }
  const inspect = spawnSync(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", CONTAINER_IMAGE],
    { timeout: 8000 },
  );
  if (inspect.status !== 0) {
    return {
      name: "docker",
      available: false,
      reason: `image ${CONTAINER_IMAGE} not present locally (spike pulls nothing)`,
      version: firstLine(version.stdout),
      image: null,
    };
  }
  return {
    name: "docker",
    available: true,
    reason: null,
    version: firstLine(version.stdout),
    image: `${CONTAINER_IMAGE} (${firstLine(inspect.stdout)})`,
  };
}

export async function runContainer(request: RunRequest): Promise<RunResult> {
  const limits = resolveLimits(request.limits);
  const bundle = stageBundle(request.code);
  const name = `echo-sandbox-${randomUUID().slice(0, 8)}`;
  const removeContainer = (): void => {
    try {
      spawnSync("docker", ["rm", "-f", name], { timeout: 10_000, stdio: "ignore" });
    } catch {
      // Best effort; a stopped container is reaped by --rm.
    }
  };
  try {
    const memory = `${limits.memoryMb}m`;
    const guarded = await spawnGuarded(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",
        "--memory",
        memory,
        "--memory-swap",
        memory,
        "--cpus",
        "0.5",
        "--pids-limit",
        "64",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "65534:65534",
        "--env",
        "TZ=UTC",
        "--env",
        "LANG=C",
        "--env",
        "HOME=/tmp",
        "-v",
        `${bundle.dir}:/work:ro`,
        "-w",
        "/work",
        CONTAINER_IMAGE,
        "node",
        "/work/main.mjs",
      ],
      {
        timeoutMs: limits.timeoutMs,
        maxOutputBytes: limits.maxOutputBytes,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        onTimeout: removeContainer,
      },
    );
    if (guarded.spawnError !== null) {
      return {
        backend: "docker",
        image: CONTAINER_IMAGE,
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
        backend: "docker",
        image: CONTAINER_IMAGE,
        status: "timeout",
        exitCode: guarded.exitCode,
        stdout: guarded.stdout,
        stderr: guarded.stderr,
        truncated: guarded.truncated,
        timedOut: true,
        durationMs: guarded.durationMs,
        reason: `exceeded ${limits.timeoutMs} ms; container killed`,
      };
    }
    return {
      backend: "docker",
      image: CONTAINER_IMAGE,
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
    removeContainer();
    bundle.cleanup();
  }
}
