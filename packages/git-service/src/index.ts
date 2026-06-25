// @gitstudio/git-service — host-agnostic Git data layer.
//
// Filled in at M1: GitProcess (bounded spawned-git-CLI pool with AbortSignal
// cancellation + NUL-framed streaming parse), GitContext, RepoWatcher, and the
// LogProvider / BlameProvider / ObjectProvider / RefProvider streaming readers.
//
// This package must never import `vscode` — the few host-git touchpoints
// (repo discovery, index/stage reads) go through a HostGitAdapter injected by
// the shell (the VS Code extension or the desktop app), so the same data layer
// powers both front-ends.
export {};
