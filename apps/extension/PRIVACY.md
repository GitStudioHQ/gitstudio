# Privacy: the GitStudio extension

The GitStudio extension for VS Code, Cursor and other VS Code-based editors has
no account of its own, no analytics and no usage tracking. Nothing in it
reports what you do.

It does connect to the internet, for the things on this page and nothing else:
each one with when it happens, where it goes, what it sends, and how to turn it
off. If you see the extension send something this page doesn't list, that is a
bug; please report it (see [SECURITY.md](../../SECURITY.md)).

The extension never checks for updates itself: your editor updates it from the
VS Code Marketplace or Open VSX.

## At a glance

| What | Where it goes | When | Turn it off |
| --- | --- | --- | --- |
| [Crash reports](#crash-reports) | `gitstudio.dev`, then a private GitHub issue | When a GitStudio command fails, if your editor's telemetry is on | `gitstudio.errorReporting.enabled`, or `telemetry.telemetryLevel`: `off` |
| [Commit authors' pictures](#commit-authors-pictures) | `www.gravatar.com`, `avatars.githubusercontent.com` | When the graph draws a commit's author | `gitstudio.avatars.gravatar` |
| [GitHub](#github) | `api.github.com` and GitHub's sites | Only after you let GitStudio use your GitHub account | Remove GitStudio's access in the editor's Accounts menu |
| [AI](#ai) | The model you choose, or your own computer | When you use an AI command | `gitstudio.ai.provider`: `off` |
| [Git](#git) | Your repositories' remotes | When you fetch, pull, push or sync | You start these yourself |

Everything else stays on your computer. AI keys you enter are stored encrypted
in the extension's own storage folder, not in your system keychain, and never
reach a webview.

## Crash reports

**On by default, but only while your editor's telemetry is on.** When a
GitStudio command fails, GitStudio sends a short report so we can find and fix
the bug without waiting for someone to report it. At most 50 reports a
session, and the same failure only once. Failures of other extensions are not
reported, even though they run in the same process: only an error whose stack
points into GitStudio's own code is.

**It sends a report only when all three hold:**

1. Your editor says telemetry is enabled (`vscode.env.isTelemetryEnabled`).
   Setting `telemetry.telemetryLevel` to `off` turns crash reports off whatever
   GitStudio's own setting says. VSCodium ships with telemetry off.
2. `gitstudio.errorReporting.enabled` is on (the default).
3. `gitstudio.errorReporting.endpoint` is not blank. It defaults to
   `https://gitstudio.dev/api/errors`; blanking it turns sending off too, and
   you can point it at a server of your own.

**Where:** a `POST` to the endpoint: by default a small service the GitStudio
maintainers run (hosted on Vercel), which files each report as an issue,
merged with earlier reports of the same failure, in a **private** GitHub
repository only the maintainers can read. It writes the fields below into the
issue, except the install id; it doesn't write your IP address anywhere,
though like any web request the report reaches the service, and its host,
from it. Nothing is ever public.

**What a report contains**, and nothing else:

- `event`: `error` or `git-error`;
- `installId`: a random 32-character id made the first time the extension
  runs and kept in the editor's storage for it. It isn't derived from anything
  about you or your machine;
- the extension's version, the editor's version and name (for example
  `Visual Studio Code` or `Cursor`), and your operating system, processor
  architecture and OS kernel version (for example `darwin`, `arm64`,
  `24.6.0`);
- for an error: where it happened, in the extension's own words, the error's
  type, and its message and stack trace, scrubbed and cut to 300 and 1,600
  characters;
- for a failed git command: GitStudio's own title for it (for example
  `git reset failed`) and git's error output, scrubbed and cut to 600
  characters.

**Scrubbed** means that before anything leaves your computer, the shared
scrubber (`packages/host-bridge/src/scrub.ts`, the same code the desktop app
uses) removes: your home directory; absolute paths, including the file and
folder names in them (a stack trace keeps its line and column); the
organisation, repository, query and any credentials in a URL, and the path of
an SSH remote (the host name is kept, for example `github.com` or a
self-hosted server's name); email addresses; IP addresses; access tokens, API
keys, JWTs and private keys; a quoted name with a slash in it, such as a
repository's `owner/name` in an error message; and full commit SHAs, which
are cut to 7 characters. From a failed git command's output it also removes
branch and ref names (every one git quotes, and the ones it prints bare in
the failures reported most, such as a push with no upstream), file lists,
repository-relative paths, file names, and the commit subject git prints when
a rebase, cherry-pick, revert or `git am` stops.

The scrubber works by recognising patterns, and it is tested on each of the
cases above. It can still miss a name that looks like ordinary words: a file
name with spaces in it that git doesn't quote, a branch name in a git message
the scrubber doesn't know, or a name inside an error's message, which gets the
first of the two lists above but not the second. If that is a risk you don't
want to take, turn crash reports off.

**Past mistakes.** Reports have carried more than this page says they may:

- before 1.5.1, other extensions' failures were reported as GitStudio's.
  Three reports came from other extensions this way, and one of them carried a
  slice of an unrelated project's source code and file paths; that report was
  purged. The [1.5.1 release notes](../../docs/releases/ext-v1.5.1.md) tell
  the whole story;
- before 1.13.0, on Windows and in any path with a space in it, the end of an
  absolute path (a project's folder and file names) got through;
- before 1.14.0, so did a repository's `owner/name` when an error message
  quoted it, as GitHub's does when it can't find a repository;
- in 1.16.0 and earlier, a commit's subject when a rebase, cherry-pick, revert
  or `git am` stopped, and a branch name git prints without quotes. The
  release after 1.16.0 takes both out.

**Turn it off:** set `gitstudio.errorReporting.enabled` to `false`, or set
`telemetry.telemetryLevel` to `off` in your editor.

## Commit authors' pictures

**When:** whenever the Commit Graph, the Commits view or a commit's details
draw a commit's author, including the card that opens when you point at an
author.

**Where and what:** for each author, GitStudio asks Gravatar (run by
Automattic) for a picture, with an MD5 hash of the author's email address in
the address: `https://www.gravatar.com/avatar/<hash>`. For a GitHub noreply
address (`…@users.noreply.github.com`) it asks GitHub for that account's
picture instead, by the username in the address:
`https://avatars.githubusercontent.com/<username>`. An MD5 hash of an email
address is not anonymous: anyone who has the address can compute the same
hash.

**Turn it off:** set `gitstudio.avatars.gravatar` to `false`. It is on by
default. Off, every author is drawn as coloured initials and neither request
is made.

While you are signed in to GitHub (below), the graph also shows the pictures
GitHub returns for your repository's authors; those are GitHub requests, not
Gravatar ones.

## GitHub

**Only after you let GitStudio use your GitHub account.** GitStudio signs in
through your editor's built-in GitHub account (the Accounts menu), asking for
the `repo` permission; it never sees your password and keeps no token of its
own. Until you allow it, nothing in this section happens.

**What is requested**, all from `api.github.com`:

- the Pull Requests view: your repository's pull requests, and again about
  every two minutes while the view is visible and the editor window focused;
- a pull request's page: its details, commits, files, checks and comments,
  refreshed every 15 seconds while its checks are running and the page is in
  front; and whatever you do there (review, comment, merge, create);
- the Commit Graph: your signed-in account, and for a repository hosted on
  GitHub the authors of its latest 100 commits
  (`/repos/<owner>/<repo>/commits`), so the graph can show their GitHub
  pictures. This is asked at most every 10 minutes per repository.

Pictures of people come from `avatars.githubusercontent.com`. Images embedded
in a pull request's description or comments load from whatever host each image
names, as they would in a browser.

**Turn it off:** in your editor's Accounts menu, remove GitStudio's access to
your GitHub account (or sign out of GitHub there).

## AI

**What the extension uses is set by `gitstudio.ai.provider`**, and it sends
nothing until you run an AI command: generate a commit message, explain or
summarize changes, review changes, or draft a pull request description.

- `auto` (the default): your editor's own language model when it has one
  (GitHub Copilot in VS Code, Cursor's models in Cursor), through the editor's
  Language Model API. Those requests go through that extension or editor,
  under your account there. Without one, Anthropic if you have set a key, then
  an OpenAI-compatible address if you have configured one; otherwise AI stays
  off.
- `copilot`: your editor's language model only.
- `anthropic`: Anthropic's API, with your key.
- `openai`: the OpenAI-compatible address in `gitstudio.ai.openai.baseUrl`
  (OpenAI, OpenRouter and others, or a model on your own computer such as
  Ollama or LM Studio, where nothing leaves your computer), with your key if
  it needs one.
- `cli`: an agent command-line tool you have installed
  (`gitstudio.ai.cliAgent`: Claude Code, Codex or Gemini CLI). GitStudio runs
  it with what the task needs; it signs in and talks to its own service by
  itself.
- `off`: no AI at all.

**What:** what the command works on. A commit message: your staged changes and
your recent commit subjects. Explain, summarize and review: the changes in
question. A pull request description: the branch's commits and changes. In
the AI panel, GitStudio also asks a provider for its list of models when you
enter its key, click **Detect models**, or pick Ollama or LM Studio.

**Your keys** are stored encrypted in the extension's storage folder and sent
only to the provider they belong to.

**Turn it off:** set `gitstudio.ai.provider` to `off`.

## Git

Git makes the network operations you start (fetch, pull, push and sync)
against your repositories' remotes, with your own git configuration and
credentials. GitStudio doesn't fetch on its own. Your editor's built-in Git
extension can (its `git.autofetch` setting); that is the editor's, not
GitStudio's.
