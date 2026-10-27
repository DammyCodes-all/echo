import { probeBwrap } from "./bwrap";
import { probeContainer } from "./container";
import type { BackendInfo } from "./types";
import { probeWasm } from "./wasm";

function probeAll(): BackendInfo[] {
  return [probeContainer(), probeBwrap(), probeWasm()];
}

// Probes spawn subprocesses (docker info, image inspect, bwrap namespace
// test), so results are memoized. Detection runs once per process; the daemon
// refreshes explicitly via refreshBackends (startup, doctor).
let cached: BackendInfo[] | null = null;

/** One entry per ladder rung, strongest first. */
export function detectBackends(): BackendInfo[] {
  if (cached === null) cached = probeAll();
  return cached;
}

export function refreshBackends(): BackendInfo[] {
  cached = probeAll();
  return cached;
}
