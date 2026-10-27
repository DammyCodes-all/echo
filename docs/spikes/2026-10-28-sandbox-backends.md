# Spike: sandbox backends self-test (container → bwrap → WASM)

Date: 2026-10-28. Related Phase-0 item: "self-test the sandbox backends
(container, bwrap if available, WASM)" (BUILD-PLAN §3, ARCHITECTURE §15).

**Result: PASS (docker, bwrap). WASM unavailable — no engine installed.**

## Environment

- Linux, Node v24 host. Docker 29.9.2 with local image `node:20-slim`
  (no pull performed). bwrap 0.12.0 with user/network namespaces.
- Implementation: `packages/sandbox/` — `runSandbox` ladder
  (docker → bwrap → unavailable, never in-process), per-backend runners,
  memoized `detectBackends()` with `refreshBackends()`, colocated
  `sandbox.test.ts` (20 tests: hello, determinism ×2, read-only FS,
  blocked network, timeout kill, 64 KiB output cap, 128 MiB memory cap
  on docker, ladder order, wasm-stub, memoization).

## What the tests prove on this machine

| Check | docker | bwrap |
| --- | --- | --- |
| Hello + exit 0 | pass | pass |
| Two runs, identical stdout | pass | pass |
| Root + bundle dir read-only | pass | pass |
| No network (fetch fails closed) | pass | pass |
| Infinite loop killed on timeout | pass | pass |
| 220 KiB output capped at 64 KiB | pass | pass |
| 512 MiB alloc under 128 MiB cap | OOM-killed (137) | n/a (no unprivileged cap) |

Invocation matches ARCHITECTURE §15 (no net, read-only root + ro bundle,
tmpfs, non-root 65534, dropped caps, no-new-privileges, pids limit,
0.5 CPU, 128 MiB, env scrubbed, kill group on timeout, temp bundle
deleted in `finally`).

## Deltas and observations

1. **Empty-root bwrap lockdown.** Naive `--ro-bind / /` either blocks the
   work bind or exposes the host tree read-only. Final shape: `--tmpfs /`
   as the root, minimal ro-binds (`/usr /lib /lib64 /etc`), `--remount-ro /`
   *after* all mounts, then `--tmpfs /tmp`, `--proc`, `--dev`, and the
   bundle at `/tmp/work`. No host file is visible at all; only the four
   binds plus the bundle exist. Mount order is load-bearing (remount
   before `/tmp` fails; work bind before root lockdown fails).
2. **`Buffer.alloc` does not commit pages.** A 512 MiB `Buffer.alloc` loop
   survived a 128 MiB cap (rss stayed 38 MiB): zero pages are never
   charged. The memory test uses `.fill(1)` to force commit; OOM-kill
   (exit 137) then fires as expected. Any future memory assertion must
   touch pages, not just allocate.
3. **Staged bundle must be world-readable.** 0600/0700 staging fails under
   `--user 65534`; files are 0644 in a 0755 dir. Safe because snippets are
   redacted before they reach the sandbox.
4. **Detection is memoized.** Probes spawn subprocesses, so `detectBackends`
   caches per process; the daemon refreshes via `refreshBackends()`
   (startup, doctor). Per-run isolation stays fresh — reusing a container
   across snippets would leak state, so the saving is in probing, not runs.
5. **WASM is honestly unavailable.** No QuickJS engine in the tree; `runWasm`
   returns `unavailable` with an install hint. Wiring the engine needs a
   user-approved dependency install (`quickjs-emscripten` suggested).

## macOS / Windows note

`bwrap` probes fail off-Linux and the ladder skips it; missing Docker
yields `unavailable`, never a fake pass. macOS works via Docker Desktop
or (once wired) WASM. Windows is out of project scope (Linux + macOS per
ARCHITECTURE §1); the WASM rung would technically run there.

## Still open (Phase 5, not this spike)

esbuild bundling of TS snippets + harness, the verification gate (reference
twice, static policy, buggy baseline), grading flow, calibration, and the
`verification_json` evidence record. The runner interface here is the seam
they build on.
