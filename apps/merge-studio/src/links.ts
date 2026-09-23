// The conflicts dashboard's support-link slot for Merge Studio (POLISH A5.10,
// B7). vscode-free: the editor facts come in as plain values, so the URLs are
// unit-tested.
//
// Where the links render (only on the success card, one quiet "Report a
// problem" mid-operation) is the shared dashboard's job, not the shell's.

export const MS_REPO_URL = "https://github.com/GitStudioHQ/merge-studio";
export const MS_SPONSOR_URL = "https://github.com/sponsors/antonarnaudov";
export const MS_MARKETPLACE_REVIEWS_URL =
  "https://marketplace.visualstudio.com/items?itemName=gitstudio.merge-studio&ssr=false#review-details";
export const MS_OPENVSX_REVIEWS_URL = "https://open-vsx.org/extension/gitstudio/merge-studio/reviews";

export interface EditorFacts {
  /** Merge Studio's own version (package.json). */
  version: string;
  /** vscode.env.appName: "Visual Studio Code", "Cursor", … */
  appName: string;
  /** vscode.version: the editor's version. */
  appVersion: string;
  /** vscode.env.uriScheme: "vscode" for Microsoft's builds; forks have their own. */
  uriScheme: string;
  /** process.platform + process.arch, e.g. "darwin arm64". */
  platform: string;
}

/**
 * A new GitHub issue with the facts a merge bug needs already filled in.
 * Nothing about the repository (paths, branches, file names) is included.
 */
export function reportProblemUrl(facts: EditorFacts): string {
  const body = [
    `Merge Studio ${facts.version} · ${facts.appName} ${facts.appVersion} · ${facts.platform}`,
    "",
    "**What were you doing?** (merge, rebase, cherry-pick, revert, git am, stash pop)",
    "",
    "**What happened?**",
    "",
    "**What did you expect?**",
    "",
  ].join("\n");
  return `${MS_REPO_URL}/issues/new?labels=bug&body=${encodeURIComponent(body)}`;
}

/**
 * Where to leave a rating: the VS Code Marketplace in Microsoft's VS Code,
 * Open VSX in every other editor (Cursor, VSCodium, Windsurf install from
 * there).
 */
export function rateUrl(uriScheme: string): string {
  return uriScheme === "vscode" || uriScheme === "vscode-insiders"
    ? MS_MARKETPLACE_REVIEWS_URL
    : MS_OPENVSX_REVIEWS_URL;
}

/** The dashboard's support links, in order. Every one is an https page. */
export function supportLinks(facts: EditorFacts): { label: string; url: string }[] {
  return [
    { label: "Report a problem", url: reportProblemUrl(facts) },
    { label: "Rate Merge Studio", url: rateUrl(facts.uriScheme) },
    { label: "Sponsor", url: MS_SPONSOR_URL },
  ];
}
