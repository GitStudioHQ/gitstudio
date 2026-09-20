/**
 * The half of a Changes-view state push that waits on git and the AI probe.
 *
 * A push posts twice: an instant first post carrying the last-known values
 * for these, so the file list paints at once and nothing flickers, then a
 * second post after the slow probes resolve. That second post carries the
 * ENTIRE payload again — every file list — and it went out unconditionally,
 * on every push of the onDidChange firehose, even when it corrected nothing.
 * Its only purpose is to correct these four fields, so when none of them
 * moved there is nothing to send.
 */
export interface SlowState {
  aiEnabled: boolean;
  /** `JSON.stringify` of the branch-menu payload; undefined when none was carried. */
  branchesSig: string | undefined;
  unpushed: number | undefined;
  canPublish: boolean | undefined;
}

/** True when the second post would tell the webview something the first did not. */
export function slowStateChanged(sent: SlowState, resolved: SlowState): boolean {
  return (
    sent.aiEnabled !== resolved.aiEnabled ||
    sent.branchesSig !== resolved.branchesSig ||
    sent.unpushed !== resolved.unpushed ||
    sent.canPublish !== resolved.canPublish
  );
}
