// Keychain-free secret storage.
//
// Why this exists instead of vscode's SecretStorage / Electron's safeStorage:
// both of those are backed by the OS keyring, and on macOS the keyring ACL is
// bound to the host application's code signature. Every signature change — a
// Cursor/VS Code update, an Electron rebuild, an unsigned local build — voids
// the ACL, so the very next read raises "<App> wants to make changes. Enter your
// password to allow this." For a Git client that only wants to answer "is an AI
// key configured?" that prompt is pure noise, and it is unavoidable while the
// keyring is in the path at all.
//
// So we keep the secrets ourselves: AES-256-GCM blobs in an owner-only
// directory, encrypted with a 32-byte device key generated on first use and
// stored 0600 beside them.
//
// THE TRADE-OFF, STATED PLAINLY: the device key sits next to the ciphertext, so
// any process already running as this user can read both and recover the
// plaintext. That is strictly weaker than an OS keyring, which can require an
// interactive unlock. What this design does buy:
//   • a stolen backup, synced folder, or copied profile is useless on its own —
//     the ciphertext is worthless without the device key file, which is 0600 and
//     never leaves the machine on purpose;
//   • nothing is ever written to disk in cleartext;
//   • no OS password prompt, ever, on any code path.
// Callers that need keyring-grade protection should not use this module.

import { randomBytes, createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, readdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Envelope version, so the on-disk format can change without silent misreads. */
const FORMAT = 1;

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const DEVICE_KEY_FILE = "device.key";
const SECRET_EXT = ".secret";

/** Owner-only, for both the directory and every file we write inside it. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

interface Envelope {
  v: number;
  /** base64 initialisation vector. */
  iv: string;
  /** base64 GCM auth tag. */
  tag: string;
  /** base64 ciphertext. */
  data: string;
}

/**
 * Map a logical secret name to a file name. Secret names are developer-authored
 * constants (`gitstudio.ai.anthropicKey`, a connection uuid), not user input,
 * but this still refuses anything that could escape the directory rather than
 * trusting that to stay true.
 */
function fileNameFor(name: string): string {
  if (!name || name.length > 200 || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid secret name: ${JSON.stringify(name)}`);
  }
  return `${name}${SECRET_EXT}`;
}

/**
 * Secrets on disk, encrypted, with no OS keyring involvement.
 *
 * Every method is safe to call on any code path — including startup and
 * background refreshes — because none of them can block on a UI prompt.
 */
export class SecretStore {
  /**
   * The in-flight (then settled) key derivation. Held as a promise, not a
   * Buffer, so concurrent first-time callers share ONE device-key creation: two
   * racing `set()` calls that each generated and wrote their own key would leave
   * whichever blob was encrypted under the loser permanently undecryptable.
   */
  private keyPromise: Promise<Buffer> | undefined;
  /**
   * In-memory plaintext cache, so repeat reads don't re-decrypt. Only ever
   * holds values that were successfully read or written — "no such secret" is
   * never cached, so a key stored by another window shows up on the next read.
   */
  private readonly cache = new Map<string, string>();

  /**
   * @param dir Directory that holds the device key and the secret blobs. Use a
   *   per-application private location: `context.globalStorageUri.fsPath` in the
   *   VS Code extension, `app.getPath("userData")/secrets` in the desktop app.
   */
  constructor(private readonly dir: string) {}

  /**
   * Does a secret exist?
   *
   * Deliberately answers from the filesystem WITHOUT decrypting: availability
   * probes ("is AI configured?", "is GitHub connected?") run on hot paths and
   * must never need key material. Cheap enough to call in a render loop.
   */
  has(name: string): boolean {
    return this.cache.has(name) || existsSync(join(this.dir, fileNameFor(name)));
  }

  /** The stored secret, or undefined when unset or undecryptable. */
  async get(name: string): Promise<string | undefined> {
    const cached = this.cache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    let raw: string;
    try {
      raw = await readFile(join(this.dir, fileNameFor(name)), "utf8");
    } catch {
      return undefined; // not set
    }
    let env: Envelope;
    try {
      env = JSON.parse(raw) as Envelope;
    } catch {
      return undefined; // corrupt
    }
    if (env.v !== FORMAT) {
      return undefined; // written by a future version — do not guess
    }
    try {
      const key = await this.key();
      const decipher = createDecipheriv(ALGO, key, Buffer.from(env.iv, "base64"));
      decipher.setAuthTag(Buffer.from(env.tag, "base64"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(env.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
      this.cache.set(name, plain);
      return plain;
    } catch {
      // Wrong device key (profile copied from another machine) or tampering —
      // GCM authentication failed. Treat as unset rather than throwing into a
      // caller that only wanted to know whether AI is configured.
      return undefined;
    }
  }

  /** Encrypt and persist a secret, replacing any previous value. */
  async set(name: string, value: string): Promise<void> {
    const file = join(this.dir, fileNameFor(name));
    const key = await this.key();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const env: Envelope = {
      v: FORMAT,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    await writeFile(file, JSON.stringify(env), { mode: FILE_MODE });
    // writeFile's `mode` only applies when it creates the file; an existing one
    // keeps its old permissions, so re-assert them.
    await chmod(file, FILE_MODE).catch(() => {});
    this.cache.set(name, value);
  }

  /** Forget a secret. Succeeds whether or not one was stored. */
  async delete(name: string): Promise<void> {
    this.cache.delete(name);
    try {
      await unlink(join(this.dir, fileNameFor(name)));
    } catch {
      // already gone
    }
  }

  /** Every stored secret name (for diagnostics / "forget everything"). */
  async names(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir);
      return entries
        .filter((e) => e.endsWith(SECRET_EXT))
        .map((e) => e.slice(0, -SECRET_EXT.length));
    } catch {
      return [];
    }
  }

  /** Drop cached plaintext (used by tests and by "disconnect everything"). */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * The AES key, derived from the device key so the raw file bytes are never
   * used directly as a cipher key. Generated on first use; concurrent callers
   * share one in-flight read because `key()` is awaited before any write.
   */
  private key(): Promise<Buffer> {
    this.keyPromise ??= this.readOrCreateDeviceKey().then((raw) =>
      // HKDF gives domain separation: the file bytes are the input keying
      // material, not the cipher key, so the same device key could later derive
      // additional purpose-specific keys without reuse.
      Buffer.from(
        hkdfSync("sha256", raw, Buffer.alloc(0), "gitstudio.secret-store.v1", KEY_BYTES),
      ),
    );
    return this.keyPromise;
  }

  private async readOrCreateDeviceKey(): Promise<Buffer> {
    const file = join(this.dir, DEVICE_KEY_FILE);
    try {
      const buf = await readFile(file);
      if (buf.length >= KEY_BYTES) {
        return buf;
      }
      // Truncated (an interrupted first write) — regenerating is right: there is
      // nothing decryptable under a half-written key anyway.
    } catch {
      // not created yet
    }
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    await chmod(this.dir, DIR_MODE).catch(() => {});
    const key = randomBytes(KEY_BYTES);
    try {
      // "wx" — fail if it already exists. Two windows of the same editor can
      // race here; the loser must adopt the winner's key rather than overwrite
      // it, or the winner's freshly written secret becomes undecryptable.
      await writeFile(file, key, { mode: FILE_MODE, flag: "wx" });
    } catch {
      const existing = await readFile(file).catch(() => undefined);
      if (existing && existing.length >= KEY_BYTES) {
        return existing;
      }
      await writeFile(file, key, { mode: FILE_MODE });
    }
    await chmod(file, FILE_MODE).catch(() => {});
    return key;
  }
}
