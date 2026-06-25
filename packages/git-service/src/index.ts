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
} from "./GitProcess";
export { LogProvider } from "./LogProvider";
export type { StreamCommitsOptions } from "./LogProvider";
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
export { GitContext } from "./GitContext";
export type { GitContextOptions } from "./GitContext";
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
