# Releasing GitStudio

GitStudio ships two products from this monorepo, each on its own release channel:

| Product | Tag prefix | Workflow | Outputs |
|---|---|---|---|
| **VS Code / Cursor extension** (`apps/extension`) | `ext-v*` | `.github/workflows/release.yml` | `.vsix` → VS Code Marketplace + Open VSX + GitHub Release |
| **Desktop app** (`apps/desktop`, Electron) | `app-v*` | `.github/workflows/release-desktop.yml` | `.dmg` / `.zip` (mac ×2 arch), `.exe` (win), `.AppImage` + `.deb` (linux) → GitHub Release |

Both release workflows also run typecheck + the full test suite first, so a broken build never publishes. `.github/workflows/ci.yml` runs the same gates on every push/PR to `main` — including the test suite on **ubuntu, macos, and windows**, the same OSes the release matrix builds on.

Two invariants the workflows enforce — don't work around them:

- **The tag must equal the `version` in the product's `package.json`.** Both workflows fail fast on a mismatch (vsce and electron-builder ship whatever is in `package.json`, not what the tag says).
- **Desktop releases own `/releases/latest`.** The in-app auto-updater resolves the repo's *latest* release for its feed, so extension releases are created with `--latest=false`. Never manually mark an `ext-v*` release as latest.
- **The version bump includes `package-lock.json`.** The lock records a `version` for each workspace, and nothing in CI reads it — `npm ci` is happy either way, because every internal dependency is declared as `"*"`. So the drift is silent, and it accumulated across ext-v1.5.0/1.5.1 until the lock still said `1.4.0`. Run `npm install --package-lock-only` after the bump and stage the lock with the `package.json`, or the next unrelated `npm install` drops a surprise version diff into someone else's PR.

---

## One-time setup (repo secrets)

Add these under **Settings → Secrets and variables → Actions**.

**Extension publish — required for the store publish steps** (the `.vsix` still attaches to the GitHub Release without them, but the publish steps **fail loudly** when missing, so a green run always means "actually published"):

- `VSCE_PAT` — Azure DevOps PAT, scope **Marketplace → Manage**, for the `gitstudio` publisher (create the publisher once at <https://marketplace.visualstudio.com/manage>). → VS Code Marketplace.
- `OVSX_PAT` — Open VSX access token (create the `gitstudio` namespace once via `npx ovsx create-namespace gitstudio`). → Open VSX.

If a publish step failed because a secret was missing: add the secret, then re-run the workflow via **Actions → Release Extension → Run workflow** — it rebuilds and publishes the current `package.json` version without a new tag.

**Desktop code-signing / notarization** (optional; unsigned builds still attach to the Release)

- macOS: `CSC_LINK` (base64 .p12), `CSC_KEY_PASSWORD`, and for notarization `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- Windows: `WIN_CSC_LINK` (base64 .pfx), `WIN_CSC_KEY_PASSWORD`.

`GITHUB_TOKEN` is provided automatically — no setup needed for the GitHub Release upload.

---

## Cut an extension release

```bash
# 1. Bump the version + add a CHANGELOG entry
#    apps/extension/package.json  ->  "version": "1.0.0"
#    apps/extension/CHANGELOG.md
#    (optional) docs/releases/ext-v1.0.0.md  ->  used as the Release notes

# 2. Refresh the lock's workspace version (see the invariant above)
npm install --package-lock-only

# 3. Commit, tag, push THE ONE TAG (never `--tags`: that pushes every stale
#    local tag and can fire old release workflows)
git add apps/extension/package.json apps/extension/CHANGELOG.md package-lock.json
git commit -m "release(ext): 1.0.0"
git tag ext-v1.0.0
git push origin main ext-v1.0.0
```

The workflow packages `gitstudio.vsix`, attaches it to the GitHub Release (using `docs/releases/<tag>.md` as notes when present), then publishes to the Marketplace and Open VSX. Manual install for testers:

```bash
cursor  --install-extension gitstudio.vsix --force   # or:
code    --install-extension gitstudio.vsix --force
```

## Cut a desktop app release

```bash
# 1. Bump apps/desktop/package.json  ->  "version": "1.0.0"
#    (optional) docs/releases/app-v1.0.0.md  ->  used as the Release notes
npm install --package-lock-only
git add apps/desktop/package.json package-lock.json
git commit -m "release(app): 1.0.0"
git tag app-v1.0.0
git push origin main app-v1.0.0
```

A `create-release` job makes the Release once (so the matrix jobs never race each other), then a 4-way matrix (**macos-14** arm64, **macos-15-intel** x64, **windows-latest**, **ubuntu-22.04**) builds each installer **natively** — deliberate: the integrated terminal's `node-pty` is a native module, and building per-arch on its own OS avoids cross-compiling its prebuild. Linux builds pin **ubuntu-22.04** so the AppImage links an old-enough glibc for Ubuntu 22.04 / Debian 12 users. The installers upload to the Release for `app-v1.0.0`:

- **macOS** — `GitStudio-1.0.0-arm64.dmg`, `GitStudio-1.0.0-x64.dmg` (+ `.zip`)
- **Windows** — `GitStudio-Setup-1.0.0.exe` (NSIS, user-choosable install dir)
- **Linux** — `GitStudio-1.0.0-x86_64.AppImage` (universal), `GitStudio-1.0.0-amd64.deb` (Debian/Ubuntu), `GitStudio-1.0.0-x86_64.rpm` (Fedora/RHEL), `GitStudio-1.0.0-x64.tar.gz` (portable). The rpm target shells out to `rpmbuild`, which the workflow installs on the Linux runner.

Artifact names are pinned in `electron-builder.yml` (no spaces, arch-suffixed) so the website can link them predictably: `https://github.com/GitStudioHQ/gitstudio/releases/download/app-v<version>/<name>`.

**Install channels.** Four, all fed by the same Release assets, so there is one
artifact set and nothing to keep in sync by hand:

- **`curl | bash`** — `scripts/install.sh` (macOS, Linux). Resolves the newest
  `app-v*` tag, picks the asset for the host OS/arch, verifies it against
  `SHA256SUMS.txt`, mounts the dmg into `/Applications` (clearing the Gatekeeper
  quarantine) or installs the AppImage into `~/.local/bin` with a `.desktop`
  entry.
- **`irm | iex`** — `scripts/install.ps1` (Windows). Same resolution and
  verification, then runs the NSIS installer (`-Silent` for unattended).
- **Homebrew** — `Casks/gitstudio.rb`, tapped straight from this repo:
  `brew tap gitstudiohq/gitstudio https://github.com/GitStudioHQ/gitstudio`.
  Homebrew requires `brew trust` for any third-party tap, and refuses to
  overwrite an existing `/Applications/GitStudio.app` without `--force`; both
  are in the README and the cask's caveats. The cask's `postflight` strips the
  quarantine attribute Homebrew puts on every download — Homebrew 5 removed
  `--no-quarantine`, and on macOS 15+ a quarantined unsigned app opens to
  "is damaged and can't be opened", not to the unidentified-developer prompt.
  The `finalize-release` job rewrites the cask's `version` and both `sha256`
  values from the assets it just published, attaches the result to the release,
  and opens a one-file PR to land it on `main`. Merge that PR and the tap
  resolves to the new release. Never hand-edit those lines.

  It opens a PR rather than pushing because the ruleset on `main` requires one
  and the Actions token has no bypass; the step is `continue-on-error` so a
  housekeeping commit can never take a release down. If you grant the Actions
  app a ruleset bypass, the push can go straight to `main` instead.
- **Direct download** — the installer table in the README.

`SHA256SUMS.txt` is generated in `finalize-release` by downloading the published
assets and hashing them there, rather than trusting a value from a build job
that might have been re-run.

**Auto-update:** Windows and Linux update in-app through electron-updater (`latest.yml` / `latest-linux.yml` ship with the release). macOS ships no `latest-mac.yml` (two per-arch runners would clobber each other's, and unsigned builds can't apply Squirrel.Mac updates), so the app polls the GitHub API for a newer `app-v*` release itself, downloads the right `.dmg` into `~/Downloads` on confirmation, and opens it — see `apps/desktop/src/main/autoUpdate.ts`.

> Unsigned builds: Windows shows SmartScreen ("More info → Run anyway"). On macOS a quarantined unsigned app is refused outright on 15+ ("damaged") — the cask and `install.sh` strip the quarantine attribute; a direct `.dmg` download needs `xattr -dr com.apple.quarantine /Applications/GitStudio.app` once. The app's own updater downloads with Node `fetch`, which sets no quarantine, so in-app updates are unaffected. Add the signing secrets above to remove all of this; macOS notarization also needs the Apple secrets.

---

## Build locally

```bash
# Extension .vsix
cd apps/extension && npm run package && npx @vscode/vsce package --no-dependencies

# Desktop app (host platform only — linux .deb/.AppImage need a Linux host/CI)
cd apps/desktop
npm run package   # electron-builder --dir  -> release/<platform>/GitStudio.app  (fast, no installer)
npm run dist      # full installers for the host OS -> release/*.dmg, *.zip, ...
```

## Versioning

Independent per product (the extension moves faster than the app). The tag↔`package.json` guard in each workflow keeps them honest; the desktop auto-update feed (`publish:` in `electron-builder.yml`, `GitStudioHQ/gitstudio`) reads the tag's Release assets.
