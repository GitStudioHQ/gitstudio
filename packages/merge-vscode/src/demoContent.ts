// Ready-made content for the walkthroughs' "try it" actions (the product's
// openDemo / openDemoDiff commands). Self-contained so the demos work on a
// fresh install with no git setup: the merge body carries diff3 conflict
// markers that the merge editor reconstructs into base/yours/theirs, and the
// diff is two inline texts. Ported from Merge Studio (src/demoContent.ts);
// generated content — edit freely.

/**
 * Sample side-by-side diff: HEAD vs working tree of an auth middleware.
 * Shows modified lines (intra-line highlights) and a rewritten block.
 */
export const DEMO_DIFF = {
  fileName: "authorizeRequest.ts",
  leftLabel: "HEAD · main",
  rightLabel: "Working Tree",
  leftText: `import type { Request, Response, NextFunction } from "express";
import { verifyJwt } from "./jwt";
import { findSession } from "./store";

const SESSION_TTL_MS = 30 * 60 * 1000;

export async function authorizeRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.header("authorization")?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "missing token" });
    return;
  }

  const claims = await verifyJwt(token);
  const session = await findSession(claims.sub);
  if (!session || session.expiresAt < Date.now()) {
    res.status(401).json({ error: "session expired" });
    return;
  }

  req.userId = session.userId;
  next();
}
`,
  rightText: `import type { Request, Response, NextFunction } from "express";
import { verifyJwt } from "./jwt";
import { findSession, touchSession } from "./store";
import { deviceFingerprint } from "./device";

const SESSION_TTL_MS = 20 * 60 * 1000;

export async function authorizeRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.header("authorization")?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "missing token" });
    return;
  }

  const claims = await verifyJwt(token);
  const session = await findSession(claims.sub);
  if (!session || session.fingerprint !== deviceFingerprint(req)) {
    res.status(401).json({ error: "device mismatch" });
    return;
  }
  await touchSession(session.id, Date.now() + SESSION_TTL_MS);

  req.userId = session.userId;
  next();
}
`,
} as const;

/**
 * Sample 3-way merge: the session-validation block was rewritten on BOTH
 * branches (ours binds the session to the device; theirs adds rate-limiting +
 * audit logging) — a true modify/modify conflict where every side overwrites
 * the same lines — plus a second conflict in the imports and one auto-resolvable
 * change (the TTL, touched only on `ours`).
 */
export const DEMO_MERGE = {
  fileName: "authorizeRequest.ts",
  body: `import type { Request, Response, NextFunction } from "express";
import { verifyJwt } from "./jwt";
<<<<<<< ours
import { findSession, touchSession } from "./store";
import { deviceFingerprint } from "./device";
||||||| base
import { findSession } from "./store";
=======
import { findSession } from "./store";
import { rateLimiter } from "./rateLimit";
import { audit } from "./audit";
>>>>>>> theirs

<<<<<<< ours
const SESSION_TTL_MS = 20 * 60 * 1000;
||||||| base
const SESSION_TTL_MS = 30 * 60 * 1000;
=======
const SESSION_TTL_MS = 30 * 60 * 1000;
>>>>>>> theirs

export async function authorizeRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.header("authorization")?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "missing token" });
    return;
  }

  const claims = await verifyJwt(token);
  const session = await findSession(claims.sub);
<<<<<<< ours
  if (!session || session.fingerprint !== deviceFingerprint(req)) {
    res.status(401).json({ error: "device mismatch" });
    return;
  }
  await touchSession(session.id, Date.now() + SESSION_TTL_MS);
||||||| base
  if (!session || session.expiresAt < Date.now()) {
    res.status(401).json({ error: "session expired" });
    return;
  }
=======
  if (!session || session.revoked) {
    res.status(401).json({ error: "session revoked" });
    return;
  }
  if (!(await rateLimiter.take(session.userId))) {
    res.status(429).json({ error: "rate limited" });
    return;
  }
  await audit.record("authorize", session.userId, req.ip);
>>>>>>> theirs

  req.userId = session.userId;
  next();
}
`,
} as const;
