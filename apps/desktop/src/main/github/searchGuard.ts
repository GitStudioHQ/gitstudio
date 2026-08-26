// Search rate budget.
//
// GitHub's search API is metered separately from core REST — 30 requests per
// minute for repositories/users, and only 10 for code. Blowing through that
// earns a 403 that looks, to a user, exactly like "the app is broken".
//
// So we spend the budget deliberately: a token bucket per category, checked
// BEFORE the request. When there's nothing left we return a structured
// `limited { retryInMs }` instead of firing and hoping — the UI can then say
// "one moment" honestly, with a countdown, rather than showing an error for a
// condition that resolves itself in seconds.
//
// Pure and clock-injectable, so the whole policy is node-testable.

export type SearchCategory = "core" | "code";

/** Requests per minute GitHub allows an authenticated user, per category. */
export const SEARCH_LIMITS: Record<SearchCategory, number> = {
  core: 30,
  code: 10,
};

const WINDOW_MS = 60_000;
/** Leave a little headroom — other GitStudio surfaces share the same budget. */
const RESERVE = 2;

export class SearchGuard {
  /** Timestamps of recent spends, per category (oldest first). */
  private readonly spent: Record<SearchCategory, number[]> = { core: [], code: [] };

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Drop spends that have aged out of the window. */
  private prune(cat: SearchCategory): number[] {
    const cutoff = this.now() - WINDOW_MS;
    const kept = this.spent[cat].filter((t) => t > cutoff);
    this.spent[cat] = kept;
    return kept;
  }

  /** Requests still available in this window. */
  remaining(cat: SearchCategory): number {
    return Math.max(0, SEARCH_LIMITS[cat] - RESERVE - this.prune(cat).length);
  }

  /**
   * Claim one request. Returns `{ ok: true }` when the caller may proceed, or
   * `{ ok: false, retryInMs }` — the wait until the oldest spend ages out.
   */
  take(cat: SearchCategory): { ok: true } | { ok: false; retryInMs: number } {
    const kept = this.prune(cat);
    if (kept.length < SEARCH_LIMITS[cat] - RESERVE) {
      kept.push(this.now());
      return { ok: true };
    }
    const oldest = kept[0] ?? this.now();
    // +1s so a retry scheduled at exactly this time doesn't land a tick early.
    return { ok: false, retryInMs: Math.max(0, oldest + WINDOW_MS - this.now()) + 1_000 };
  }
}
