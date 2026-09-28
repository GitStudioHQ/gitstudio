// A probe body, handed to the harness page as a FILE beside it.
//
// The page used to take the body itself in ?probe= and run it through
// new Function — code read out of the URL. Now a tool writes the body to
// <page>/probes/<id>.js, as the function the page calls, and the URL only
// names it: ?probe=<id>. The shim loads that one file, and a URL can name a
// file this harness wrote, never carry code of its own. The body still runs
// exactly as before: strict, async, `await` available, its return value
// JSON-printed in the title.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

/**
 * Writes `body` beside `page` (the harness.html path). `param` goes in the URL
 * as ?probe=; call `cleanup()` once Chrome has answered.
 * @param {string} page
 * @param {string} body
 */
export function probeFile(page, body) {
  const dir = join(dirname(page), "probes");
  mkdirSync(dir, { recursive: true });
  // Many launches run at once (contrast, fit, affordance): one file each.
  const id = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const file = join(dir, `${id}.js`);
  // The same wrapper new Function gave it: a strict function called bare
  // (`this` is undefined), running the body as an async arrow.
  const src = `window.__gsProbe = function () {\n"use strict";\nreturn (async () => {\n${body}\n})();\n};\n`;
  // Compiled here, never run: a page reports a file:// script that does not
  // parse only as "Script error.", so the parser's own words come from here.
  new Script(src, { filename: "probe body" });
  writeFileSync(file, src);
  return { param: id, cleanup: () => rmSync(file, { force: true }) };
}
