import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CliProvider } from "../src/ai/cliProvider";

// A CLI that writes more to stderr than a pipe holds (codex exec puts its
// progress there) blocked on the full pipe while nothing read it, and the
// request never ended. The extension does not read stderr, so it must not
// pipe it.
test("a CLI that writes a lot to stderr still answers", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-cli-stderr-"));
  const savedPath = process.env.PATH;
  try {
    const cli = join(dir, "codex");
    writeFileSync(
      cli,
      `#!/bin/sh\ncat >/dev/null\nhead -c 300000 /dev/zero | tr '\\0' x >&2\necho answer\n`,
    );
    chmodSync(cli, 0o755);
    process.env.PATH = `${dir}:/usr/bin:/bin`;
    const provider = new CliProvider({ agent: "codex", cwd: () => dir, model: () => undefined });
    const abort = new AbortController();
    const watchdog = setTimeout(() => abort.abort(), 10_000);
    const answer = await provider.complete({ prompt: "hello", signal: abort.signal } as never);
    clearTimeout(watchdog);
    assert.equal(abort.signal.aborted, false, "the request ended by itself, not by the watchdog");
    assert.equal(answer, "answer");
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
