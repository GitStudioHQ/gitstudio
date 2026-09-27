// Types for no-network-chrome.mjs, for the TypeScript launchers and tests that import it.

/** The switches that keep a headless Chrome on this machine. */
export declare const NO_NETWORK_CHROME: readonly string[];
/**
 * The argv of a headless Chrome: --headless, the guard, then `args`. Throws on
 * an argument that names the resolver or a proxy — it would undo the guard.
 */
export declare function headlessChromeArgs(args?: readonly string[]): string[];
