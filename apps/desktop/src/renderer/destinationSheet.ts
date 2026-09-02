// The "Choose location…" sheet — a small modal that asks WHERE a one-click
// clone should land before it starts. Used by every "open in GitStudio"
// surface when the user asks for control (or always, when the
// ask-where-every-time setting is on), and offered as the retry path after a
// destination collision. Confirms with `{dest, name}`; never clones itself —
// the caller owns the actual ghrepo:open.

import { host } from "./bridge";
import { openModal, toast } from "./dialogs";
import { el, span, glyph, cleanErr } from "./ui";
import { validateTargetName } from "../shared/cloneName";

export function openDestinationSheet(
  fullName: string,
  onConfirm: (choice: { dest: string; name?: string }) => void,
  opts: {
    /** Prefill the folder-name field (e.g. retrying after a collision). */
    name?: string;
    /** One-line context above the fields (e.g. why the sheet appeared). */
    note?: string;
  } = {},
): void {
  const repo = fullName.split("/")[1] ?? fullName;
  const card = el("div", "modal-card dest-card");
  let close = (): void => {};
  let dest = "";

  const title = el("div", "modal-title");
  title.textContent = `Where should ${fullName} go?`;

  const sub = el("div", "modal-message");
  sub.textContent = opts.note ?? "Pick the folder this repository is cloned into.";

  // Destination row — the same look as the clone dialog's, which means the same
  // CLASSES. `.clone-dest` and `.clone-dest-text` have no rules anywhere in the
  // stylesheet, so this row was an unstyled stack: the label and path piled on
  // top of each other and "Choose…" sat under them instead of beside them. The
  // styled control is `.clone-dest-control`.
  const destLabel = el("div", "clone-dest-label");
  destLabel.textContent = "Destination";
  const destValue = el("div", "clone-dest-path");
  destValue.textContent = "Loading…";
  const chooseBtn = el("button", "mini-btn");
  chooseBtn.append(glyph("folder-opened"), span("Choose…"));
  const destControl = el("div", "clone-dest-control");
  destControl.append(destValue, chooseBtn);
  const destRow = el("div", "clone-field");
  destRow.append(destLabel, destControl);

  // Folder-name override.
  const nameLabel = el("div", "clone-dest-label dest-name-label");
  nameLabel.textContent = "Folder name";
  const nameInput = document.createElement("input");
  nameInput.className = "modal-input dest-name-input";
  nameInput.placeholder = repo;
  nameInput.value = opts.name ?? "";
  nameInput.spellcheck = false;
  nameInput.autocapitalize = "off";
  nameInput.setAttribute("aria-label", "Folder name");
  const nameError = el("div", "dest-name-error");
  nameError.hidden = true;

  const actions = el("div", "modal-actions");
  const cancel = el("button", "mini-btn");
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => close());
  const go = el("button", "btn btn-primary modal-ok");
  go.textContent = "Clone here";
  go.setAttribute("disabled", "true");
  actions.append(cancel, go);

  card.append(title, sub, destRow, nameLabel, nameInput, nameError, actions);

  function refresh(): void {
    const problem = validateTargetName(nameInput.value);
    nameError.textContent = problem ?? "";
    nameError.hidden = !problem;
    nameInput.classList.toggle("is-invalid", !!problem);
    if (dest && !problem) go.removeAttribute("disabled");
    else go.setAttribute("disabled", "true");
  }
  nameInput.addEventListener("input", refresh);

  chooseBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const dir = await host.invoke("clone:pickDir", dest ? { defaultPath: dest } : undefined);
        if (dir) {
          dest = dir;
          destValue.textContent = dir;
          destValue.title = dir;
          refresh();
        }
      } catch (e) {
        toast(cleanErr(e) || "Couldn't choose a folder.", "error");
      }
    })();
  });

  const confirm = (): void => {
    if (go.hasAttribute("disabled")) return;
    const name = nameInput.value.trim();
    close();
    onConfirm({ dest, name: name || undefined });
  };
  go.addEventListener("click", confirm);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    }
  });

  openModal((c) => {
    close = c;
    return { card, focusEl: nameInput, label: `Choose where ${fullName} goes`, onClose: () => {} };
  });

  // Prefill the configured default folder; the sheet is usable before this
  // lands (Choose… works regardless), it just can't confirm without a dest.
  void host
    .invoke("settings:get", undefined)
    .then((v) => {
      if (!dest) {
        dest = v.cloneDir;
        destValue.textContent = v.cloneDirDisplay;
        destValue.title = v.cloneDir;
        refresh();
      }
    })
    .catch(() => {
      destValue.textContent = "Choose a folder…";
    });
}
