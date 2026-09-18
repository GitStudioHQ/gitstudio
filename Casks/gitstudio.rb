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
    sha256 "a601478b1ce7526330c6888eaa81dcfbec640ac4457173b90cbf43fedb270177"
    url "https://github.com/GitStudioHQ/gitstudio/releases/download/app-v#{version}/GitStudio-#{version}-arm64.dmg",
        verified: "github.com/GitStudioHQ/gitstudio/"
  end
  on_intel do
    sha256 "ea8fce35fe29f3842459c3d94f12153f0857004514dfeb58b7669f2be2b71f44"
    url "https://github.com/GitStudioHQ/gitstudio/releases/download/app-v#{version}/GitStudio-#{version}-x64.dmg",
        verified: "github.com/GitStudioHQ/gitstudio/"
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
  depends_on macos: ">= :big_sur"

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
    EOS
  end
end
