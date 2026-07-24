# Privacy — GitStudio Desktop

No accounts, no usage tracking, no analytics. GitStudio Desktop never reports what you *do*.

The one thing it sends, during the beta, is **anonymous crash reports** when something fails — so we can find and fix bugs without waiting for someone to report them. It's the same mechanism (and the same collector) as the GitStudio extension.

## What a report contains

Only the *shape* of a failure:

- an error type with a scrubbed message/stack, **or** the name of the operation that failed with its scrubbed message;
- a random, rotatable install id (never your identity);
- your OS, app version, and Electron version.

Before anything leaves your machine, the shared scrubber (`@gitstudio/host-bridge/scrub`) strips absolute paths, home directories, emails, remote URLs (host, org, and repo), tokens, and full commit SHAs. **Never** your code, file names, commit messages, or branch names.

## Consent & opt-out

Crash reporting is **on by default** but easy to turn off:

- **Help → Send Anonymous Crash Reports** (a checkbox) toggles it any time. Your choice is remembered.
- It's stored in `error-reporting.json` in the app's user-data folder (`{ "enabled": false }` disables it); deleting that file also rotates your install id.

Reports are sent to `https://gitstudio.dev/api/errors` and filed as deduplicated issues in a **private** maintainer tracker. Nothing is ever public.
