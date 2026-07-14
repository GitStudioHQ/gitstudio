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

# 2. Commit, tag, push THE ONE TAG (never `--tags`: that pushes every stale
#    local tag and can fire old release workflows)
git add apps/extension/package.json apps/extension/CHANGELOG.md
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
git add apps/desktop/package.json
git commit -m "release(app): 1.0.0"
git tag app-v1.0.0
git push origin main app-v1.0.0
```

A `create-release` job makes the Release once (so the matrix jobs never race each other), then a 4-way matrix (**macos-14** arm64, **macos-15-intel** x64, **windows-latest**, **ubuntu-22.04**) builds each installer **natively** — deliberate: the integrated terminal's `node-pty` is a native module, and building per-arch on its own OS avoids cross-compiling its prebuild. Linux builds pin **ubuntu-22.04** so the AppImage links an old-enough glibc for Ubuntu 22.04 / Debian 12 users. The installers upload to the Release for `app-v1.0.0`:

- **macOS** — `GitStudio-1.0.0-arm64.dmg`, `GitStudio-1.0.0-x64.dmg` (+ `.zip`)
- **Windows** — `GitStudio-Setup-1.0.0.exe` (NSIS, user-choosable install dir)
- **Linux** — `GitStudio-1.0.0-x64.AppImage` (universal), `GitStudio-1.0.0-x64.deb` (Debian/Ubuntu)

Artifact names are pinned in `electron-builder.yml` (no spaces, arch-suffixed) so the website can link them predictably: `https://github.com/GitStudioHQ/gitstudio/releases/download/app-v<version>/<name>`.

**Auto-update:** Windows and Linux update in-app (`latest.yml` / `latest-linux.yml` ship with the release). macOS update checks are intentionally disabled in the app (two per-arch runners would clobber each other's `latest-mac.yml`, and unsigned builds can't apply Squirrel.Mac updates) — mac users update via the website/Release page.

> Unsigned macOS/Windows builds trigger the OS "unidentified developer" prompt. Add the signing secrets above to remove it. macOS notarization also needs the Apple secrets.

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
