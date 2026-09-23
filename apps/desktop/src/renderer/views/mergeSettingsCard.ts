// Settings ▸ Merge — the same five merge settings the GitStudio extension
// (`gitstudio.merge.*`) and Merge Studio (`jbMerge.*`) expose, so the three
// products are configured the same way:
//
// - whether a merge opens with every non-conflicting change already applied
//   (OFF by default — JetBrains' own default, and what the extensions have
//   always done; the desktop used to do it unconditionally);
// - who resolves a conflict: GitStudio's merge editor or a JetBrains IDE;
// - who shows a file's diff;
// - which JetBrains IDE, and an explicit launcher path.
//
// The MAIN process stores these (merge:settings / merge:setSettings) because it
// is the one that spawns the IDE: an executable path supplied by the renderer
// per call would be a way to run anything.

import { host } from "../bridge";
import { el, span, glyph, settingsCard, settingsField, markSegment } from "../ui";
import { toast } from "../dialogs";
import {
  JETBRAINS_IDES,
  type JetBrainsIdeInfo,
  type MergeSettings,
} from "@gitstudio/host-bridge/conflictsProtocol";
import { detectJetBrains, loadMergeSettings, saveMergeSettings } from "../mergeParity";

export function mergeSettingsCard(): HTMLElement {
  const { card, body } = settingsCard("Merge", "git-merge");
  card.classList.add("merge-settings-card");

  // ── auto-apply ──
  const autoRow = el("label", "settings-check merge-auto");
  const autoBox = document.createElement("input");
  autoBox.type = "checkbox";
  autoBox.disabled = true;
  autoBox.setAttribute("aria-label", "Apply non-conflicting changes when a merge opens");
  const autoText = el("div", "settings-check-text");
  const autoTitle = el("div", "settings-check-title");
  autoTitle.textContent = "Apply non-conflicting changes when a merge opens";
  const autoSub = el("div", "settings-sub");
  autoSub.textContent =
    "Changes only one side made (or both made the same way) start out accepted, and only the real " +
    "conflicts are left for you. Off, every change waits for you to accept it.";
  autoText.append(autoTitle, autoSub);
  autoRow.append(autoBox, autoText);

  // ── resolver / diff tool ──
  const seg = (
    label: string,
    sub: string,
    options: Array<{ id: "embedded" | "jetbrains"; label: string }>,
    key: "conflictResolver" | "diffTool",
  ): { wrap: HTMLElement; paint(s: MergeSettings, ide: JetBrainsIdeInfo | undefined): void } => {
    const l = el("div", "settings-field-label");
    l.textContent = label;
    const d = el("div", "settings-sub");
    d.textContent = sub;
    const g = el("div", "settings-seg");
    const btns = options.map((o) => {
      const b = el("button", "settings-seg-btn") as HTMLButtonElement;
      b.dataset.value = o.id;
      b.append(span(o.label));
      b.disabled = true;
      b.addEventListener("click", () => void save({ [key]: o.id } as Partial<MergeSettings>));
      g.appendChild(b);
      return b;
    });
    markSegment(g, l);
    const wrap = el("div", "merge-settings-group");
    wrap.append(l, d, g);
    return {
      wrap,
      paint: (s, ide) => {
        for (const b of btns) {
          b.classList.toggle("active", b.dataset.value === s[key]);
          b.setAttribute("aria-pressed", String(b.dataset.value === s[key]));
          b.disabled = false;
          if (b.dataset.value === "jetbrains") {
            b.title = ide ? `Use ${ide.name}` : "No JetBrains IDE was found — GitStudio's own editor is used meanwhile";
          }
        }
      },
    };
  };
  const resolver = seg(
    "Resolve conflicts with",
    "Where a conflicted file opens from the Changes view and the conflicts list.",
    [
      { id: "embedded", label: "GitStudio's merge editor" },
      { id: "jetbrains", label: "A JetBrains IDE" },
    ],
    "conflictResolver",
  );
  const diffTool = seg(
    "Show diffs with",
    "Where a changed file's diff opens from the Changes view.",
    [
      { id: "embedded", label: "GitStudio" },
      { id: "jetbrains", label: "A JetBrains IDE" },
    ],
    "diffTool",
  );

  // ── which IDE ──
  const ideLabel = el("label", "settings-field-label") as HTMLLabelElement;
  ideLabel.textContent = "JetBrains IDE";
  const ideSelect = document.createElement("select");
  ideSelect.className = "gh-form-select merge-ide-select";
  ideSelect.id = "merge-ide-select";
  ideLabel.htmlFor = ideSelect.id;
  ideSelect.disabled = true;
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = "The first one found";
  ideSelect.appendChild(auto);
  for (const ide of JETBRAINS_IDES) {
    const o = document.createElement("option");
    o.value = ide.id;
    o.textContent = ide.name;
    ideSelect.appendChild(o);
  }
  ideSelect.addEventListener("change", () =>
    void save({ preferredIde: ideSelect.value as MergeSettings["preferredIde"] }),
  );
  const found = el("div", "settings-sub merge-ide-found");
  found.setAttribute("role", "status");
  found.textContent = "Looking for JetBrains IDEs…";

  const pathField = settingsField("Launcher path", "", "Found automatically");
  pathField.row.classList.add("merge-ide-path");
  pathField.input.disabled = true;
  const pathBtns = el("div", "settings-clonedir-btns");
  const savePath = el("button", "mini-btn") as HTMLButtonElement;
  savePath.append(glyph("check"), span("Use this path"));
  savePath.disabled = true;
  const clearPath = el("button", "mini-btn") as HTMLButtonElement;
  clearPath.textContent = "Find it automatically";
  clearPath.hidden = true;
  pathBtns.append(savePath, clearPath);
  const pathHint = el("div", "settings-sub");
  pathHint.textContent =
    "Only needed when the IDE is installed somewhere it cannot be found — for example a Toolbox script.";
  savePath.addEventListener("click", () => void save({ jetbrainsPath: pathField.input.value.trim() }));
  clearPath.addEventListener("click", () => void save({ jetbrainsPath: "" }));
  pathField.input.addEventListener("input", () => {
    savePath.disabled = !pathField.input.value.trim() || pathField.input.value.trim() === current?.jetbrainsPath;
  });
  pathField.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !savePath.disabled) savePath.click();
  });

  autoBox.addEventListener("change", () => void save({ autoApplyNonConflicting: autoBox.checked }));

  body.append(autoRow, resolver.wrap, diffTool.wrap, ideLabel, ideSelect, found, pathField.row, pathBtns, pathHint);

  let current: MergeSettings | undefined;
  const paint = (s: MergeSettings, ide: JetBrainsIdeInfo | undefined): void => {
    current = s;
    autoBox.checked = s.autoApplyNonConflicting;
    autoBox.disabled = false;
    resolver.paint(s, ide);
    diffTool.paint(s, ide);
    ideSelect.value = s.preferredIde;
    ideSelect.disabled = false;
    pathField.input.disabled = false;
    if (document.activeElement !== pathField.input) pathField.input.value = s.jetbrainsPath;
    savePath.disabled = true;
    clearPath.hidden = !s.jetbrainsPath;
    found.textContent = ide
      ? `Using ${ide.name} — ${ide.command}`
      : "No JetBrains IDE was found on this machine. GitStudio's own editors are used meanwhile.";
    found.classList.toggle("is-missing", !ide);
  };

  const save = async (patch: Partial<MergeSettings>): Promise<void> => {
    try {
      const next = await saveMergeSettings(host.invoke, patch);
      const ide = await detectJetBrains(host.invoke);
      paint(next, ide);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save the merge settings.", "error");
      if (current) paint(current, await detectJetBrains(host.invoke));
    }
  };

  void Promise.all([loadMergeSettings(host.invoke), detectJetBrains(host.invoke)]).then(([s, ide]) => paint(s, ide));
  return card;
}
