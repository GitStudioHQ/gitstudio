// The conflicts dashboard's support-link slot for Merge Studio (POLISH A5.10,
// B7), and the quick pick behind Support Merge Studio…. vscode-free: the
// editor facts come in as plain values, so the URLs are unit-tested.
//
// Where the links render (only on the success card, one quiet "Report a
// problem" mid-operation) is the shared dashboard's job, not the shell's.

import * as l10n from "@vscode/l10n";

export const MS_REPO_URL = "https://github.com/GitStudioHQ/merge-studio";
/** GitHub Sponsors: recurring support. The manifest's `sponsor` field is the same page. */
export const MS_SPONSOR_URL = "https://github.com/sponsors/antonarnaudov";
/** Buy me a coffee: a one-off tip, through Revolut. */
export const MS_COFFEE_URL = "https://checkout.revolut.com/pay/7a6070ab-99ba-4170-a125-c5911b1a5c1d";
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
    { label: l10n.t("Report a problem"), url: reportProblemUrl(facts) },
    { label: l10n.t("Rate Merge Studio"), url: rateUrl(facts.uriScheme) },
    { label: l10n.t("Sponsor"), url: MS_SPONSOR_URL },
  ];
}

/** One row of Support Merge Studio…'s quick pick: a QuickPickItem and the page it opens. */
export interface SupportPickItem {
  /** A codicon, then the README's words. */
  label: string;
  description: string;
  url: string;
}

/**
 * Support Merge Studio… — the command's quick pick. Only ever asked for (the
 * command palette, the walkthrough's last line); nothing opens it by itself.
 */
export function supportPick(): { title: string; placeHolder: string; items: SupportPickItem[] } {
  return {
    title: l10n.t("Support Merge Studio"),
    placeHolder: l10n.t("Merge Studio is free and open source. If it saves you time, you can support it."),
    items: [
      { label: `$(heart) ${l10n.t("Sponsor on GitHub")}`, description: l10n.t("recurring support"), url: MS_SPONSOR_URL },
      { label: `$(coffee) ${l10n.t("Buy me a coffee")}`, description: l10n.t("a one-off tip"), url: MS_COFFEE_URL },
    ],
  };
}
