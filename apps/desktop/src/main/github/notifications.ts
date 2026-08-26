// The Notifications section's GitHub logic (the user's inbox). Runs in the
// Electron MAIN process. Unlike the repo-scoped sections (PRs / Issues /
// Releases), the GitHub Activity/Notifications API is ACCOUNT-scoped — the
// /notifications endpoints take no owner/repo — so these functions take only
// the client (+ args). main.ts invokes them via `github.withClient(...)`.
//
// All three endpoints are REST-only (the Activity API has no GraphQL form). The
// OAuth token already carries the `notifications` scope GET /notifications,
// PATCH /notifications/threads/{id}, and PUT /notifications require, so no new
// scope is needed; the existing `request`/`requestBody` primitives set Bearer.

import { GitHubClient, enc } from "../githubClient";
import { PAGE_CAPS } from "../githubPaging";
import { errorFields } from "../githubErrors";
import { mapNotification, type RawNotification } from "./maps";
import type { NotificationActionResult, NotificationThread } from "../../shared/ipc";

/** Options for the inbox listing (mirrors the IPC request shape). */
export interface ListNotificationsOptions {
  /** Include already-read threads (GET /notifications?all=true). */
  all?: boolean;
  /** Restrict to threads the user is directly participating in. */
  participating?: boolean;
}

/**
 * The user's notification inbox across every watched repo. A READ method, so it
 * THROWS on auth / rate-limit / network failure — the renderer surfaces a real
 * error state + Retry rather than a misleading "inbox zero". Capped at 50 (no
 * "load more" in v1, matching the other list views).
 */
export async function listNotifications(
  client: GitHubClient,
  opts: ListNotificationsOptions = {},
): Promise<NotificationThread[]> {
  const qs = new URLSearchParams();
  if (opts.all) qs.set("all", "true");
  if (opts.participating) qs.set("participating", "true");
  qs.set("per_page", "50"); // the notifications endpoint caps per_page at 50
  const raw = await client.requestPaged<RawNotification>(
    `/notifications?${qs.toString()}`,
    PAGE_CAPS.notifications,
  );
  return raw.map(mapNotification);
}

/**
 * Mark a single thread as read (GitHub also stops surfacing it as unread). A
 * MUTATION, so it returns the `{ ok, message }` result shape and never throws —
 * the renderer toasts. PATCH .../threads/{id} returns 205 with no body; the
 * client's `requestBody` only checks `res.ok`, which 2xx satisfies.
 */
export async function markNotificationRead(
  client: GitHubClient,
  id: string,
): Promise<NotificationActionResult> {
  try {
    await client.requestBody("PATCH", `/notifications/threads/${enc(id)}`, {});
    return { ok: true };
  } catch (err) {
    return { ok: false, ...errorFields(err) };
  }
}

/**
 * Mark EVERY notification in the user's inbox as read. PUT /notifications
 * returns 202 (accepted; processed async on GitHub's side), so a re-list right
 * after may briefly still show threads — the next refresh reconciles.
 */
export async function markAllNotificationsRead(
  client: GitHubClient,
): Promise<NotificationActionResult> {
  try {
    await client.requestBody("PUT", "/notifications", { read: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, ...errorFields(err) };
  }
}

// ── Raw API shapes + mappers ─────────────────────────────────────────────────



