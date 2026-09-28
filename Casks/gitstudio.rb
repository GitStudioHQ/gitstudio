# GitStudio Desktop — Homebrew cask.
#
#   brew install --cask gitstudiohq/gitstudio/gitstudio
#
# One line: Homebrew taps github.com/GitStudioHQ/homebrew-gitstudio by name,
# and the fully-qualified cask on the command line is the consent Homebrew
# requires for a third-party tap (Homebrew::Trust.explicitly_allowed?), so
# nobody has to learn `brew trust`.
#
# THIS file is the source of truth. Version and checksums are rewritten by
# .github/workflows/release-desktop.yml on every app-v* tag — the
# `finalize-release` job reads the real SHA256s off the uploaded assets — and
# the result is pushed to the tap repository. Do not hand-edit them; they will
# be overwritten.
cask "gitstudio" do
  version "2.3.0"

  on_arm do
    sha256 "a8bdc96673dfda6d27cdb4464af39bae062eedb16f3b8d94148149696c4cf10d"

    url "https://github.com/GitStudioHQ/gitstudio/releases/download/app-v#{version}/GitStudio-#{version}-arm64.dmg"
  end
  on_intel do
    sha256 "e212811820b74e7803a3528c155c1ed3072312dc61826b6f4bb96317d7ef1b40"

    url "https://github.com/GitStudioHQ/gitstudio/releases/download/app-v#{version}/GitStudio-#{version}-x64.dmg"
  end

  name "GitStudio"
  desc "JetBrains-grade Git client for people who work in Git all day"
  homepage "https://gitstudio.dev/"

  # The desktop app releases from its own tag in a repo that also tags the
  # VS Code extension, so match app-v* explicitly.
  livecheck do
    url :url
    regex(/^app-v(\d+(?:\.\d+)+)$/i)
    strategy :git
  end

  auto_updates false
  # 2.3.0 moved to Electron 41, which runs on macOS 12 Monterey or later; on
  # macOS 11 the app would install and then not open. Homebrew refuses up
  # front instead. (2.2.1 is the last release for macOS 11.) A bare version
  # means "this or later" — Homebrew 5.1.11+, which `depends_on :macos` needed
  # already — and the old ">= :monterey" string now prints a deprecation
  # warning on every install. Raise it with the Electron that drops the next
  # macOS, together with scripts/install.sh's MIN_MACOS and a `minimum-macos`
  # note in that release's notes (RELEASING.md).
  depends_on macos: :monterey

  app "GitStudio.app"

  # The build is not signed with a Developer ID, and Homebrew quarantines every
  # download (the --no-quarantine escape hatch was removed in Homebrew 5). On
  # macOS 15 and later a quarantined ad-hoc-signed app does not get the
  # "unidentified developer" prompt — it gets "is damaged and can't be opened",
  # with no way through. Strip the attribute from what was just installed, which
  # is what a user would otherwise have to do by hand.
  #
  # -s matters: Homebrew tags the framework SYMLINKS themselves, and without -s
  # xattr follows each link and strips its target instead, leaving fourteen
  # tagged links inside Electron Framework.framework — enough for Gatekeeper to
  # keep calling the app damaged with every regular file clean.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-d", "-r", "-s", "com.apple.quarantine", "{{appdir}}/GitStudio.app"]
  end

  zap trash: [
    "~/Library/Application Support/GitStudio",
    "~/Library/Logs/GitStudio",
    "~/Library/Preferences/dev.gitstudio.desktop.plist",
    "~/Library/Saved Application State/dev.gitstudio.desktop.savedState",
  ]

  caveats do
    <<~EOS
      This build is not signed with an Apple Developer ID yet. The cask clears
      the quarantine attribute after installing, so it should open normally.
      If macOS still says the app is damaged, run this once:

        xattr -d -r -s com.apple.quarantine /Applications/GitStudio.app

      If it STILL says damaged, macOS is re-scanning that path because an
      earlier copy there was refused; a fresh path is not scanned:

        brew reinstall --cask --appdir=~/Applications gitstudio

      If you already had GitStudio in /Applications from a direct download,
      Homebrew will not overwrite it. Re-run with --force to take it over.

      Prefer the one-line installer, which also verifies the checksum and
      clears the flag:  curl -fsSL https://gitstudio.dev/install.sh | bash
    EOS
  end
end
