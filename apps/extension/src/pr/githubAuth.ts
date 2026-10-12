import * as vscode from "vscode";
import type { SignInReach } from "@gitstudio/engine/forge/prList";
import type { PrListMessage } from "@gitstudio/host-bridge/prProtocol";
import * as l10n from "@vscode/l10n";

// GitHub authentication for the PR layer (M11). We lean entirely on VS Code's
// built-in GitHub auth provider — no PAT to manage, no token stored by us. A
// session is requested silently first (so a signed-in user "just works"); we
// only prompt interactively on an explicit action (refresh/checkout/review).
//
// The cached session is invalidated whenever the user signs in/out of GitHub in
// VS Code, and the `gitstudio.github.connected` context key is kept in sync so
// the Pull Requests view can show the connect-prompt vs. the live list.

/**
 * The scopes we need: `repo` covers private repos, PR read + review + create.
 * Not `read:org`, so a team's name can't be read: the PR questions ask for
 * one only while GitHub answers them (see `reach`). Asking for another scope
 * here would have VS Code ask every signed-in user to consent again.
 */
const SCOPES = ["repo"];

/** GitStudio's issues (the manifest's `bugs`). */
const ISSUES_URL = "https://github.com/GitStudioHQ/gitstudio/issues";

/**
 * GitHub refused a question for a scope this sign-in wasn't given — what the
 * list, the page and the New pull request form say, with what helps. Not
 * GitHub's own advice: "Please modify your token's scopes at
 * https://github.com/settings/tokens" sent a user to edit a token VS Code's
 * sign-in doesn't use (#82). The scopes are the ones GitStudio asks VS Code
 * for, and signing in again asks for the same, so what helps is GitStudio
 * asking differently — report it — and GitHub's own page meanwhile.
 * `scopes` are the ones GitHub named, any one of which would do.
 */
export function scopeRefusalMessage(scopes: readonly string[], githubUrl: string): PrListMessage {
  const detail =
    scopes.length === 1
      ? l10n.t("GitHub won't answer without the {0} permission, which GitStudio doesn't ask VS Code's GitHub sign-in for, so signing in again won't help. This is GitStudio's to fix: please report it.", scopes[0])
      : scopes.length > 1
        ? l10n.t("GitHub won't answer without one of the permissions {0}, which GitStudio doesn't ask VS Code's GitHub sign-in for, so signing in again won't help. This is GitStudio's to fix: please report it.", scopes.join(", "))
        : l10n.t("GitHub won't answer without a permission GitStudio doesn't ask VS Code's GitHub sign-in for, so signing in again won't help. This is GitStudio's to fix: please report it.");
  // English on purpose: the title of an issue the maintainers read.
  const title = `GitHub asks for ${scopes.length > 0 ? scopes.join(" or ") : "a permission"} the VS Code sign-in doesn't have`;
  return {
    icon: "warning",
    tone: "warning",
    title: l10n.t("GitHub wants a permission this sign-in doesn't have"),
    detail,
    buttons: [
      { label: l10n.t("Report the problem"), icon: "report", primary: true, action: { kind: "openUrl", url: `${ISSUES_URL}/new?title=${encodeURIComponent(title)}` } },
      { label: l10n.t("Open on GitHub"), icon: "link-external", action: { kind: "openUrl", url: githubUrl } },
      { label: l10n.t("Retry"), icon: "refresh", action: { kind: "retry" } },
    ],
  };
}

export class GitHubAuth implements vscode.Disposable {
  private session: vscode.AuthenticationSession | undefined;
  /**
   * What this sign-in may ask GitHub's GraphQL API for (engine/forge/prList's
   * SignInReach), shared by every PR question. Learned from GitHub's own
   * refusals rather than from the session's `scopes`, which list only what
   * was asked for: a token VS Code hands back can carry `read:org` granted
   * to it before (and then reads team names), or not (#82). Forgotten with
   * the session: another sign-in may have been granted more.
   */
  private signInReach: SignInReach = { teams: true };
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires when sign-in state changes (so views can refresh). */
  readonly onDidChange = this.changeEmitter.event;

  constructor() {
    this.disposables.push(
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === "github") {
          // Drop our cached session and re-evaluate connectivity silently.
          this.session = undefined;
          this.signInReach = { teams: true };
          void this.refreshConnected();
          this.changeEmitter.fire();
        }
      }),
    );
  }

  /**
   * Returns a GitHub access token, or undefined when unavailable.
   *   interactive=false (default): silent — only succeeds if a session already
   *     exists. Used on background listing / view refresh.
   *   interactive=true: prompts the VS Code GitHub sign-in flow when needed.
   * Never throws; a cancelled/declined sign-in just yields undefined.
   */
  async getToken(opts?: { interactive?: boolean }): Promise<string | undefined> {
    const interactive = opts?.interactive ?? false;
    try {
      const session = await vscode.authentication.getSession("github", SCOPES, {
        createIfNone: interactive,
        silent: !interactive ? true : undefined,
      });
      const wasConnected = this.session !== undefined;
      this.session = session ?? undefined;
      const nowConnected = this.session !== undefined;
      // Fire ONLY on a real connectivity change. Firing on every token read
      // makes any view that reads the token during its refresh loop forever
      // (refresh → getToken → onDidChange → refresh → …).
      if (nowConnected !== wasConnected) {
        await vscode.commands.executeCommand(
          "setContext",
          "gitstudio.github.connected",
          nowConnected,
        );
        this.changeEmitter.fire();
      }
      return session?.accessToken;
    } catch {
      // User dismissed the auth prompt, or the provider is unavailable.
      return undefined;
    }
  }

  /**
   * Sign in AGAIN, for a session GitHub refused (401). VS Code keeps a revoked
   * or expired session: `createIfNone` hands that same session back without a
   * prompt, and the next request is refused again. `forceNewSession` asks the
   * user to sign in anew (and signs in, when there is no session at all).
   * Never throws; a declined sign-in yields undefined.
   */
  async signInAgain(detail: string): Promise<string | undefined> {
    try {
      const session = await vscode.authentication.getSession("github", SCOPES, {
        forceNewSession: { detail },
      });
      const wasConnected = this.session !== undefined;
      this.session = session;
      this.signInReach = { teams: true };
      if (!wasConnected) {
        await vscode.commands.executeCommand("setContext", "gitstudio.github.connected", true);
      }
      // Another token, whether or not "connected" changed: what was read
      // with the refused one is to be read again.
      this.changeEmitter.fire();
      return session.accessToken;
    } catch {
      return undefined;
    }
  }

  /** True when a GitHub session is currently available (silent check). */
  async isConnected(): Promise<boolean> {
    return (await this.getToken({ interactive: false })) !== undefined;
  }

  /** What this sign-in's GraphQL questions may ask for — read at each question, as a new sign-in starts a new one. */
  get reach(): SignInReach {
    return this.signInReach;
  }

  /** The signed-in account label (e.g. the GitHub login), if any. */
  accountLabel(): string | undefined {
    return this.session?.account.label;
  }

  /**
   * Publishes the `gitstudio.github.connected` context key so menus and the
   * viewsWelcome connect-prompt toggle. Reads cached state without prompting.
   */
  async refreshConnected(): Promise<void> {
    let connected = this.session !== undefined;
    if (!connected) {
      // A silent re-check (cheap; reuses VS Code's own session cache).
      try {
        const session = await vscode.authentication.getSession(
          "github",
          SCOPES,
          { createIfNone: false, silent: true },
        );
        this.session = session ?? undefined;
        connected = session !== undefined;
      } catch {
        connected = false;
      }
    }
    await vscode.commands.executeCommand(
      "setContext",
      "gitstudio.github.connected",
      connected,
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.changeEmitter.dispose();
  }
}
