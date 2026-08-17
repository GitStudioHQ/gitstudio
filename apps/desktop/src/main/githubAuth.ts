// GitHub OAuth Device Authorization Flow (RFC 8628) for the desktop app.
//
// This is the same model GitKraken / GitHub Desktop / the `gh` CLI use — an
// OAuth App — but in the secret-less "device flow" variant, which is the only
// option safe for distributed, no-backend desktop code: it sends ONLY the
// public Client ID, never a client secret. The user authorizes a short code at
// github.com/login/device and we poll until GitHub hands back a user token.
//
// These two endpoints live on github.com (NOT api.github.com) and must be asked
// for JSON explicitly. All calls run in the MAIN process (no CORS, no secret in
// the renderer).

import { ExpectedError } from "./expectedError";
import { networkError } from "./githubErrors";

/** Public OAuth App Client ID — safe to embed (the secret is intentionally unused). */
export const GITHUB_CLIENT_ID = "Ov23lizWuHbYyvQhkmwu";

/**
 * Scopes requested at sign-in. `repo` unlocks code/PRs/issues/statuses/releases;
 * `workflow` unlocks GitHub Actions control; `read:org` exposes org repos/teams;
 * `gist` + `notifications` power those surfaces. Widen/narrow here as features land.
 */
export const GITHUB_SCOPES = "repo workflow read:org gist notifications project";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * Both endpoints answer JSON — but a captive portal or a GitHub error page
 * answers HTML, and `res.json()` then threw a SyntaxError that read as a crash
 * in GitStudio. An unparseable body is just "no fields", handled below.
 */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  /** Minimum seconds between polls (GitHub default 5). */
  interval: number;
}

export type PollResult =
  | { state: "authorized"; accessToken: string; scope: string }
  | { state: "pending" | "slow_down" | "denied" | "expired" | "error"; message?: string };

/**
 * Step 1: ask GitHub for a device + user code.
 *
 * Everything that can go wrong on this call is a condition, not a defect — the
 * user is offline, or github.com is refusing the request — so it throws
 * ExpectedError and stays out of the crash reporter. See main/githubErrors.ts
 * for the policy.
 */
export async function requestDeviceCode(): Promise<DeviceCode> {
  let res: Response;
  try {
    res = await fetch(DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "GitStudio",
      },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: GITHUB_SCOPES }),
    });
  } catch {
    throw networkError();
  }
  const j = await readJson(res);
  if (!res.ok || j.error) {
    throw new ExpectedError(
      String(j.error_description || j.error || `GitHub returned ${res.status}.`),
    );
  }
  return {
    deviceCode: String(j.device_code),
    userCode: String(j.user_code),
    verificationUri: String(j.verification_uri),
    verificationUriComplete: j.verification_uri_complete
      ? String(j.verification_uri_complete)
      : undefined,
    expiresIn: Number(j.expires_in) || 900,
    interval: Number(j.interval) || 5,
  };
}

/**
 * Step 2: poll once for the access token. The renderer drives the cadence and
 * widens it on `slow_down`. Returns a discriminated result the bridge maps to IPC.
 */
export async function pollForToken(deviceCode: string): Promise<PollResult> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "GitStudio",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
  } catch {
    throw networkError();
  }
  const j = await readJson(res);
  if (j.access_token) {
    return { state: "authorized", accessToken: String(j.access_token), scope: String(j.scope || "") };
  }
  switch (j.error) {
    case "authorization_pending":
      return { state: "pending" };
    case "slow_down":
      return { state: "slow_down" };
    case "expired_token":
      return { state: "expired", message: "The code expired before you authorized. Start again." };
    case "access_denied":
      return { state: "denied", message: "Sign-in was cancelled." };
    default:
      return {
        state: "error",
        message: String(j.error_description || j.error || "Sign-in failed."),
      };
  }
}
