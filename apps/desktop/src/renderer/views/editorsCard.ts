// Settings ▸ Editors — which editors "Open in…" offers, and which one the
// button itself opens.
//
// The list is what the machine has: every editor GitStudio could find, plus
// any command the user added. Ticking decides what the Open-in menus list;
// "Default" decides what the primary half of the button does. A hidden editor
// cannot be the default, so hiding the default hands the role to the next one
// shown — the card shows that move as it happens.

import * as l10n from "@vscode/l10n";
import { host } from "../bridge";
import { el, span, glyph, settingsCard, settingsField } from "../ui";
import { toast } from "../dialogs";
import { bustEditors, editorMark, loadEditors } from "../openIn";
import type { EditorsView, EditorView } from "../../shared/ipc";

const isMac = navigator.platform.toLowerCase().includes("mac");

function viaText(e: EditorView): string {
  switch (e.via) {
    case "app":
      return e.location ?? l10n.t("Application");
    case "cli":
      return e.location ? l10n.t("{0} (command line)", e.location) : l10n.t("Command line");
    case "path":
      return e.location ?? l10n.t("Installed");
    case "custom":
      return e.location ?? l10n.t("Custom command");
  }
}

export function editorsCard(): HTMLElement {
  const { card, body } = settingsCard(l10n.t("Editors"), "code");
  card.classList.add("editors-card");
  const sub = el("div", "settings-sub");
  sub.textContent = l10n.t(
    "The Open in… button in the top bar, and every repository's menu, list the editors ticked here. Your favourite is the one the button itself opens.",
  );

  const list = el("div", "editors-list");
  list.setAttribute("role", "list");
  const foot = el("div", "editors-foot");
  const found = el("div", "settings-sub editors-found");
  const footBtns = el("div", "settings-clonedir-btns");
  const addBtn = el("button", "mini-btn editors-add") as HTMLButtonElement;
  addBtn.append(glyph("add"), span(l10n.t("Add a custom editor…")));
  const againBtn = el("button", "mini-btn editors-again") as HTMLButtonElement;
  againBtn.append(glyph("refresh"), span(l10n.t("Look again")));
  againBtn.title = l10n.t("Scan this machine for editors again");
  footBtns.append(addBtn, againBtn);
  foot.append(found, footBtns);

  // The add form: name + command. `{path}` marks where the folder goes; a
  // bare executable gets it appended.
  const form = el("div", "editors-add-form");
  form.hidden = true;
  const nameField = settingsField(l10n.t("Name"), "", "Helix");
  const cmdField = settingsField(l10n.t("Command"), "", "hx {path}");
  const hint = el("div", "settings-sub");
  hint.textContent = l10n.t("Write {path} where the repository folder goes, or leave it off to pass the folder as the last argument.");
  const formBtns = el("div", "settings-clonedir-btns editors-add-btns");
  const saveBtn = el("button", "mini-btn editors-save") as HTMLButtonElement;
  saveBtn.textContent = l10n.t("Add editor");
  const cancelBtn = el("button", "mini-btn") as HTMLButtonElement;
  cancelBtn.textContent = l10n.t("Cancel");
  formBtns.append(saveBtn, cancelBtn);
  form.append(nameField.row, cmdField.row, hint, formBtns);

  const openForm = (): void => {
    form.hidden = false;
    addBtn.hidden = true;
    nameField.input.focus();
  };
  const closeForm = (): void => {
    form.hidden = true;
    addBtn.hidden = false;
    nameField.input.value = "";
    cmdField.input.value = "";
  };
  addBtn.addEventListener("click", openForm);
  cancelBtn.addEventListener("click", closeForm);
  const syncSave = (): void => {
    saveBtn.disabled = !nameField.input.value.trim() || !cmdField.input.value.trim();
  };
  nameField.input.addEventListener("input", syncSave);
  cmdField.input.addEventListener("input", syncSave);
  syncSave();
  const submit = async (): Promise<void> => {
    const name = nameField.input.value.trim();
    const command = cmdField.input.value.trim();
    if (!name || !command) return;
    saveBtn.disabled = true;
    try {
      const v = await host.invoke("editors:addCustom", { name, command });
      closeForm();
      paint(v);
      bustEditors();
      toast(l10n.t("{0} added. It's in every Open in… menu now.", name), "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : l10n.t("Couldn't add the editor."), "error");
      syncSave();
    }
  };
  saveBtn.addEventListener("click", () => void submit());
  for (const inp of [nameField.input, cmdField.input]) {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeForm();
      }
    });
  }

  const row = (e: EditorView): HTMLElement => {
    const r = el("div", "editors-row" + (e.shown ? "" : " is-hidden") + (e.isDefault ? " is-default" : ""));
    r.setAttribute("role", "listitem");
    r.dataset.id = e.id;
    // The tick and the words are one label; the buttons stay outside it, or a
    // click on "Make default" would also flip the tick.
    const lab = el("label", "settings-check editors-check");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = e.shown;
    box.setAttribute("aria-label", l10n.t("Show {0} in Open in… menus", e.name));
    const icon = el("span", "editors-icon");
    icon.appendChild(editorMark(e));
    lab.append(icon);
    const txt = el("div", "settings-check-text");
    const title = el("div", "settings-check-title editors-name");
    title.append(span(e.name));
    if (e.via === "custom") title.append(span(l10n.t("custom"), "editors-tag"));
    const where = el("div", "settings-sub editors-where");
    where.textContent = viaText(e);
    where.title = e.location ?? "";
    txt.append(title, where);
    lab.append(box, txt);
    r.append(lab);

    const side = el("div", "editors-row-side");
    // The favourite is a star you can press, not a label you can only read —
    // it is the one thing on this card people come here to change.
    const fav = el("button", "mini-btn editors-fav" + (e.isDefault ? " is-on" : "")) as HTMLButtonElement;
    fav.append(glyph(e.isDefault ? "star-full" : "star-empty"), span(e.isDefault ? l10n.t("Favourite") : l10n.t("Make favourite")));
    fav.title = e.isDefault ? l10n.t("{0} is what the Open in button opens", e.name) : l10n.t("Make {0} what the Open in button opens", e.name);
    fav.setAttribute("aria-pressed", String(e.isDefault));
    fav.disabled = e.isDefault || !e.shown;
    fav.addEventListener("click", () => void change(() => host.invoke("editors:setDefault", { id: e.id })));
    side.append(fav);
    if (e.via === "custom") {
      const rm = el("button", "mini-btn gh-icon-btn editors-remove") as HTMLButtonElement;
      rm.setAttribute("aria-label", l10n.t("Remove {0}", e.name));
      rm.title = l10n.t("Remove {0}", e.name);
      rm.append(glyph("trash"));
      rm.addEventListener("click", () => void change(() => host.invoke("editors:removeCustom", { id: e.id })));
      side.append(rm);
    }
    r.append(side);

    box.addEventListener("change", () => void change(() => host.invoke("editors:setShown", { id: e.id, shown: box.checked })));
    return r;
  };

  const change = async (op: () => Promise<EditorsView>): Promise<void> => {
    try {
      paint(await op());
      bustEditors();
    } catch (e) {
      toast(e instanceof Error ? e.message : l10n.t("Couldn't save that."), "error");
    }
  };

  const paint = (v: EditorsView): void => {
    list.replaceChildren(...v.editors.map(row));
    const detected = v.editors.filter((e) => e.via !== "custom").length;
    const shown = v.editors.filter((e) => e.shown).length;
    if (v.editors.length === 0) {
      const none = el("div", "editors-none");
      none.append(
        glyph("info"),
        span(
          isMac
            ? l10n.t("No editors found in /Applications or ~/Applications. Add one below with the command that opens a folder.")
            : l10n.t("No editors found on PATH or in the usual install folders. Add one below with the command that opens a folder."),
        ),
      );
      list.append(none);
      found.textContent = "";
    } else {
      const suffix = shown === v.editors.length ? "" : l10n.t(" · {0} of {1} shown", shown, v.editors.length);
      found.textContent = isMac
        ? detected === 1
          ? l10n.t("{0} editor found on this Mac{1}", detected, suffix)
          : l10n.t("{0} editors found on this Mac{1}", detected, suffix)
        : detected === 1
          ? l10n.t("{0} editor found on this machine{1}", detected, suffix)
          : l10n.t("{0} editors found on this machine{1}", detected, suffix);
    }
  };

  againBtn.addEventListener("click", async () => {
    againBtn.disabled = true;
    try {
      const v = await host.invoke("editors:refresh", undefined);
      paint(v);
      bustEditors();
      const n = v.editors.filter((e) => e.via !== "custom").length;
      toast(n === 0 ? l10n.t("Still no editors found.") : n === 1 ? l10n.t("Found {0} editor.", n) : l10n.t("Found {0} editors.", n), "info");
    } catch (e) {
      toast(e instanceof Error ? e.message : l10n.t("Couldn't look again."), "error");
    } finally {
      againBtn.disabled = false;
    }
  });

  body.append(sub, list, form, foot);
  void loadEditors().then(paint);
  return card;
}
