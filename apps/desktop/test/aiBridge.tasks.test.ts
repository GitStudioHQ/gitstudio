// The one-shot ✨ tasks (ai:task): which diff or history each task reads from
// the REAL repository, what reaches the model, what streams back to the
// renderer, and the message a user sees when there is nothing to do or the
// model fails.
//
// The repository is a real throwaway one; the model is a fake fetch
// (aiBridge.harness.ts) and a local CLI a scripted FakeChild — no network, no
// real `claude`.

import { onNextSpawn, resetSpawns, spawned } from "./aiBridge.fakes";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAll, fakeModel, freshUserData, makeBridge, makeRepo, promptText, sse, type FakeModel } from "./aiBridge.harness";

let model: FakeModel;
beforeEach(() => {
  freshUserData();
  model = fakeModel();
  resetSpawns();
});
afterEach(() => {
  model.restore();
  cleanupAll();
});

/** A bridge on a fresh repo with one local (keyless) OpenAI-compatible model. */
async function setup() {
  const repo = makeRepo();
  const b = await makeBridge(repo.root);
  const connId = (await b.bridge.addConnection("ollama")).connections[0].id;
  return { ...repo, ...b, connId };
}

test("a commit message is drafted from the STAGED diff, in the style of recent subjects", async () => {
  const { bridge, root, git, sent } = await setup();
  writeFileSync(join(root, "a.txt"), "alpha\nbeta-staged\n");
  git("add", "a.txt");
  writeFileSync(join(root, "a.txt"), "alpha\nbeta-staged\ngamma-unstaged\n");
  model.replies.push({ content: "feat: add beta" });

  const r = await bridge.runTask("r1", "commitMessage", {});
  assert.deepEqual(r, { requestId: "r1", ok: true, text: "feat: add beta" });
  const prompt = promptText(model.chats[0]);
  assert.match(prompt, /\+beta-staged/, "the staged change is what is described");
  assert.ok(!prompt.includes("gamma-unstaged"), "an unstaged change is not");
  assert.match(prompt, /- initial/, "recent subjects set the tone");
  assert.equal(model.chats[0].body.model, "llama3.2", "a commit message uses the fast model");
  assert.deepEqual(
    sent.filter((s) => s.event === "ai:delta").map((s) => s.data),
    [{ requestId: "r1", delta: "feat: add beta" }],
    "the answer streams to the renderer under its request id",
  );
});

test("a streamed answer reaches the renderer chunk by chunk", async () => {
  const { bridge, sent } = await setup();
  model.streams.push(sse(["Rebase ", "rewrites ", "history."]));
  const r = await bridge.runTask("rs", "assist", { description: "what is rebase" });
  assert.deepEqual(r, { requestId: "rs", ok: true, text: "Rebase rewrites history." });
  assert.deepEqual(
    sent.filter((s) => s.event === "ai:delta").map((s) => s.data.delta),
    ["Rebase ", "rewrites ", "history."],
  );
  assert.equal(model.all[0].body.stream, true);
});

test("with nothing staged there is nothing to summarize — and the model is not asked", async () => {
  const { bridge, root } = await setup();
  writeFileSync(join(root, "a.txt"), "unstaged only\n");
  const r = await bridge.runTask("r", "commitMessage", {});
  assert.deepEqual(r, { requestId: "r", ok: false, expected: true, message: "Nothing is staged to summarize." });
  assert.equal(model.chats.length, 0);
});

test("a diff and subjects handed in by the caller are used as given", async () => {
  const { bridge } = await setup();
  model.replies.push({ content: "fix: thing" });
  const r = await bridge.runTask("r", "commitMessage", { diff: "+handed-in line", commits: ["style: earlier"] });
  assert.equal(r.text, "fix: thing");
  const prompt = promptText(model.chats[0]);
  assert.match(prompt, /handed-in line/);
  assert.match(prompt, /- style: earlier/);
});

test("Explain on a commit reads that commit's own diff against its parent", async () => {
  const { bridge, root, git } = await setup();
  writeFileSync(join(root, "b.txt"), "second file\n");
  git("add", "b.txt");
  git("commit", "-qm", "add b");
  const sha = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "a.txt"), "working-tree edit\n");
  model.replies.push({ content: "It adds b.txt." });
  const r = await bridge.runTask("r", "explainDiff", { sha });
  assert.equal(r.text, "It adds b.txt.");
  const prompt = promptText(model.chats[0]);
  assert.match(prompt, /\+second file/);
  assert.ok(!prompt.includes("working-tree edit"));
  assert.equal(model.chats[0].body.model, "qwen2.5-coder", "explaining uses the mid model");
});

test("Explain on a base…head comparison reads exactly that range, optionally one file", async () => {
  const { bridge, root, git } = await setup();
  git("branch", "base");
  writeFileSync(join(root, "a.txt"), "alpha\nfrom-head\n");
  writeFileSync(join(root, "c.txt"), "other file\n");
  git("add", "-A");
  git("commit", "-qm", "head change");
  git("checkout", "-q", "-b", "elsewhere", "base");
  model.replies.push({ content: "x" }, { content: "y" });

  await bridge.runTask("r", "explainDiff", { base: "base", head: "main" });
  assert.match(promptText(model.chats[0]), /\+from-head[\s\S]*\+other file/, "the explicit head, not HEAD");

  await bridge.runTask("r2", "explainDiff", { base: "base", head: "main", path: "c.txt" });
  const p = promptText(model.chats[1]);
  assert.match(p, /\+other file/);
  assert.ok(!p.includes("from-head"), "the path limits the diff");
});

test("Explain with no target reads the working tree, and the staged diff when that is empty", async () => {
  const { bridge, root, git } = await setup();
  writeFileSync(join(root, "a.txt"), "alpha\nworking\n");
  model.replies.push({ content: "w" }, { content: "s" });
  await bridge.runTask("r", "explainDiff", {});
  assert.match(promptText(model.chats[0]), /\+working/);

  git("add", "a.txt");
  await bridge.runTask("r2", "explainDiff", {});
  assert.match(promptText(model.chats[1]), /\+working/, "all of it staged now: falls back to the index");
});

test("each diff task refuses a clean tree without asking the model", async () => {
  const { bridge } = await setup();
  const cases: [Parameters<typeof bridge.runTask>[1], string][] = [
    ["explainDiff", "No changes to explain."],
    ["summarizeChanges", "No changes to summarize."],
    ["reviewDiff", "No changes to review."],
  ];
  for (const [task, message] of cases) {
    assert.deepEqual(await bridge.runTask("r", task, {}), { requestId: "r", ok: false, expected: true, message });
  }
  assert.equal(model.chats.length, 0);
});

test("Summarize and Review send the changes; Review uses the deep model", async () => {
  const { bridge, root } = await setup();
  writeFileSync(join(root, "a.txt"), "alpha\nrisky change\n");
  model.replies.push({ content: "- one change" }, { content: "Looks safe." });
  assert.equal((await bridge.runTask("s", "summarizeChanges", {})).text, "- one change");
  assert.equal((await bridge.runTask("v", "reviewDiff", {})).text, "Looks safe.");
  assert.match(promptText(model.chats[0]), /\+risky change/);
  assert.match(promptText(model.chats[1]), /reviewing the following diff[\s\S]*\+risky change/);
  assert.equal(model.chats[1].body.model, "qwen2.5-coder:32b");
});

test("a PR description reads the branch's commits and diff against its base", async () => {
  const { bridge, root, git } = await setup();
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "f.txt"), "feature work\n");
  git("add", "-A");
  git("commit", "-qm", "feat: the feature");
  model.replies.push({ content: "## Title" });
  const r = await bridge.runTask("r", "prDescription", {});
  assert.equal(r.text, "## Title");
  const prompt = promptText(model.chats[0]);
  assert.match(prompt, /feat: the feature/, "the commits since main");
  assert.ok(!prompt.includes("initial"), "not the ones main already has");
  assert.match(prompt, /\+feature work/);
});

test("a PR description with caller-supplied commits does not walk the history", async () => {
  const { bridge } = await setup();
  model.replies.push({ content: "ok" });
  await bridge.runTask("r", "prDescription", { commits: ["given subject"], diff: "+given diff", base: "whatever" });
  const prompt = promptText(model.chats[0]);
  assert.match(prompt, /given subject/);
  assert.match(prompt, /given diff/);
});

test("release notes list the subjects since the base, or the whole history without one", async () => {
  const { bridge, root, git } = await setup();
  git("tag", "v1");
  writeFileSync(join(root, "n.txt"), "n\n");
  git("add", "-A");
  git("commit", "-qm", "fix: after the tag");
  model.replies.push({ content: "notes 1" }, { content: "notes 2" });
  await bridge.runTask("r", "changelog", { base: "v1" });
  const since = promptText(model.chats[0]);
  assert.match(since, /- fix: after the tag/);
  assert.ok(!since.includes("- initial"));
  await bridge.runTask("r", "changelog", {});
  assert.match(promptText(model.chats[1]), /- fix: after the tag\n- initial/);
});

test("branch-name and free-form assist tasks send the user's description", async () => {
  const { bridge } = await setup();
  model.replies.push({ content: "fix/login-timeout" }, { content: "Here is how." });
  assert.equal((await bridge.runTask("r", "branchName", { description: "login times out" })).text, "fix/login-timeout");
  assert.match(promptText(model.chats[0]), /login times out/);
  assert.equal((await bridge.runTask("r", "assist", { description: "how do I squash?" })).text, "Here is how.");
  assert.match(promptText(model.chats[1]), /how do I squash\?/);
});

test("a task the bridge does not know is refused by name", async () => {
  const { bridge } = await setup();
  const r = await bridge.runTask("r", "noSuchTask" as never, {});
  assert.deepEqual(r, { requestId: "r", ok: false, message: "Unknown task: noSuchTask" });
});

test("an empty answer is reported, not shown as a blank result", async () => {
  const { bridge } = await setup();
  model.streams.push(sse(["  ", " \n"]));
  assert.deepEqual(await bridge.runTask("r", "assist", { description: "q" }), {
    requestId: "r",
    ok: false,
    message: "The model returned nothing.",
  });
});

test("a failing model request reaches the user as the provider's message", async () => {
  const { bridge } = await setup();
  model.replies.push(new Response("boom", { status: 500 }));
  const r = await bridge.runTask("r", "assist", { description: "q" });
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /localhost:11434 request failed \(HTTP 500\)/);
});

test("with no usable model the task says where to add one", async () => {
  const repo = makeRepo();
  const { bridge } = await makeBridge(repo.root);
  const none = await bridge.runTask("r", "assist", { description: "q" });
  assert.deepEqual(none, { requestId: "r", ok: false, expected: true, message: "No AI model is connected. Add one in Settings ▸ AI." });

  await bridge.addConnection("openai"); // needs a key it does not have
  assert.equal((await bridge.runTask("r", "assist", { description: "q" })).message, none.message);
  assert.equal(model.all.length, 0);
});

test("with no repository open the task says so", async () => {
  const { bridge } = await makeBridge();
  await bridge.addConnection("ollama");
  assert.deepEqual(await bridge.runTask("r", "assist", { description: "q" }), {
    requestId: "r",
    ok: false,
    expected: true,
    message: "No repository is open.",
  });
});

test("a task can be pointed at a specific connection", async () => {
  const { bridge } = await setup();
  const lm = (await bridge.addConnection("lmstudio")).connections[1].id;
  model.replies.push({ content: "from lm studio" });
  const r = await bridge.runTask("r", "assist", { description: "q", connectionId: lm });
  assert.equal(r.text, "from lm studio");
  assert.equal(model.chats[0].url, "http://localhost:1234/v1/chat/completions");
});

test("cancelling a task aborts the model request", async () => {
  const { bridge } = await setup();
  model.replies.push(
    (req) =>
      new Promise((_, reject) => {
        req.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
  const pending = bridge.runTask("r-cancel", "assist", { description: "slow" });
  await (await import("./aiBridge.fakes")).until(() => model.chats.length === 1, "the request to be in flight");
  bridge.cancel("r-cancel");
  const r = await pending;
  assert.equal(model.chats[0].signal?.aborted, true);
  assert.deepEqual(r, { requestId: "r-cancel", ok: false, message: "Request cancelled." });
  bridge.cancel("r-cancel"); // a second cancel of a finished request is harmless
});

test("a local CLI connection runs the task through the CLI, inside the open repository", async () => {
  const repo = makeRepo();
  const { bridge, sent } = await makeBridge(repo.root);
  await bridge.addConnection("claude-code");
  onNextSpawn((c) => {
    c.json({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "cli says hi" } } });
    void c.exit(0);
  });
  const r = await bridge.runTask("r", "assist", { description: "hello cli" });
  assert.deepEqual(r, { requestId: "r", ok: true, text: "cli says hi" });
  const c = spawned[0];
  assert.equal(c.command, "claude");
  assert.ok(c.options?.cwd && /gs-ai-repo-/.test(c.options.cwd), "the repository is the CLI's working directory");
  assert.ok(c.args.includes("--model") && c.args[c.args.indexOf("--model") + 1] === "sonnet", "the mid tier");
  assert.match(c.args.at(-1)!, /hello cli/);
  assert.deepEqual(sent.filter((s) => s.event === "ai:delta").map((s) => s.data.delta), ["cli says hi"]);
  assert.equal(model.all.length, 0, "no HTTP at all");
});
