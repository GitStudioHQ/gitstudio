# Privacy: GitStudio Desktop

GitStudio Desktop has no account of its own, no analytics and no usage
tracking. Nothing in it reports what you do.

It does connect to the internet, for the things on this page and nothing else:
each one with when it happens, where it goes, what it sends, and how to turn it
off. If you see the app send something this page doesn't list, that is a bug;
please report it (see [SECURITY.md](../../SECURITY.md)).

## At a glance

| What | Where it goes | When | Turn it off |
| --- | --- | --- | --- |
| [Crash reports](#crash-reports) | `gitstudio.dev`, then a private GitHub issue | When something in the app fails | **Help ▸ Send Anonymous Crash Reports** |
| [Update checks](#update-checks) | `api.github.com`, `github.com` | 20 seconds after launch, then every 4 hours | No setting |
| [Commit authors' pictures](#commit-authors-pictures) | `www.gravatar.com`, `avatars.githubusercontent.com` | When the app draws a commit's author | **Settings ▸ Appearance ▸ Load author pictures from Gravatar** |
| [GitHub](#github) | GitHub's API and sites | Only while you're signed in | **Settings ▸ GitHub Account ▸ Sign out** |
| [Images in Markdown](#images-in-markdown) | Whatever host each image names | When you view Markdown that embeds one | No setting |
| [AI](#ai) | The provider you connect, or your own computer | Only after you connect one, when you use it | **Settings ▸ AI Models**: remove the connection |
| [Git](#git) | Your repositories' remotes | When you fetch, pull, push or clone | You start these yourself |

Everything else stays on your computer: your repositories, your settings,
your Assistant conversations, and your GitHub token and AI keys, which are
stored encrypted in the app's data folder, not in your system keychain. The
data folder is `~/Library/Application Support/GitStudio` on macOS,
`%APPDATA%\GitStudio` on Windows and `~/.config/GitStudio` on Linux.

## Crash reports

**On by default.** When a command fails with an error, or something in the app
throws, GitStudio sends a short report so we can find and fix the bug without
waiting for someone to report it. At most 50 reports a session, and the same
failure only once.

**Where:** a `POST` to `https://gitstudio.dev/api/errors`, a small service the
GitStudio maintainers run (hosted on Vercel). It files each report as an issue,
merged with earlier reports of the same failure, in a **private** GitHub
repository only the maintainers can read. It writes the fields below into the
issue, except the install id; it doesn't write your IP address anywhere,
though like any web request the report reaches the service, and its host, from
it. Nothing is ever public.

**What a report contains**, and nothing else:

- `event`: `error` or `git-error`;
- `installId`: a random 32-character id made on first run. It isn't derived
  from anything about you or your machine;
- the product name (`GitStudio Desktop`), the app's version and the Electron
  version, and your operating system, processor architecture and OS kernel
  version (for example `darwin`, `arm64`, `24.6.0`);
- for an error: where it happened, in the app's own words (for example
  `ipc:branch:create`), the error's type, and its message and stack trace,
  scrubbed and cut to 300 and 1,600 characters;
- for a failed git command: the app's name for the command (for example
  `Push`) and git's error output, scrubbed and cut to 600 characters.

**Scrubbed** means that before anything leaves your computer, the shared
scrubber (`packages/host-bridge/src/scrub.ts`, the same code the GitStudio
extension uses) removes: your home directory; absolute paths, including the
file and folder names in them (a stack trace keeps its line and column); the
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

- before 1.1.0, git's error output was scrubbed like any other text, so a
  file name, branch name or repository-relative path in it was sent as it was;
- before 2.1.0, so did a repository's `owner/name` when an error message
  quoted it, as GitHub's does when it can't find a repository;
- in 2.3.0 and earlier, a commit's subject when a rebase, cherry-pick, revert
  or `git am` stopped, and a branch name git prints without quotes. The
  release after 2.3.0 takes both out.

**Turn it off:** **Help ▸ Send Anonymous Crash Reports** is a checkbox, and
the app remembers your choice. It is kept in `error-reporting.json` in the
app's data folder (`{ "enabled": false }` turns reports off). Deleting that
file gives you a new install id, and turns reports back on, as on a first run.

## Update checks

**When:** 20 seconds after the app starts, then every 4 hours while it is
open (15 minutes after a check that failed), and whenever you click **Check
for updates**. Nothing is downloaded until you agree to update.

**On macOS**, the app asks GitHub's public API for this project's releases:
`GET https://api.github.com/repos/GitStudioHQ/gitstudio/releases`, with no
sign-in. It sends nothing about you beyond what any web request carries (your
IP address and a generic user agent). If you agree to update, it downloads the
new `.dmg` from the release on `github.com` (served from GitHub's file
storage) into your Downloads folder.

**On Windows and Linux**, updates go through the
[electron-updater](https://www.electron.build/auto-update) library. It reads
`https://github.com/GitStudioHQ/gitstudio/releases.atom`,
`…/releases/latest` and the newest release's `latest.yml` (Windows) or
`latest-linux.yml` (Linux), and downloads the installer from that release if
you agree. Its requests also carry an `x-user-staging-id` header: a random id
the library creates and keeps in `.updaterId` in the app's data folder, which
it uses for staged rollouts. GitStudio doesn't use staged rollouts, and GitHub
is the only party that receives the id.

**Turn it off:** there is no setting for this yet. Development builds don't
check.

## Commit authors' pictures

**When:** whenever the app draws a commit's author: in the commit graph, in a
commit's details, and in the Branches view (who worked on a branch, who made
a tag).

**Where and what:** for each author, the app asks Gravatar (run by
Automattic) for a picture, with an MD5 hash of the author's email address in
the address: `https://www.gravatar.com/avatar/<hash>`. For a GitHub noreply
address (`…@users.noreply.github.com`) it asks GitHub for that account's
picture instead, by the username in the address:
`https://avatars.githubusercontent.com/<username>`. An MD5 hash of an email
address is not anonymous: anyone who has the address can compute the same
hash.

**Turn it off:** **Settings ▸ Appearance ▸ Load author pictures from
Gravatar**. It is on by default. Off, every author is drawn as coloured
initials and neither request is made.

Pictures of people on pull requests, issues and other GitHub pages come from
GitHub itself, and are covered below.

## GitHub

**Only while you are signed in.** Signed out, nothing in this section
happens.

**Signing in** (**Settings ▸ GitHub Account**) uses GitHub's device flow: the
app asks `github.com/login/device/code` for a code, sending GitStudio's OAuth
app id and the permissions it asks for (`repo`, `workflow`, `read:org`,
`gist`, `notifications`, `project`), then asks `github.com/login/oauth/access_token`
for the token while you approve it in your browser.

**Your token** is stored encrypted in the app's data folder and is sent only
to GitHub: to `api.github.com`, to `uploads.github.com` when you upload a
release asset, and to `github.com/user-attachments/…`, so that images attached
to a private repository's issues can load. GitStudio does not give it to git;
git uses your own credentials.

**What is requested** is what you open: pull requests, issues, notifications,
Actions, releases, projects, organizations, gists, search, and your
repositories on GitHub. What's on screen is refreshed while you're looking at
it (a running workflow every few seconds, for example), and the notification
count is refreshed as you use the app. Pictures come from
`avatars.githubusercontent.com` and `github.com/<user>.png`, images in a
repository you browse from `raw.githubusercontent.com`, and a workflow log or
artifact you download from GitHub's file storage, where GitHub redirects the
download.

**Turn it off:** **Settings ▸ GitHub Account ▸ Sign out**.

## Images in Markdown

**When:** you view Markdown that embeds an image by its web address: a
repository's README in the Code view (a repository on your computer too), a
commit message's description, or a pull request, issue, release or
notification (the GitHub ones only while you're signed in).

**Where:** to whatever host each image names, for example `img.shields.io`
for the badges at the top of many READMEs. As when you open the page in a
browser, that host sees your IP address. Images stored beside a README in your
repository load from your disk.

The Assistant's replies are the exception: an image in one is shown as its
description and never loaded. A model writes what it is steered to write, and
text hidden in something it reads could make it write an image address that
carries your data to someone else.

**Turn it off:** there is no setting for this.

## AI

**Off until you connect a model** in **Settings ▸ AI Models**. With no
connection, nothing in this section happens: the ✨ buttons stay hidden and
the Assistant asks you to connect one.

**Where:** exactly where you point it.

- A provider's API, with your key: Anthropic, OpenAI, OpenRouter, Google
  Gemini, Groq, Mistral, xAI, DeepSeek, Together, Azure OpenAI, or any
  OpenAI-compatible address you enter.
- A model on your own computer: Ollama (`localhost:11434`) or LM Studio
  (`localhost:1234`). Nothing leaves your computer.
- An agent command-line tool you have installed: Claude Code, Codex or Gemini
  CLI. GitStudio runs it with what the task needs; it signs in and talks to
  its own service by itself.

**What:** what the feature you use works on. A commit message: your staged
changes and your recent commit subjects. Explain, summarize and review: the
changes in question. A pull request description: the branch's commits and
changes. The Assistant: your messages, and what its Git tools read for it
(status, history, diffs, branch names, file contents); it asks you before
every change it makes.

**When:** when you use a feature. Also: opening the Assistant asks the
connected provider for its list of models, and **Test** in Settings sends it a
one-line test message.

**Your keys** are stored encrypted in the app's data folder, sent only to the
provider they belong to, and never reach the app's web pages.

**Turn it off:** remove the connection in **Settings ▸ AI Models**.

## Git

Git makes the network operations you start (fetch, pull, push and clone)
against your repositories' remotes, with your own git configuration and
credentials. The app doesn't fetch on its own.

## The MCP server

**Settings ▸ Agent Access** can install GitStudio's MCP server into Claude
Desktop, Cursor, VS Code or Windsurf. The server talks to the agent that
starts it, on your computer, and makes no network requests of its own. What
that agent does with what it reads is up to the agent.
