# GitStudio Desktop — Homebrew cask.
#
#   brew tap gitstudiohq/gitstudio https://github.com/GitStudioHQ/gitstudio
#   brew install --cask gitstudio
#
# Version and checksums are rewritten by .github/workflows/release-desktop.yml
# on every app-v* tag — the `finalize-release` job reads the real SHA256s off
# the uploaded assets. Do not hand-edit them; they will be overwritten.
cask "gitstudio" do
  version "2.0.0"

  on_arm do
    sha256 "bb4535913de46de6b568fb2d74fe921a2d32e2e39682cf04860256e37ed769d6"
    url "https://github.com/GitStudioHQ/gitstudio/releases/download/app-v#{version}/GitStudio-#{version}-arm64.dmg"
  end
  on_intel do
    sha256 "302d686afa527ee2cdf267279f42329241097666c68865190181c2709d3f80f5"
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
  depends_on macos: :big_sur

  app "GitStudio.app"

  zap trash: [
    "~/Library/Application Support/GitStudio",
    "~/Library/Preferences/dev.gitstudio.desktop.plist",
    "~/Library/Saved Application State/dev.gitstudio.desktop.savedState",
    "~/Library/Logs/GitStudio",
  ]

  caveats do
    <<~EOS
      This build is not signed with an Apple Developer ID yet, so the first
      launch shows the "unidentified developer" prompt. Homebrew clears the
      quarantine attribute for you, so it should open normally — if macOS
      still refuses, right-click the app and choose Open once.

      If you already had GitStudio in /Applications from a direct download,
      Homebrew will not overwrite it. Re-run with --force to take it over.
    EOS
  end
end
