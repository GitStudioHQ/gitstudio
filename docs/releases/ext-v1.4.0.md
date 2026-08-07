# GitStudio 1.4.0 — no more password prompts, and no more search bar

Two things you could feel every day, and a bug that quietly pushed to the wrong
branch.

## GitStudio no longer touches your OS keychain

If GitStudio ever made Cursor or VS Code ask for your macOS password at startup,
that stops now — including for people who had never configured AI at all.

Reading an API key from the editor's SecretStorage unlocks the host app's
keyring entry, and on macOS that entry's ACL is bound to the app's code
signature. Every editor update invalidated it, and the next read raised *"Cursor
wants to make changes. Enter your password to allow this."* GitStudio read its
key while merely deciding whether to show the ✨ button — at launch, and again on
every Changes-view refresh.

Keys now live in GitStudio's own AES-256-GCM store inside the extension's
private storage, owner-only on disk. "Is a key configured?" is answered from the
filesystem, so the paths that run constantly never touch key material at all.

Upgrading with a key already saved? **GitStudio · AI** has an *Import key from
the editor's secret storage* button. It is the one and only action left that can
raise a keychain prompt, and only when you click it.

## Every question is now a GitStudio dialog

1.3.0 moved nine action menus out of the command palette. This finishes the job:
renaming a branch, setting an upstream, adding a remote, naming a stash,
choosing a rebase base, picking a pull request, entering an API key, and every
destructive confirmation.

The quick input was the command palette wearing a different hat. It hijacked the
top of the window, threw away whatever you had typed the moment focus moved, and
couldn't complete over the branches and tags the view was already holding.
Revision prompts now complete over every branch, remote branch and tag while
still accepting any revision expression — `HEAD~5`, `origin/main^`, a bare sha.

Confirmations also say what will actually happen, and what can be recovered,
instead of asserting "this cannot be undone" about things Undo handles fine. The
one case that genuinely can't be recovered — discarding uncommitted work — says
so, and says why.

## Renaming a published branch no longer pushes to the old name

Push a commit, amend it, rename the branch, push again — and the push went to
the branch's old name, or was refused outright.

`git branch -m` deliberately keeps the tracking config, because the branch on
the server wasn't renamed. Everything downstream inherited it: the push modal
named the old branch, the ↑/↓ badges counted against it, and the push did one of
three different things depending on a `push.default` you never set.

Renaming a published branch now asks what you meant — rename it on the remote
too, publish the new name and keep the old, or keep tracking the old. And a push
resolves its refspec explicitly, so one click means the same thing on every
machine.

## Also fixed

- **Git could hang forever on a credential prompt.** No editor host has a
  terminal, so when git asked for a password or key passphrase the question had
  nowhere to go and the operation blocked indefinitely, freezing the sync UI.
  Git now fails fast with a real message. Credential *helpers* — macOS Keychain,
  Git Credential Manager, any GUI askpass — are unaffected.
- **Dead resize handles in the narrow commit graph**, where hidden columns left
  invisible drag targets behind.

---

**Install:** search **GitStudio** in the Extensions view, or
`code --install-extension gitstudio.gitstudio` ·
`cursor --install-extension gitstudio.gitstudio`

Full detail in the [changelog](https://github.com/GitStudioHQ/gitstudio/blob/main/apps/extension/CHANGELOG.md).
