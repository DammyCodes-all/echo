export type { RepositoryIdentity } from "@echo/core";
export {
  diffShadowCommits,
  diffShadowTrees,
  findRepositoryRoot,
  readShadowBlob,
  resolveRepositoryIdentity,
} from "./git";
export {
  type WalkFile,
  type WalkMetadata,
  type WalkOptions,
  type WalkResult,
  walkWorkingTree,
} from "./ignore";
export { loadManifest, type ManifestEntry, type SnapshotManifest } from "./manifest";
export {
  DEFAULT_SNAPSHOT_LIMITS,
  type GitTreeSnapshotOptions,
  type SnapshotBaseOptions,
  type SnapshotFile,
  type SnapshotLimits,
  type SnapshotResult,
  type SnapshotTrigger,
  snapshotGitTree,
  snapshotWorkingTree,
  type WorkingTreeSnapshotOptions,
} from "./snapshot";
