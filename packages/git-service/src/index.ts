// @gitstudio/git-service — host-agnostic Git data layer.
//
// M1: GitProcess (bounded spawned-git-CLI pool with AbortSignal cancellation +
// %x1f/%x1e-framed streaming parse), GitContext, and the LogProvider /
// RefProvider streaming readers. Blame / Object providers and RepoWatcher land
// in later milestones.
//
// This package must never import `vscode` — the few host-git touchpoints (repo
// discovery, index/stage reads) go through a HostGitAdapter injected by the
// shell (the VS Code extension or the desktop app), so the same data layer
// powers both front-ends. NodeGitAdapter is the default Node implementation the
// desktop app reuses.
export { GitProcess } from "./GitProcess";
export type {
  GitProcessOptions,
  GitRunResult,
  GitRunOptions,
  GitRunWithInputOptions,
  GitRunEvent,
  GitRunHook,
} from "./GitProcess";
export { LogProvider } from "./LogProvider";
export type { StreamCommitsOptions } from "./LogProvider";
export {
  CommitDetailsProvider,
  parseNumstatZ,
  parseNameStatusZ,
  mergeCommitFiles,
} from "./CommitDetailsProvider";
export { RefProvider } from "./RefProvider";
export { BlameProvider } from "./BlameProvider";
export type { BlameFileOptions } from "./BlameProvider";
export { HistoryProvider } from "./HistoryProvider";
export type {
  FileHistoryEntry,
  LineHistoryEntry,
  FileHistoryOptions,
  LineHistoryOptions,
  FileAtRevisionOptions,
} from "./HistoryProvider";
export { ConflictProvider, parseUnmergedPaths } from "./ConflictProvider";
export type {
  ConflictVersions,
  GetConflictVersionsOptions,
  ConflictReadOptions,
} from "./ConflictProvider";
export { StagingProvider } from "./StagingProvider";
export type {
  StagingOptions,
  CommitOptions,
  CommitResult,
} from "./StagingProvider";
export { SnapshotProvider } from "./SnapshotProvider";
export type { Snapshot } from "./SnapshotProvider";
export { StashProvider } from "./StashProvider";
export type {
  StashEntry,
  StashSaveOptions,
  StashOpResult,
} from "./StashProvider";
export { WorktreeProvider, parseWorktreePorcelain } from "./WorktreeProvider";
export type {
  WorktreeEntry,
  WorktreeAddOptions,
  WorktreeRemoveOptions,
  WorktreeOpResult,
} from "./WorktreeProvider";
export { BranchOps } from "./BranchOps";
export type {
  BranchOpResult,
  CheckoutOptions,
  DeleteBranchOptions,
  MergeOptions,
} from "./BranchOps";
export { RemoteOps, parseRemoteVerbose } from "./RemoteOps";
export type {
  RemoteEntry,
  RemoteOpResult,
  RemoteFetchOptions,
} from "./RemoteOps";
export { SyncOps } from "./SyncOps";
export type {
  AheadBehind,
  SyncOpResult,
  PushOptions,
  PullOptions,
  FetchOptions,
} from "./SyncOps";
export { TagOps } from "./TagOps";
export type { TagOpResult, CreateTagOptions } from "./TagOps";
export { GitContext } from "./GitContext";
export type { GitContextOptions } from "./GitContext";
export { createGitToolHost } from "./GitToolHost";
export { NodeGitAdapter } from "./NodeGitAdapter";
export type { NodeGitAdapterOptions } from "./NodeGitAdapter";

// Re-export the shared host-agnostic git types for convenience.
export type {
  CommitRecord,
  GitRef,
  GitRefType,
  RepoHead,
  HostGitAdapter,
} from "@gitstudio/host-bridge/git";
export type {
  BlameCommit,
  BlameLine,
  BlameResult,
} from "@gitstudio/host-bridge/blame";
export { UNCOMMITTED_SHA } from "@gitstudio/host-bridge/blame";
