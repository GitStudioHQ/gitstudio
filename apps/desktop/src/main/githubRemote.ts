// The `origin` remote parser — pure, dependency-free, and deliberately in its
// OWN module: githubBridge imports electron, and the local-repo scanner (plus
// its node tests) must not drag that in just to read a remote URL.
//
// ONE parser for both products: the extension's Pull Requests view and this
// app ask the same question of the same URLs, and two regexes had drifted —
// this one knew SSH host aliases, the extension's did not; neither knew
// ssh.github.com (SSH over 443) or www.github.com. The engine's answers all of
// them (packages/engine/src/forge/parseRemote.ts, tested there and in
// test/parseGitHubRemote.test.ts):
//   https://github.com/o/r(.git)(/)      — plus http, www.github.com
//   git@github.com:o/r.git               — scp-like
//   git@github.com-work:o/r.git          — SSH host ALIASES (multi-account)
//   ssh://git@github.com:22/o/r.git      — ssh with a port (the old regex
//                                           parsed owner="22" and 404'd forever)
//   ssh://git@ssh.github.com:443/o/r.git — SSH over port 443
//   git://github.com/o/r
// Host-anchored: "evilnotgithub.com" never matches.
//
// And a `Host` alias of ~/.ssh/config whose HostName is github.com
// (`git@work:o/r.git`): the app's readers of a remote ask through
// `githubRepoOfRemote`, which reads the config — the same helper the
// extension uses (packages/git-service/src/sshAliases.ts). Only the extension
// resolved aliases, so one clone was a GitHub repository there and not here.
export { parseGitHubRemote } from "@gitstudio/engine/forge/parseRemote";
export { githubRepoOfRemote } from "@gitstudio/git-service/sshAliases";
