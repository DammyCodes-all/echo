import { createHash } from "node:crypto";
import { resolve } from "node:path";

// Canonical Echo project identity: prj_ + first 16 hex chars of the sha256
// of the remote URL when present, else the canonical repository root. Both
// capture adapters share this so session rows join across agents for the
// same repo. Hash identical inputs identically; different unresolved inputs
// (e.g. a subdirectory cwd vs the repo root) intentionally yield different
// ids until callers resolve them to the same repository identity.

export interface RepositoryIdentityInput {
  /** Any directory inside the repository (or the repository root itself). */
  directory: string;
  /** Canonical repository root when the caller already resolved it. */
  canonicalRoot?: string | null;
  /** Registered origin remote when known; raw values are normalized. */
  remoteUrl?: string | null;
}

export interface RepositoryIdentity {
  canonicalRoot: string;
  remoteUrl: string | null;
  projectId: string;
}

function stripGitSuffix(path: string): string {
  return path.endsWith(".git") ? path.slice(0, -".git".length) : path;
}

function normalizePathRemote(value: string): string {
  return stripGitSuffix(value.replace(/\/+$/, ""));
}

/**
 * Normalize a registered Git remote for identity, not display. Equivalent
 * HTTPS/SSH remote forms collapse to the same host/path value; credentials,
 * default ports, trailing slashes and `.git` suffixes do not split projects.
 * Local paths are preserved after the same suffix cleanup.
 */
export function normalizeGitRemoteUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  // A Windows drive path is a local path, not SCP-like `host:path` syntax.
  if (/^[A-Za-z]:[\\/]/.test(value)) return normalizePathRemote(value);

  const scp = /^(?:([^@/:\s]+)@)?([^/:\s]+):(.*)$/.exec(value);
  if (scp !== null && !value.includes("://")) {
    const host = (scp[2] ?? "").toLowerCase();
    const path = stripGitSuffix((scp[3] ?? "").replace(/^\/+|\/+$/g, ""));
    if (host.length === 0 || path.length === 0) return null;
    return `${host}/${path}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return normalizePathRemote(value);
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol === "file:") return normalizePathRemote(parsed.pathname);
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "ssh:") {
    return normalizePathRemote(value);
  }
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port;
  const defaultPort =
    (protocol === "http:" && port === "80") ||
    (protocol === "https:" && port === "443") ||
    (protocol === "ssh:" && port === "22");
  const path = stripGitSuffix(parsed.pathname.replace(/\/+$/, "").replace(/^\/+/, ""));
  if (host.length === 0 || path.length === 0) return null;
  return defaultPort || port.length === 0 ? `${host}/${path}` : `${host}:${port}/${path}`;
}

export function projectIdForRepository(input: {
  canonicalRoot: string;
  remoteUrl?: string | null;
}): string {
  const canonicalRoot = resolve(input.canonicalRoot);
  const remoteUrl = normalizeGitRemoteUrl(input.remoteUrl ?? null);
  return `prj_${createHash("sha256")
    .update(remoteUrl ?? canonicalRoot)
    .digest("hex")
    .slice(0, 16)}`;
}

export function repositoryIdentityFor(input: RepositoryIdentityInput): RepositoryIdentity {
  const canonicalRoot = resolve(input.canonicalRoot ?? input.directory);
  const remoteUrl = normalizeGitRemoteUrl(input.remoteUrl ?? null);
  return {
    canonicalRoot,
    remoteUrl,
    projectId: projectIdForRepository({ canonicalRoot, remoteUrl }),
  };
}

export function projectIdForDirectory(directory: string): string {
  return projectIdForRepository({ canonicalRoot: directory, remoteUrl: null });
}
