// Drives the REAL rename widget over CDP: waits for the driver's "ready" marker
// (the driver has already run editor.action.rename, i.e. F2), waits for the widget
// to be visible, types the new name, presses Enter, writes the "keys-sent" marker,
// then watches for notification toasts. A screenshot of the workbench at the
// ready marker lands in $GSQA_DIR/out/shot-<tag>.png as evidence of what was on
// screen. Usage: node uikeys.mjs <port> <marksDir> <newName>
import fs from "node:fs";
import path from "node:path";

const [port, marks, newName] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[uikeys ${new Date().toISOString().slice(11, 23)}] ${m}`);

async function targets() {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}

async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await targets();
      const page = list.find((t) => t.type === "page" && /workbench/.test(t.url));
      if (page) return new WebSocket(page.webSocketDebuggerUrl);
    } catch {}
    await sleep(1000);
  }
  throw new Error("no workbench target");
}

const ws = await connect();
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;

log("connected to workbench");
const ready = path.join(marks, "ready");
for (let i = 0; i < 600 && !fs.existsSync(ready); i++) await sleep(500);
if (!fs.existsSync(ready)) throw new Error("driver never became ready");
log(`ready marker: ${fs.readFileSync(ready, "utf8")}`);
await sleep(1000);

{
  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot.result && shot.result.data) fs.writeFileSync(path.join(marks, "..", "out", `shot-${process.env.GSQA_TAG || "run"}.png`), Buffer.from(shot.result.data, "base64"));
}
const focused = await evaluate("document.activeElement && (document.activeElement.className + '|' + document.activeElement.tagName)");
log(`focused at ready: ${focused}`);

// The driver opens the widget via editor.action.rename; wait until it is visible.
let widget = false;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  const vis = await evaluate("(() => { const el = document.querySelector('.rename-box'); if (!el) return 'none'; const cs = getComputedStyle(el); return el.className + ' display=' + cs.display + ' vis=' + cs.visibility; })()");
  if (i % 8 === 0) log(`rename widget: ${vis}`);
  if (/vis=visible/.test(vis)) { widget = true; break; }
}
log(`rename widget open: ${widget}; focused: ${await evaluate("document.activeElement && (document.activeElement.className + '|' + document.activeElement.tagName + '|' + (document.activeElement.value||'').slice(0,40))")}`);
if (!widget) { fs.writeFileSync(path.join(marks, "keys-sent"), "widget-never-opened"); log("widget never opened; aborting"); ws.close(); process.exit(2); }
await sleep(300);
// The widget pre-selects the current name; select-all then insert to be sure.
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 4, windowsVirtualKeyCode: 65, commands: ["selectAll"] });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 4, windowsVirtualKeyCode: 65 });
await send("Input.insertText", { text: newName });
await sleep(300);
log(`input now: ${await evaluate("document.activeElement && (document.activeElement.value || document.activeElement.textContent || '').slice(0,60)")}`);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
fs.writeFileSync(path.join(marks, "keys-sent"), new Date().toISOString());
log("Enter sent; keys-sent marker written");
// Watch for notifications (the "Rename failed…" toasts) for a while.
for (let i = 0; i < 20; i++) {
  await sleep(1000);
  const toasts = await evaluate("Array.from(document.querySelectorAll('.notification-list-item-message')).map(e => e.textContent).join(' || ')");
  if (toasts) log(`notification: ${toasts}`);
}
ws.close();
