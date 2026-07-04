// Settings cards for the two AI features:
//   • AI Models      — connect any model platform or a local server (BYO-key /
//                      keyless local), manage connections, set the default.
//   • Agent Access   — point an external agent (Claude Desktop, Cursor, Copilot,
//                      Windsurf) at GitStudio's MCP server for this repo, with a
//                      least-privilege permission choice.
//
// The renderer never holds an API key: it sends one to the main process via
// ai:setKey and only ever reads back redacted views (hasKey/usable booleans).

import { host } from "./bridge";
import { el, span, glyph, settingsCard, settingsField, copyText, pill, cleanErr, runBusy } from "./ui";
import { providerLogo } from "./providerLogos";
import { invalidateAiEnabled } from "./aiAssist";
import { toast, confirmDialog, promptInline } from "./dialogs";
import { trapTab } from "./views/common";
import type { AiConnectionView, AiPresetView, AiSettingsView, McpInfo } from "../shared/ipc";

/** The "AI Models" card: manage model connections. */
export function aiModelsCard(): HTMLElement {
  const { card, body } = settingsCard("AI Models", "sparkle");

  const render = async (): Promise<void> => {
    // Every connect / remove / set-key / set-default re-renders this card, so this
    // is the one chokepoint that busts the inline-AI gate's cached enabled-state.
    invalidateAiEnabled();
    body.replaceChildren();
    const sub = el("div", "settings-sub");
    sub.textContent =
      "Connect any model to power the ✨ helpers and the Assistant — bring your own key, or run a local model (Ollama / LM Studio) that never leaves your machine. AI is optional and never blocks Git.";
    body.append(sub);

    let settings: AiSettingsView;
    try {
      settings = await host.invoke("ai:settings", undefined);
    } catch (e) {
      body.append(errorLine(cleanErr(e)));
      return;
    }

    if (settings.connections.length === 0) {
      const empty = el("div", "settings-empty");
      empty.textContent = "No models connected yet.";
      body.append(empty);
    } else {
      const list = el("div", "ai-conn-list");
      for (const c of settings.connections) {
        list.append(connectionRow(c, settings.defaultId === c.id, render));
      }
      body.append(list);
    }

    const add = el("button", "btn btn-primary ai-add-btn");
    add.append(glyph("add"), span("Connect a model"));
    add.addEventListener("click", () => openGallery(body, render));
    body.append(add);
  };

  void render();
  return card;
}

/** One connection row with inline expand-to-edit. */
function connectionRow(c: AiConnectionView, isDefault: boolean, refresh: () => Promise<void>): HTMLElement {
  const row = el("div", "ai-conn");
  const head = el("div", "ai-conn-head");
  head.append(providerLogo(c.preset) ?? glyph(iconForWire(c)));

  const meta = el("div", "ai-conn-meta");
  const top = el("div", "ai-conn-name");
  top.append(span(c.label));
  if (isDefault) top.append(pill("Default", "is-default"));
  if (c.local) top.append(pill("Local", "is-local"));
  const bottom = el("div", "ai-conn-sub");
  bottom.textContent = `${c.models.mid || c.models.fast || "no model set"} · ${hostLabel(c.baseUrl)}`;
  meta.append(top, bottom);
  head.append(meta);

  const status = c.usable
    ? pill("Ready", "is-ready")
    : c.needsKey && !c.hasKey
      ? pill("Needs key", "is-warn")
      : pill("Incomplete", "is-warn");
  head.append(status);

  const actions = el("div", "ai-conn-actions");
  if (!isDefault && c.usable) {
    const star = iconBtn("star-empty", "Set as default");
    star.addEventListener("click", () =>
      void runBusy(star, async () => {
        await host.invoke("ai:setDefault", { id: c.id });
        void refresh();
      }),
    );
    actions.append(star);
  }
  const edit = iconBtn("gear", "Configure");
  const remove = iconBtn("trash", "Remove");
  actions.append(edit, remove);
  head.append(actions);
  row.append(head);

  // Inline editor (hidden until "Configure").
  const editor = el("div", "ai-conn-editor");
  editor.hidden = true;
  edit.addEventListener("click", () => {
    if (editor.hidden) {
      buildEditor(editor, c, refresh);
      editor.hidden = false;
    } else {
      editor.hidden = true;
    }
  });
  remove.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Remove model",
      message: `Remove “${c.label}”? Its stored API key will be deleted from this machine.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    await host.invoke("ai:removeConnection", { id: c.id });
    toast("Model removed.", "info");
    void refresh();
  });
  row.append(editor);
  return row;
}

function buildEditor(editor: HTMLElement, c: AiConnectionView, refresh: () => Promise<void>): void {
  editor.replaceChildren();
  const isCli = c.wire === "cli";

  const labelF = settingsField("Name", c.label, "My Claude");
  // CLI connections have no base URL or API key — they use the local binary's own
  // login. They just take optional model overrides (mapped to `--model`).
  const urlF = settingsField("API base URL", c.baseUrl, "https://api.example.com/v1");
  const fastF = settingsField(isCli ? "Quick model (optional)" : "Fast model", c.models.fast, "e.g. haiku");
  const midF = settingsField(isCli ? "Default model (optional)" : "Standard model", c.models.mid, "e.g. sonnet");
  const deepF = settingsField(isCli ? "Deep model (optional)" : "Deep model", c.models.deep, "e.g. opus");
  editor.append(labelF.row);
  if (isCli) {
    const note = el("div", "settings-sub");
    note.textContent = "Runs your local CLI with its own login — no API key. Model names map to the CLI's --model flag (leave blank to use its default).";
    editor.append(note, fastF.row, midF.row, deepF.row);
  } else {
    editor.append(urlF.row, fastF.row, midF.row, deepF.row);
  }

  if (c.needsKey) {
    const keyRow = el("div", "settings-field");
    const kl = el("label", "settings-field-label");
    kl.textContent = "API key";
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.className = "settings-input";
    keyInput.placeholder = c.hasKey ? "•••••••• (stored — leave blank to keep)" : "Paste your API key";
    keyRow.append(kl, keyInput);
    editor.append(keyRow);

    const saveKey = el("button", "mini-btn");
    saveKey.append(glyph("key"), span(c.hasKey ? "Update key" : "Save key"));
    saveKey.addEventListener("click", () => {
      if (!keyInput.value.trim()) {
        toast("Enter a key first.", "info");
        return;
      }
      void runBusy(saveKey, async () => {
        await host.invoke("ai:setKey", { id: c.id, key: keyInput.value.trim() });
        keyInput.value = "";
        toast("Key stored securely.", "success");
        void refresh();
      });
    });
    editor.append(saveKey);
  }

  const actions = el("div", "settings-actions");
  const save = el("button", "btn btn-primary");
  save.append(glyph("check"), span("Save"));
  save.addEventListener("click", () =>
    void runBusy(save, async () => {
      await host.invoke("ai:updateConnection", {
        id: c.id,
        label: labelF.input.value.trim() || c.label,
        baseUrl: urlF.input.value.trim(),
        models: { fast: fastF.input.value.trim(), mid: midF.input.value.trim(), deep: deepF.input.value.trim() },
      });
      toast("Saved.", "success");
      void refresh();
    }),
  );

  const test = el("button", "mini-btn");
  test.append(glyph("debug-start"), span("Test"));
  test.addEventListener("click", async () => {
    (test as HTMLButtonElement).disabled = true;
    test.replaceChildren(glyph("loading"), span("Testing…"));
    try {
      const r = await host.invoke("ai:test", { id: c.id });
      toast(r.message, r.ok ? "success" : "error");
    } catch (e) {
      toast(cleanErr(e), "error");
    } finally {
      (test as HTMLButtonElement).disabled = false;
      test.replaceChildren(glyph("debug-start"), span("Test"));
    }
  });

  actions.append(save, test);
  editor.append(actions);
}

/**
 * The "connect a provider" gallery — grouped into clearly-separated sections so
 * the no-key local options (your CLI login / a local model server) are distinct
 * from the cloud providers that need an API key.
 */
async function openGallery(body: HTMLElement, refresh: () => Promise<void>): Promise<void> {
  let presets: AiPresetView[] = [];
  try {
    presets = await host.invoke("ai:catalog", undefined);
  } catch {
    presets = [];
  }
  const overlay = el("div", "ai-gallery-pop");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Connect a model");
  // Electron: an overlay over a -webkit-app-region:drag surface needs no-drag or
  // its controls aren't clickable.
  overlay.style.setProperty("-webkit-app-region", "no-drag");
  const prevFocus = document.activeElement as HTMLElement | null;
  const closeOverlay = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    prevFocus?.focus?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeOverlay();
      return;
    }
    trapTab(e, panel);
  };

  const choose = async (p: AiPresetView): Promise<void> => {
    closeOverlay();
    await host.invoke("ai:addConnection", { preset: p.id });
    const ready = !p.needsKey;
    toast(`Added ${p.label}. ${ready ? "Ready to use." : "Add your API key to finish."}`, "success");
    await refresh();
    // Auto-open the new connection's editor (to paste a key / pick a model).
    const editors = body.querySelectorAll<HTMLElement>(".ai-conn");
    const gear = editors[editors.length - 1]?.querySelector<HTMLButtonElement>(
      '.ai-conn-actions [title="Configure"]',
    );
    gear?.click();
  };

  const tile = (p: AiPresetView): HTMLElement => {
    const card = el("button", "ai-prov-card");
    card.append(providerLogo(p.id) ?? glyph(p.icon));
    const t = el("div", "ai-prov-meta");
    const name = el("div", "ai-prov-name");
    name.append(span(p.label.replace(/\s*\(local\)$/i, "")));
    if (p.wire === "cli") name.append(pill("Your login", "is-local"));
    else if (p.local) name.append(pill("On-device", "is-local"));
    else if (!p.needsKey) name.append(pill("No key", "is-ready"));
    const blurb = el("div", "ai-prov-blurb");
    blurb.textContent = p.blurb;
    t.append(name, blurb);
    card.append(t);
    card.addEventListener("click", () => void choose(p));
    return card;
  };

  const section = (title: string, sub: string, items: AiPresetView[]): HTMLElement | null => {
    if (items.length === 0) return null;
    const wrap = el("div", "ai-gallery-section");
    const head = el("div", "ai-gallery-section-head");
    const h = el("div", "ai-gallery-section-title");
    h.textContent = title;
    const s = el("div", "ai-gallery-section-sub");
    s.textContent = sub;
    head.append(h, s);
    const grid = el("div", "ai-gallery");
    for (const p of items) grid.append(tile(p));
    wrap.append(head, grid);
    return wrap;
  };

  const agents = presets.filter((p) => p.wire === "cli");
  const localModels = presets.filter((p) => p.local && p.wire !== "cli");
  const cloud = presets.filter((p) => !p.local && p.wire !== "cli");

  const panel = el("div", "ai-gallery-panel");
  const ph = el("div", "ai-gallery-head");
  ph.append(span("Connect a model"));
  const close = iconBtn("close", "Close");
  close.addEventListener("click", () => closeOverlay());
  ph.append(close);
  panel.append(ph);

  const sections = [
    section("Use a local agent", "Drive a CLI you've already signed in to — no API key, your own subscription.", agents),
    section("Run a model locally", "Open models on your own machine — fully private, no key.", localModels),
    section("Connect with an API key", "Bring your own key from a cloud provider.", cloud),
  ].filter((x): x is HTMLElement => x !== null);
  for (const s of sections) panel.append(s);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeOverlay();
  });
  overlay.append(panel);
  document.body.append(overlay);
  document.addEventListener("keydown", onKey, true);
  // Focus the first card (or the close button) so keyboard users land inside.
  (panel.querySelector<HTMLElement>(".ai-prov-card") ?? close).focus();
}

// ── Agent Access (MCP) card ────────────────────────────────────────────────────

export function agentAccessCard(): HTMLElement {
  const { card, body } = settingsCard("Agent Access · MCP", "plug");
  let permission: "read" | "write" | "destructive" = "read";

  const render = async (): Promise<void> => {
    body.replaceChildren();
    const sub = el("div", "settings-sub");
    sub.textContent =
      "Expose this repository's Git tools to any MCP agent — Claude Desktop, Cursor, Copilot, Windsurf — so it can inspect history, diffs and branches (and, if you allow, commit) grounded in real state. Your repo, your rules.";
    body.append(sub);

    let info: McpInfo;
    try {
      info = await host.invoke("ai:mcpInfo", undefined);
    } catch (e) {
      body.append(errorLine(cleanErr(e)));
      return;
    }

    if (!info.available) {
      const warn = el("div", "settings-empty");
      warn.textContent = "The MCP server isn't built yet. Run `npm run build` in apps/mcp.";
      body.append(warn);
    }
    if (!info.repoRoot) {
      const warn = el("div", "settings-empty");
      warn.textContent = "Open a repository to scope the agent's access to it.";
      body.append(warn);
    }

    // Permission selector.
    const permWrap = el("div", "mcp-perm");
    const permLabel = el("div", "settings-field-label");
    permLabel.textContent = "What the agent may do";
    const seg = el("div", "settings-seg");
    const perms: Array<{ id: typeof permission; label: string }> = [
      { id: "read", label: "Read-only" },
      { id: "write", label: "+ Commit & branch" },
      { id: "destructive", label: "+ Discard & reset" },
    ];
    for (const p of perms) {
      const b = el("button", "settings-seg-btn" + (permission === p.id ? " active" : ""));
      b.append(span(p.label));
      b.addEventListener("click", () => {
        permission = p.id;
        void render();
      });
      seg.append(b);
    }
    // Explain what the CURRENT level grants, so the choice is never a guess.
    const permDesc = el("div", "mcp-perm-desc");
    const permDescs: Record<typeof permission, string> = {
      read: "Inspect only — history, diffs, branches and file contents. The agent cannot change your repository.",
      write: "Everything in Read-only, plus stage, commit and create or switch branches. It can't discard or rewrite existing work.",
      destructive: "Everything above, plus discard, reset and force operations that can lose uncommitted work or rewrite history.",
    };
    permDesc.textContent = permDescs[permission];
    permWrap.append(permLabel, seg, permDesc);
    body.append(permWrap);
    if (permission === "destructive") {
      const note = el("div", "mcp-danger-note");
      note.append(glyph("warning"), span("Only enable for an agent you trust — these tools can permanently lose work."));
      body.append(note);
    }

    // One-click client install rows.
    const clients = el("div", "mcp-clients");
    for (const cl of info.clients) {
      const r = el("div", "mcp-client");
      r.append(glyph("plug"));
      const m = el("div", "mcp-client-meta");
      const n = el("div", "mcp-client-name");
      n.append(span(cl.label));
      if (cl.installed) n.append(pill("Connected", "is-ready"));
      m.append(n);
      r.append(m);
      const btn = el("button", "mini-btn");
      btn.append(glyph(cl.installed ? "sync" : "add"), span(cl.installed ? "Update" : "Add"));
      btn.addEventListener("click", () => void runBusy(btn, async () => {
        try {
          const res = await host.invoke("ai:mcpInstall", {
            client: cl.id,
            write: permission !== "read",
            destructive: permission === "destructive",
          });
          toast(res.message, res.ok ? "success" : "error");
          if (res.ok) void render();
        } catch (e) {
          toast(cleanErr(e), "error");
        }
      }));
      r.append(btn);
      clients.append(r);
    }
    body.append(clients);

    // Manual config snippet (copy).
    const snippet = buildSnippet(info, permission);
    const codeWrap = el("div", "mcp-snippet");
    const codeHead = el("div", "mcp-snippet-head");
    codeHead.append(span("Or paste this into any MCP client"));
    const copyBtn = el("button", "icon-btn");
    copyBtn.title = "Copy config";
    copyBtn.append(glyph("copy"));
    copyBtn.addEventListener("click", () => void copyText(snippet, "MCP config copied."));
    codeHead.append(copyBtn);
    const pre = el("pre", "mcp-snippet-code");
    pre.textContent = snippet;
    codeWrap.append(codeHead, pre);
    body.append(codeWrap);
  };

  void render();
  return card;
}

function buildSnippet(info: McpInfo, permission: "read" | "write" | "destructive"): string {
  const args = [info.binPath];
  if (info.repoRoot) args.push("--repo", info.repoRoot);
  if (permission === "destructive") args.push("--allow-destructive");
  else if (permission === "write") args.push("--write");
  return JSON.stringify({ mcpServers: { gitstudio: { command: "node", args } } }, null, 2);
}

// ── small helpers ──────────────────────────────────────────────────────────────

function iconBtn(icon: string, title: string): HTMLElement {
  const b = el("button", "icon-btn");
  b.title = title;
  b.append(glyph(icon));
  return b;
}

function iconForWire(c: AiConnectionView): string {
  if (c.local) return "vm";
  if (c.preset === "openrouter" || c.preset === "together") return "globe";
  if (c.preset === "groq") return "zap";
  return "sparkle";
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "no endpoint";
  }
}

function errorLine(msg: string): HTMLElement {
  const e = el("div", "settings-empty");
  e.textContent = msg || "Something went wrong.";
  return e;
}
