import { test } from "node:test";
import assert from "node:assert/strict";
import { describeNoText } from "../src/noTextPanel";
import { shapeWord } from "../src/conflicts/opText";

// What the panel that replaces the three panes says, per shape. The verifier
// found a submodule conflict called "Conflicted binary file".

const base = { path: "vendor/lib", yoursLabel: "Yours", theirsLabel: "Theirs" };

test("a submodule is a submodule (a gitlink), with the two commits its sides point at", () => {
  const d = describeNoText({
    ...base,
    shape: "submodule",
    commits: { yours: "1c34b25aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", theirs: "9d20bedbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  });
  assert.equal(d.title, "Conflicted submodule");
  assert.doesNotMatch(`${d.title} ${d.detail}`, /binary/i);
  assert.match(d.detail, /is a submodule \(a gitlink\)/);
  assert.match(d.detail, /yours at 1c34b25, theirs at 9d20bed/);
  assert.match(d.detail, /git submodule update/);
});

test("a symbolic link is a link, not a binary file", () => {
  const d = describeNoText({ ...base, path: "links/current", shape: "symlink" });
  assert.equal(d.title, "Conflicted symbolic link");
  assert.doesNotMatch(`${d.title} ${d.detail}`, /binary/i);
});

test("a binary file is still said to be one", () => {
  assert.equal(describeNoText({ ...base, path: "logo.bin", shape: "binary" }).title, "Conflicted binary file");
});

test("the dashboard's word for each link row", () => {
  assert.equal(shapeWord("submodule"), "submodule");
  assert.equal(shapeWord("symlink"), "symbolic link");
});
