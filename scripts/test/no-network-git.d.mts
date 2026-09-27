// Types for no-network-git.mjs, for the TypeScript tests that import it.

/** Set in every process no-network-git.mjs has guarded. */
export declare const NO_NETWORK_MARK: string;
/** The proxy git's http(s) is sent to — nothing listens there. */
export declare const NO_NETWORK_PROXY: string;
/** The guard's GIT_SSH_COMMAND: a program that is never there. */
export declare const NO_NETWORK_SSH: string;
/**
 * Serve this test's own ssh: sets GIT_SSH_COMMAND, which outranks every
 * core.sshCommand. Returns the undo — call it in a `finally`.
 */
export declare function serveOwnSsh(command: string): () => void;
