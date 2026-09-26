import * as vscode from "vscode";

// GitHub authentication for the PR layer (M11). We lean entirely on VS Code's
// built-in GitHub auth provider — no PAT to manage, no token stored by us. A
// session is requested silently first (so a signed-in user "just works"); we
// only prompt interactively on an explicit action (refresh/checkout/review).
//
// The cached session is invalidated whenever the user signs in/out of GitHub in
// VS Code, and the `gitstudio.github.connected` context key is kept in sync so
// the Pull Requests view can show the connect-prompt vs. the live list.

/** The scopes we need: `repo` covers private repos, PR read + review + create. */
const SCOPES = ["repo"];

export class GitHubAuth implements vscode.Disposable {
  private session: vscode.AuthenticationSession | undefined;
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
