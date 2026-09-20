// Issue #25 ("GitStudio conflicts with Pylance": Rename Symbol updates the
// definition, not the usages) — the A/B driver. Runs inside the extension host
// via --extensionTestsPath, with or without GitStudio in the extensions dir.
//
// Env:
//   GSQA_OUT       file to append the log + final SUMMARY json to
//   GSQA_SCENARIO  plain      one editor, clean tree
//                  busy       dirty tree (unstaged + staged + unsaved), blame annotations
//                             on, Changes view focused, commit panel shown
//                  open       usage files open in tabs (one dirty), blame annotations on
//                  diffeditor rename from the modified pane of the product's own diff
//                             (gitstudio.openChanges / git.openChange)
//                  autosave   busy + files.autoSave=afterDelay(100ms)
//   GSQA_MODE      provider   vscode.executeDocumentRenameProvider + applyEdit({isRefactoring})
//                  ui         the real widget: editor.action.rename here, keystrokes from
//                             uikeys.mjs over CDP, then observe
//   GSQA_MARKS     directory for the ui-mode marker files (ready / keys-sent)
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const OUT = process.env.GSQA_OUT;
const SCENARIO = process.env.GSQA_SCENARIO || "plain";
const MODE = process.env.GSQA_MODE || "provider";
const MARKS = process.env.GSQA_MARKS || path.dirname(OUT);
const OLD = "MAX_RETRIES";
const NEW = "MAX_ATTEMPTS";
const PY_FILES = [
  "app/config.py",
  "app/service.py",
  "app/worker.py",
  "app/cli.py",
  "main.py",
  "tests/test_config.py",
];

const t0 = Date.now();
function log(m) {
  const line = `[${String(Date.now() - t0).padStart(6)}ms] ${m}`;
  fs.appendFileSync(OUT, line + "\n");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function git(root, args) {
  return cp.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function countOnDisk(root) {
  const res = {};
  for (const rel of PY_FILES) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    res[rel] = { old: (text.match(new RegExp(OLD, "g")) || []).length, new: (text.match(new RegExp(NEW, "g")) || []).length };
  }
  return res;
}

function summarizeEdit(edit) {
  if (!edit) return null;
  const out = {};
  for (const [uri, edits] of edit.entries()) {
    out[vscode.workspace.asRelativePath(uri)] = edits.length;
  }
  return out;
}

async function activateExt(id) {
  const ext = vscode.extensions.getExtension(id);
  if (!ext) {
    log(`extension ${id}: NOT INSTALLED`);
    return undefined;
  }
  if (!ext.isActive) {
    try {
      await ext.activate();
    } catch (e) {
      log(`extension ${id}: activate threw ${e && e.message}`);
    }
  }
  log(`extension ${id}@${ext.packageJSON.version}: active=${ext.isActive}`);
  return ext;
}

async function prepareScenario(root, configUri) {
  const hasGs = !!vscode.extensions.getExtension("gitstudio.gitstudio");
  if (SCENARIO === "busy" || SCENARIO === "autosave") {
    // A dirty tree: a saved-unstaged edit, a staged edit, and an UNSAVED edit in
    // the definition file — so blame, the staged gutter and the Changes view
    // all have real work to do around the rename.
    fs.appendFileSync(path.join(root, "app/service.py"), "\n\n# unstaged edit\n");
    fs.appendFileSync(path.join(root, "app/worker.py"), "\n\n# staged edit\n");
    git(root, ["add", "app/worker.py"]);
    log(`git status:\n${git(root, ["status", "--short"])}`);
  }
  if (SCENARIO === "autosave") {
    await vscode.workspace
      .getConfiguration("files")
      .update("autoSave", "afterDelay", vscode.ConfigurationTarget.Workspace);
    await vscode.workspace
      .getConfiguration("files")
      .update("autoSaveDelay", 100, vscode.ConfigurationTarget.Workspace);
    log("files.autoSave=afterDelay(100ms)");
  }

  let editor;
  if (SCENARIO === "diffeditor") {
    // Rename from inside the modified pane of the diff editor each product opens
    // from its changes list. GitStudio's left side is a gitstudio-revision: doc;
    // vscode.git's is a git: doc.
    fs.appendFileSync(path.join(root, "app/config.py"), "\n\n# unstaged edit\n");
    // Both products discover the repo in the background; retry until the diff
    // actually opens (its modified pane becomes the active text editor).
    // gitstudio.openChanges reads the ACTIVE editor's file, so open it first.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(configUri));
    for (let i = 0; i < 10; i++) {
      await sleep(1500);
      if (hasGs) {
        await vscode.commands.executeCommand("gitstudio.openChanges", configUri);
      } else {
        await vscode.commands.executeCommand("git.openChange", configUri);
      }
      await sleep(1500);
      editor = vscode.window.activeTextEditor;
      const diffTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const isDiff = diffTab && diffTab.input && diffTab.input.constructor && diffTab.input.constructor.name === "TabInputTextDiff";
      if (isDiff && editor && editor.document.uri.toString() === configUri.toString()) {
        log(`opened ${hasGs ? "GitStudio diff (gitstudio.openChanges)" : "vscode.git diff (git.openChange)"} after ${i + 1} attempt(s)`);
        break;
      }
    }
    log(`visible editors: ${JSON.stringify(vscode.window.visibleTextEditors.map((e) => e.document.uri.toString().replace(root, "")))}`);
    log(`tabs: ${JSON.stringify(vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label + ":" + (t.input && t.input.constructor && t.input.constructor.name))))}`);
    log(`active editor after diff open: ${editor && editor.document.uri.toString()} viewColumn=${editor && editor.viewColumn}`);
    if (!editor || editor.document.uri.toString() !== configUri.toString()) {
      const doc = await vscode.workspace.openTextDocument(configUri);
      editor = await vscode.window.showTextDocument(doc);
      log("fell back to a plain editor for config.py");
    }
  } else if (SCENARIO === "open") {
    // Usage files open in tabs (some dirty), blame annotations on everywhere,
    // then rename from the definition file. Edits to visible editors go through
    // the editor path rather than background models.
    fs.appendFileSync(path.join(root, "app/service.py"), "\n\n# unstaged edit\n");
    for (const rel of ["app/service.py", "app/worker.py", "main.py", "tests/test_config.py"]) {
      const d = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, rel)));
      const e = await vscode.window.showTextDocument(d, { preview: false });
      if (rel === "main.py") {
        const we = new vscode.WorkspaceEdit();
        we.insert(d.uri, new vscode.Position(d.lineCount, 0), "\n# wip (unsaved)\n");
        await vscode.workspace.applyEdit(we);
      }
      if (hasGs && rel === "app/service.py") {
        await vscode.commands.executeCommand("gitstudio.toggleFileBlame");
      }
      await sleep(600);
      void e;
    }
    const doc = await vscode.workspace.openTextDocument(configUri);
    editor = await vscode.window.showTextDocument(doc, { preview: false });
    await sleep(2500);
    log(`open scenario: visible=${vscode.window.visibleTextEditors.length} tabs=${vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label)).join(",")}`);
  } else {
    const doc = await vscode.workspace.openTextDocument(configUri);
    editor = await vscode.window.showTextDocument(doc);
  }

  if (SCENARIO === "busy" || SCENARIO === "autosave") {
    // Unsaved edit in the definition file (a WIP line at the end).
    const doc = editor.document;
    const we = new vscode.WorkspaceEdit();
    we.insert(configUri, new vscode.Position(doc.lineCount, 0), "\n# wip (unsaved)\n");
    await vscode.workspace.applyEdit(we);
    log(`config.py dirty=${doc.isDirty} version=${doc.version}`);
    if (hasGs) {
      await vscode.commands.executeCommand("gitstudio.commit.focus");
      await vscode.commands.executeCommand("gitstudio.showCommitPanel");
      await vscode.commands.executeCommand("gitstudio.toggleFileBlame");
      log("GitStudio: Changes view focused, commit panel shown, blame annotations toggled ON");
      await sleep(2500);
      // Focus back on the definition editor so the rename targets it.
      editor = await vscode.window.showTextDocument(editor.document, editor.viewColumn);
    }
  }
  return editor;
}

async function run() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) throw new Error("no workspace folder");
  const root = folder.uri.fsPath;
  log(`scenario=${SCENARIO} mode=${MODE} root=${root} vscode=${vscode.version}`);
  log(
    "third-party extensions: " +
      vscode.extensions.all
        .filter((e) => !e.id.startsWith("vscode."))
        .map((e) => `${e.id}@${e.packageJSON.version}${e.isActive ? "*" : ""}`)
        .join(", "),
  );

  await activateExt("ms-python.python");
  await activateExt("ms-python.vscode-pylance");
  const gs = vscode.extensions.getExtension("gitstudio.gitstudio");
  if (gs) {
    // onStartupFinished activation — give it a moment, then confirm.
    for (let i = 0; i < 40 && !gs.isActive; i++) await sleep(250);
    log(`extension gitstudio.gitstudio@${gs.packageJSON.version}: active=${gs.isActive}`);
  } else {
    log("extension gitstudio.gitstudio: NOT INSTALLED (control run)");
  }

  const configUri = vscode.Uri.file(path.join(root, "app/config.py"));
  const editor = await prepareScenario(root, configUri);
  const doc = editor.document;
  const defLine = doc.getText().split("\n").findIndex((l) => l.startsWith(`${OLD} = `));
  const pos = new vscode.Position(defLine, 2);
  editor.selection = new vscode.Selection(pos, pos);
  log(`definition at line ${defLine}; cursor placed; doc.version=${doc.version} dirty=${doc.isDirty}`);

  // Wait for Pylance to be able to answer at all, then for the answer to be
  // stable (indexing brings more files in over time).
  let last = null;
  let stable = 0;
  let firstAt = null;
  const polls = [];
  for (let i = 0; i < 150; i++) {
    let edit;
    try {
      edit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", configUri, pos, NEW);
    } catch (e) {
      edit = undefined;
      if (i % 10 === 0) log(`poll ${i}: provider threw: ${e && e.message}`);
    }
    const sum = summarizeEdit(edit);
    const key = JSON.stringify(sum);
    polls.push(sum ? Object.keys(sum).length : 0);
    if (sum && Object.keys(sum).length > 0) {
      if (firstAt === null) {
        firstAt = Date.now() - t0;
        log(`poll ${i}: first answer ${key}`);
      }
      if (key === last) stable++;
      else {
        stable = 0;
        log(`poll ${i}: ${key}`);
      }
      last = key;
      if (stable >= 8) break;
    }
    await sleep(1000);
  }
  const providerResult = last ? JSON.parse(last) : null;
  log(`provider result (stable): ${last}`);

  const before = countOnDisk(root);
  let applied = null;
  let uiRenameSeen = false;
  if (MODE === "provider") {
    const edit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", configUri, pos, NEW);
    const started = Date.now();
    // isRefactoring:true is what makes the bulk-edit service honour
    // files.refactoring.autoSave, exactly as the F2 rename does (respectAutoSaveConfig).
    applied = await vscode.workspace.applyEdit(edit, { isRefactoring: true });
    log(`workspace.applyEdit(isRefactoring) -> ${applied} in ${Date.now() - started}ms`);
    const dirtyNow = vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => vscode.workspace.asRelativePath(d.uri));
    log(`dirty right after applyEdit: ${JSON.stringify(dirtyNow)}`);
    log(`on disk right after applyEdit: ${JSON.stringify(countOnDisk(root))}`);
  } else {
    // UI mode: hand over to the CDP script (F2, type, Enter) and watch.
    const ready = path.join(MARKS, "ready");
    const done = path.join(MARKS, "keys-sent");
    fs.writeFileSync(ready, JSON.stringify({ line: defLine, active: vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.toString() }));
    log("ui: wrote ready marker, opening the rename widget (editor.action.rename), waiting for keystrokes");
    let renameOutcome = "pending";
    const renamePromise = vscode.commands
      .executeCommand("editor.action.rename")
      .then(() => (renameOutcome = "resolved"), (e) => (renameOutcome = "rejected: " + (e && e.message)));
    for (let i = 0; i < 120 && !fs.existsSync(done); i++) await sleep(500);
    log(`ui: keys-sent marker ${fs.existsSync(done) ? "seen" : "NOT seen (timeout)"}`);
    // Wait for the rename to land in the active document (or give up).
    for (let i = 0; i < 60; i++) {
      if (doc.getText().includes(NEW)) {
        uiRenameSeen = true;
        break;
      }
      await sleep(500);
    }
    log(`ui: definition document contains ${NEW}: ${uiRenameSeen} (dirty=${doc.isDirty})`);
    await Promise.race([renamePromise, sleep(5000)]);
    log(`ui: editor.action.rename outcome: ${renameOutcome}`);
    await sleep(3000);
  }
  await sleep(1500);
  const after = countOnDisk(root);
  const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => vscode.workspace.asRelativePath(d.uri));
  log(`dirty documents after: ${JSON.stringify(dirty)}`);
  const open = vscode.workspace.textDocuments.map((d) => d.uri.scheme + ":" + vscode.workspace.asRelativePath(d.uri));
  log(`open text documents: ${JSON.stringify(open)}`);
  log(`on disk after: ${JSON.stringify(after)}`);

  // Diagnostics settle: this is the "later about a non-existent variable" signal.
  await sleep(8000);
  const diags = {};
  for (const [uri, list] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file" || !uri.fsPath.endsWith(".py")) continue;
    const msgs = list.filter((d) => d.severity <= 1).map((d) => d.message);
    if (msgs.length) diags[vscode.workspace.asRelativePath(uri)] = msgs;
  }
  log(`error diagnostics: ${JSON.stringify(diags)}`);
  log(`git status after:\n${git(root, ["status", "--short"])}`);

  const summary = {
    scenario: SCENARIO,
    mode: MODE,
    gitstudio: gs ? gs.packageJSON.version : null,
    firstAnswerMs: firstAt,
    polls,
    providerResult,
    applied,
    uiRenameSeen,
    before,
    after,
    dirty,
    diags,
  };
  fs.appendFileSync(OUT, "SUMMARY " + JSON.stringify(summary) + "\n");
}

exports.run = async () => {
  try {
    await run();
  } catch (e) {
    log(`FATAL ${e && e.stack}`);
    throw e;
  }
};
