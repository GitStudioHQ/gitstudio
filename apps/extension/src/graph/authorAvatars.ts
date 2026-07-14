import type { RepoManager, RepoEntry } from "../git/repoManager";
import type { GitHubApi } from "../pr/githubApi";
import { resolveGitHubContext } from "../pr/repoContext";

/** Lowercased commit-author email → avatar URL. */
export type AuthorAvatarMap = Record<string, string>;

/** Resolves real author photos for the commit graph (best-effort). Injected once
 * at activation so the graph surfaces don't need GitHub deps threaded through
 * their constructors. */
export interface AuthorAvatarResolver {
  resolve(active: RepoEntry): Promise<AuthorAvatarMap>;
}

let current: AuthorAvatarResolver | undefined;
export function setAuthorAvatarResolver(r: AuthorAvatarResolver | undefined): void {
  current = r;
}
export function getAuthorAvatarResolver(): AuthorAvatarResolver | undefined {
  return current;
}

const TTL_MS = 10 * 60 * 1000;

/**
 * Resolves commit-author profile photos two complementary ways, both
 * best-effort and network-guarded:
 *  1. The signed-in GitHub user's avatar mapped to THEIR local git email — so a
 *     user's own commits show their real photo in ANY repo, even a local one
 *     with no GitHub remote (the common "why is there no picture of me?" case).
 *  2. For repos with a GitHub remote, every recent commit author's avatar from
 *     the commits API — so collaborators' photos appear too.
 * Cached per repo root with a short TTL. Any failure yields an empty/partial map
 * and the graph falls back to Gravatar / the initials disc.
 */
export class GitHubAuthorAvatars implements AuthorAvatarResolver {
  private readonly cache = new Map<string, { at: number; map: AuthorAvatarMap }>();

  constructor(
    private readonly api: GitHubApi,
    private readonly repos: RepoManager,
    private readonly isConnected: () => Promise<boolean>,
  ) {}

  async resolve(active: RepoEntry): Promise<AuthorAvatarMap> {
    const cached = this.cache.get(active.root);
    if (cached && Date.now() - cached.at < TTL_MS) {
      return cached.map;
    }
    const map: AuthorAvatarMap = {};
    // Only hit the network when GitHub is actually connected; otherwise every
    // graph open would throw an auth error (and never prompt interactively).
    if (!(await this.isConnected())) {
      this.cache.set(active.root, { at: Date.now(), map });
      return map;
    }
    // 1. The current user's own commits (works without any GitHub remote).
    try {
      const [me, email] = await Promise.all([
        this.api.currentLogin(false),
        this.localEmail(active),
      ]);
      if (me?.avatarUrl && email) {
        map[email.toLowerCase()] = me.avatarUrl;
      }
    } catch {
      /* best-effort */
    }
    // 2. All recent authors on a GitHub-hosted repo.
    try {
      const ctx = await resolveGitHubContext(this.repos);
      if (ctx) {
        const authors = await this.api.commitAuthorAvatars(ctx.owner, ctx.repo);
        Object.assign(map, authors);
      }
    } catch {
      /* best-effort */
    }
    this.cache.set(active.root, { at: Date.now(), map });
    return map;
  }

  /** The repo's configured `user.email` — the address this user commits with. */
  private async localEmail(active: RepoEntry): Promise<string | undefined> {
    try {
      const r = await active.ctx.process.run(["config", "user.email"]);
      const email = r.stdout.trim();
      return email.length > 0 ? email : undefined;
    } catch {
      return undefined;
    }
  }
}
