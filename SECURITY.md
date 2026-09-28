# Security policy

This repository holds the GitStudio desktop app, the GitStudio extension for
VS Code and Cursor, the Merge Studio extension, the MCP server, and the
packages they share. This policy covers all of them.

## Reporting a vulnerability

**Please don't report a security problem in a public issue, discussion or pull
request.**

Report it privately through GitHub instead: open this repository's
[**Security** tab](https://github.com/GitStudioHQ/gitstudio/security) and click
**Report a vulnerability**
([direct link](https://github.com/GitStudioHQ/gitstudio/security/advisories/new)).
Only you and the maintainers can see the report and what follows.

It helps to include, as far as you can:

- what the problem is, and what an attacker could do with it;
- the product and its version (the desktop app, the GitStudio extension, Merge
  Studio or the MCP server), your operating system, and your editor if it is
  an extension;
- how to reproduce it: a small repository, a branch or file name, a pull
  request, whatever triggers it;
- a proof of concept, screenshots or logs.

## What to expect

- We aim to acknowledge a new report within 5 business days.
- After triage we keep you updated on the fix, and agree with you when the
  problem becomes public.
- The fix ships in a new release of the affected product.
- Valid reports are credited in the release notes, unless you'd rather stay
  anonymous.

## Supported versions

Security fixes go into the **latest release** of each product, so please update
before you report.

| Product | Supported |
| --- | --- |
| GitStudio desktop app | The latest `app-v*` release |
| GitStudio extension (VS Code Marketplace, Open VSX) | The latest version |
| Merge Studio (VS Code Marketplace, Open VSX) | The latest version |
| MCP server | The one in the latest desktop release |

## Scope

We especially want to hear about:

- code running, or markup being injected, because of what is in a repository
  (branch, tag and file names, file contents, commit messages, git
  configuration, a remote) or what comes from GitHub (a pull request's or an
  issue's title, body, comments or labels);
- anything that escapes a webview's or the desktop app's sandbox: a way past a
  content security policy, out of the page, or through the desktop app's
  bridge to its main process;
- a secret leaving your machine: an AI key, the GitHub token, or a crash report
  carrying something the scrubber should have removed (see the privacy notes
  below);
- an update, download or install that can be made to fetch or run something
  else;
- a destructive Git operation that runs without the confirmation the app
  promises.

Out of scope: problems that need a malicious extension already running in the
same editor, physical access to an unlocked computer, or social engineering;
and vulnerabilities in Git, the editor, Electron or GitHub themselves (report
those to them, and tell us if GitStudio makes one easier to reach).

## Privacy

What each product sends over the network, and how to turn each thing off:
[desktop app](apps/desktop/PRIVACY.md) ·
[GitStudio extension](apps/extension/PRIVACY.md) ·
[Merge Studio](apps/merge-studio/PRIVACY.md).
