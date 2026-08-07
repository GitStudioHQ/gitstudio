import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "../src/secretStore";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "gitstudio-secrets-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const KEY = "gitstudio.ai.anthropicKey";

test("round-trips a secret", async () => {
  await withDir(async (dir) => {
    const store = new SecretStore(dir);
    assert.equal(store.has(KEY), false);
    assert.equal(await store.get(KEY), undefined);

    await store.set(KEY, "sk-ant-secret-value");
    assert.equal(store.has(KEY), true);
    assert.equal(await store.get(KEY), "sk-ant-secret-value");
  });
});

test("survives a fresh instance — the value is on disk, not just cached", async () => {
  await withDir(async (dir) => {
    await new SecretStore(dir).set(KEY, "persisted");
    const reopened = new SecretStore(dir);
    assert.equal(reopened.has(KEY), true);
    assert.equal(await reopened.get(KEY), "persisted");
  });
});

test("never writes the plaintext to disk", async () => {
  await withDir(async (dir) => {
    const store = new SecretStore(dir);
    await store.set(KEY, "sk-ant-PLAINTEXT-MARKER");
    for (const entry of await readdir(dir)) {
      const bytes = await readFile(join(dir, entry));
      assert.ok(
        !bytes.toString("utf8").includes("PLAINTEXT-MARKER"),
        `${entry} contains the plaintext secret`,
      );
    }
  });
});

test("secret blobs and the device key are owner-only", async () => {
  await withDir(async (dir) => {
    await new SecretStore(dir).set(KEY, "v");
    for (const entry of await readdir(dir)) {
      const st = await stat(join(dir, entry));
      assert.equal(
        st.mode & 0o077,
        0,
        `${entry} is readable or writable by group/other`,
      );
    }
  });
});

test("has() answers without decrypting — a wiped device key still reports present", async () => {
  await withDir(async (dir) => {
    await new SecretStore(dir).set(KEY, "v");
    // A profile copied from another machine: ciphertext present, wrong key.
    await writeFile(join(dir, "device.key"), Buffer.alloc(32, 7));
    const store = new SecretStore(dir);
    assert.equal(store.has(KEY), true);
    // ...and reading degrades to "unset" rather than throwing at the caller.
    assert.equal(await store.get(KEY), undefined);
  });
});

test("delete() forgets the value and the file", async () => {
  await withDir(async (dir) => {
    const store = new SecretStore(dir);
    await store.set(KEY, "v");
    await store.delete(KEY);
    assert.equal(store.has(KEY), false);
    assert.equal(await store.get(KEY), undefined);
    await store.delete(KEY); // idempotent
  });
});

test("set() overwrites a previous value", async () => {
  await withDir(async (dir) => {
    const store = new SecretStore(dir);
    await store.set(KEY, "first");
    await store.set(KEY, "second");
    assert.equal(await store.get(KEY), "second");
    assert.equal(await new SecretStore(dir).get(KEY), "second");
  });
});

test("names() lists stored secrets", async () => {
  await withDir(async (dir) => {
    const store = new SecretStore(dir);
    await store.set("alpha", "1");
    await store.set("beta", "2");
    assert.deepEqual((await store.names()).sort(), ["alpha", "beta"]);
  });
});

test("concurrent first writes share one device key", async () => {
  await withDir(async (dir) => {
    const store = new SecretStore(dir);
    await Promise.all([
      store.set("alpha", "1"),
      store.set("beta", "2"),
      store.set("gamma", "3"),
    ]);
    const reopened = new SecretStore(dir);
    assert.equal(await reopened.get("alpha"), "1");
    assert.equal(await reopened.get("beta"), "2");
    assert.equal(await reopened.get("gamma"), "3");
  });
});

test("tampered ciphertext fails authentication instead of returning garbage", async () => {
  await withDir(async (dir) => {
    const store = new SecretStore(dir);
    await store.set(KEY, "authentic");
    const file = join(dir, `${KEY}.secret`);
    const env = JSON.parse(await readFile(file, "utf8")) as { data: string };
    const bytes = Buffer.from(env.data, "base64");
    bytes[0] ^= 0xff;
    await writeFile(
      file,
      JSON.stringify({ ...env, data: bytes.toString("base64") }),
    );
    assert.equal(await new SecretStore(dir).get(KEY), undefined);
  });
});

test("rejects secret names that could escape the directory", async () => {
  await withDir(async (dir) => {
    const store = new SecretStore(dir);
    for (const bad of ["../escape", "a/b", "", "with space"]) {
      assert.throws(() => store.has(bad), /Invalid secret name/);
      await assert.rejects(() => store.set(bad, "v"), /Invalid secret name/);
    }
  });
});
