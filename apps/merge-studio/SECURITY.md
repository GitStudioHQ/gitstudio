# Security policy

## Reporting a vulnerability

**Please don't report a security problem in a public issue, discussion or pull
request.**

Report it privately through GitHub instead: open this repository's
[**Security** tab](https://github.com/GitStudioHQ/merge-studio/security) and
click **Report a vulnerability**
([direct link](https://github.com/GitStudioHQ/merge-studio/security/advisories/new)).
Only you and the maintainers can see the report and what follows.

It helps to include, as far as you can:

- what the problem is, and what an attacker could do with it;
- the Merge Studio version, your editor and its version, and your operating
  system;
- how to reproduce it: ideally a small repository, or the branch or file names
  that trigger it;
- a proof of concept, screenshots or logs.

## What to expect

- We aim to acknowledge a new report within 5 business days.
- After triage we keep you updated on the fix, and agree with you when the
  problem becomes public.
- The fix ships in a new release of Merge Studio.
- Valid reports are credited in the release notes, unless you'd rather stay
  anonymous.

## Supported versions

Merge Studio is distributed through the VS Code Marketplace and Open VSX.
Security fixes go into the **latest version**, so please update before you
report.

## Scope

Merge Studio runs git on your computer and shows merges and diffs in your
editor's webviews. We especially want to hear about:

- code running, or markup being injected into a webview, because of what is in
  a repository: branch names, file paths, file contents, commit metadata;
- anything that escapes a webview's sandbox or the extension's expected
  permissions;
- mishandling of files or git state that loses work or runs a command you
  didn't ask for.

Out of scope: problems that need a malicious extension already running in the
same editor, physical access to an unlocked computer, or social engineering;
and vulnerabilities in Git, the editor or its webviews themselves (report
those to them, and tell us if Merge Studio makes one easier to reach).

Merge Studio's merge code is shared with [GitStudio](https://github.com/GitStudioHQ/gitstudio),
and a fix lands in both. If a vulnerable dependency it bundles (notably the
Monaco editor) is reachable through Merge Studio, report it the same way.

What Merge Studio sends over the network: nothing. See [PRIVACY.md](PRIVACY.md).
