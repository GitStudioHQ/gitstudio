// What the no-Git screen (noGit.ts) says, for one machine. Pure — no DOM, no
// bridge — so every OS and every reason is tested under plain node
// (test/noGit.test.ts), not only in the harness.

import type { GitAvailability } from "../shared/ipc";

export type GitMissing = Extract<GitAvailability, { ok: false }>;

export interface GitHelp {
  title: string;
  lead: string;
  /** What a git that would not run said, word for word. */
  detail?: string;
  /** Ways to get Git, in the order to try them. */
  ways: Array<{ label: string; command?: string }>;
  download: { label: string; url: string };
}

export const GIT_DOWNLOADS = "https://git-scm.com/downloads";

function installWays(platform: string): GitHelp["ways"] {
  if (platform === "darwin") {
    return [
      {
        label: "Install Apple's Command Line Tools, which include Git. macOS may already be offering to; if not, run this in Terminal:",
        command: "xcode-select --install",
      },
      { label: "Or, with Homebrew:", command: "brew install git" },
    ];
  }
  if (platform === "win32") {
    return [
      { label: "Download Git for Windows from git-scm.com and run the installer. Its default choices are fine." },
      { label: "Or, in a terminal:", command: "winget install --id Git.Git -e --source winget" },
    ];
  }
  return [
    { label: "Install it with your distribution's package manager. Debian and Ubuntu:", command: "sudo apt install git" },
    { label: "Fedora:", command: "sudo dnf install git" },
    { label: "Arch:", command: "sudo pacman -S git" },
    { label: "openSUSE:", command: "sudo zypper install git" },
  ];
}

export function gitInstallHelp(git: GitMissing): GitHelp {
  const download = {
    label: git.platform === "win32" ? "Download Git for Windows" : "Get Git from git-scm.com",
    url: GIT_DOWNLOADS,
  };
  if (git.reason === "xcode") {
    return {
      title: "Git needs Apple's Command Line Tools",
      lead:
        "macOS runs Git through Apple's Command Line Tools, and they are not installed on this Mac, " +
        "or a macOS update left them needing a reinstall. GitStudio uses the Git on your Mac, so it " +
        "can't open a repository until they are there.",
      ...(git.detail ? { detail: git.detail } : {}),
      ways: installWays("darwin"),
      download,
    };
  }
  if (git.reason === "broken") {
    return {
      title: "Git isn't working",
      lead: "GitStudio found Git on this computer, but it didn't run. Installing it again usually fixes this.",
      ...(git.detail ? { detail: git.detail } : {}),
      ways: installWays(git.platform),
      download,
    };
  }
  return {
    title: "Git isn't installed",
    lead: "GitStudio uses the Git installed on your computer, and it couldn't find one. Install Git, then check again.",
    ways: installWays(git.platform),
    download,
  };
}
