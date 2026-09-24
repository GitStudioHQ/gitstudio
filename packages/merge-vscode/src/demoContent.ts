// Ready-made content for the walkthroughs' "try it" actions (the product's
// openDemo / openDemoDiff commands). Self-contained, so both work on a fresh
// install with no git at all. vscode-free: the sample's whole conversation
// with the merge editor is decided here and unit-tested.
//
// The sample merge (POLISH A6.1) is one file, authorizeRequest.ts, as a
// rebase would stop on it — three versions, sent as stages with a synthetic
// operation, so the editor shows what a real stop shows: the direction bar
// with branch names, the step, the commit, and every kind of change the
// legend counts (a conflict, the same change on both sides, and a change in
// Yours only and in Theirs only), including a conflict that Resolve simple
// (the toolbar's wand) settles. What it contains is never typed here: the
// engine classifies the three versions, and test/demoContent.test.ts holds
// the sample to "every category at least once".

import { markUnsettled, prepareMerge } from "@gitstudio/engine/conflict/documentText";
import type { OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import type { HostMessage, MergeInitPayload, WebviewMessage } from "@gitstudio/host-bridge/protocol";
import { markerLabelsFor } from "./documentSync";

/**
 * Sample side-by-side diff: an auth middleware before and after a change —
 * modified lines (word highlights), an added import, a deleted line, a line
 * whose only change is its indentation, and a rewritten block.
 */
export const DEMO_DIFF = {
  fileName: "authorizeRequest.ts",
  leftLabel: "Sample · before",
  rightLabel: "Sample · after",
  leftText: `import type { Request, Response, NextFunction } from "express";
import { verifyJwt } from "./jwt";
import { findSession } from "./store";

const SESSION_TTL_MS = 30 * 60 * 1000;

export async function authorizeRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  res.setHeader("X-Legacy-Auth", "1");
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

/** The file as the three versions of the stop hold it. */
const BASE = `import type { Request, Response, NextFunction } from "express";
import { findSession } from "./store";
import { verifyJwt } from "./jwt";

const SESSION_TTL_MS = 30 * 60 * 1000;

const MAX_TOKEN_LENGTH = 2048;

export async function authorizeRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  res.setHeader("X-Legacy-Auth", "1");

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
`;

/** Yours: the commit being replayed — it binds a session to the device. */
const YOURS = `import type { Request, Response, NextFunction } from "express";
import { findSession } from "./store";
import { verifyJwt } from "./auth/jwt";

const SESSION_TTL_MS = 20 * 60 * 1000;

const MAX_TOKEN_LENGTH = 4096;

export async function authorizeRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {

  const token = req.get("Authorization")?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "missing token" });
    return;
  }

  const claims = await verifyJwt(token);
  const session = await findSession(claims.sub);
  if (!session || session.deviceId !== req.header("x-device-id")) {
    res.status(401).json({ error: "device mismatch" });
    return;
  }

  req.userId = session.userId;
  req.sessionId = session.id;
  next();
}
`;

/** Theirs: main, which added revocation, an audit record and a token limit meanwhile. */
const THEIRS = `import type { Request, Response, NextFunction } from "express";
import { audit } from "./audit";
import { findSession } from "./store";
import { verifyJwt } from "./auth/jwt";

const SESSION_TTL_MS = 30 * 60 * 1000;

const MAX_TOKEN_LENGTH  = 4096;

export async function authorizeRequest(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
  res.setHeader("X-Legacy-Auth", "1");

  const token = req.header("authorization")?.replace("Bearer ", "");
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    res.status(401).json({ error: "missing token" });
    return;
  }

  const claims = await verifyJwt(token);
  const session = await findSession(claims.sub);
  if (!session || session.revoked) {
    await audit.record("session-revoked", claims.sub);
    res.status(401).json({ error: "session revoked" });
    return;
  }

  req.userId = session.userId;
  req.sessionId = session.id;
  next();
}
`;

const COMMIT = { sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", subject: "Bind sessions to the device", author: "Sample" };

/**
 * The stop the sample stands for: commit 2 of 3 of feature/session-hardening
 * being rebased onto main — Yours is the commit being replayed, drawn on the
 * left, as in every real rebase. Kind "none": there is no git operation behind
 * it, so Cancel closes the sample instead of offering an abort that cannot run,
 * and no Continue appears.
 */
export const SAMPLE_OP: OperationView = {
  kind: "none",
  title: "Sample · rebasing feature/session-hardening onto main · commit 2 of 3",
  direction: { from: "yours", verb: "onto", to: "theirs" },
  step: { n: 2, m: 3, unit: "commit" },
  commit: COMMIT,
  yours: {
    role: "yours",
    stage: 3,
    name: "feature/session-hardening",
    paneTitle: "Rebasing a1b2c3d from feature/session-hardening",
    description: `Your commit a1b2c3d “${COMMIT.subject}” from feature/session-hardening`,
  },
  theirs: {
    role: "theirs",
    stage: 2,
    name: "main",
    paneTitle: "Already rebased commits and commits from main",
    description: "main, plus the commits already rebased onto it",
  },
  verbs: { abort: "Close sample" },
  canContinue: false,
  canSkip: false,
  episode: "sample",
};

export const DEMO_MERGE = {
  fileName: "authorizeRequest.ts",
  /** The editor tab's title. */
  title: "Sample: authorizeRequest.ts",
  base: BASE,
  yours: YOURS,
  theirs: THEIRS,
  op: SAMPLE_OP,
} as const;

/** What Apply says in the sample: nothing is written, and what a real Apply does. */
export const SAMPLE_APPLIED =
  "Sample resolved. In a real conflict, Apply saves and stages the file, then Continue Rebase appears.";

let body: string | undefined;

/**
 * The sample file's text as git would leave it at such a stop: what merges
 * cleanly merged, every conflict between diff3 markers — written by the same
 * rule the merge editor writes an unfinished merge with.
 */
export function sampleFileText(): string {
  if (body === undefined) {
    const prepared = prepareMerge({ base: BASE, ours: YOURS, theirs: THEIRS });
    body = markUnsettled(prepared, BASE, markerLabelsFor({ op: SAMPLE_OP }))?.text ?? BASE;
  }
  return body;
}

/** The sample's init payload: the three versions as stages, with its operation. */
export function samplePayload(settings: { autoApplyNonConflicting: boolean }): MergeInitPayload {
  return {
    fileName: DEMO_MERGE.fileName,
    conflictType: "content",
    source: "git-stages",
    hasBase: true,
    oursLabel: SAMPLE_OP.yours.paneTitle,
    theirsLabel: SAMPLE_OP.theirs.paneTitle,
    base: BASE,
    ours: YOURS,
    theirs: THEIRS,
    result: sampleFileText(),
    autoApplyNonConflicting: settings.autoApplyNonConflicting,
    op: SAMPLE_OP,
    shape: "text",
  };
}

/**
 * How the sample's merge editor answers the page: the payload (and "nothing
 * left to resolve", so Cancel just closes it), an explanation instead of a
 * write for Apply, and a close for Cancel. It never writes a file.
 */
export function sampleAnswer(
  message: WebviewMessage | undefined,
  settings: { autoApplyNonConflicting: boolean },
): { post: HostMessage[]; close?: boolean } {
  switch (message?.type) {
    case "ready":
      return {
        post: [
          { type: "init", ...samplePayload(settings) },
          { type: "opChanged", op: SAMPLE_OP, remainingConflicts: 0 },
        ],
      };
    case "apply":
      return { post: [{ type: "outcome", kind: "done", text: SAMPLE_APPLIED }] };
    case "cancel":
      return { post: [], close: true };
    default:
      return { post: [] };
  }
}
