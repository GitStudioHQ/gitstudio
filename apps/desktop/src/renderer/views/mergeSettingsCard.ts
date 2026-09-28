// Settings ▸ Merge — the merge setting the GitStudio extension
// (`gitstudio.merge.*`) and Merge Studio (`jbMerge.*`) expose too, so the
// three products are configured the same way: whether a merge opens with every
// non-conflicting change already applied (OFF by default — JetBrains' own
// default, and what the extensions have always done; the desktop used to do it
// unconditionally).
//
// The main process stores it (merge:settings / merge:setSettings).

import { host } from "../bridge";
import { el, settingsCard } from "../ui";
import { toast } from "../dialogs";
import type { MergeSettings } from "@gitstudio/host-bridge/conflictsProtocol";
import { loadMergeSettings, saveMergeSettings } from "../mergeParity";

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

  autoBox.addEventListener("change", () => void save({ autoApplyNonConflicting: autoBox.checked }));

  body.append(autoRow);

  let current: MergeSettings | undefined;
  const paint = (s: MergeSettings): void => {
    current = s;
    autoBox.checked = s.autoApplyNonConflicting;
    autoBox.disabled = false;
  };

  const save = async (patch: Partial<MergeSettings>): Promise<void> => {
    try {
      paint(await saveMergeSettings(host.invoke, patch));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save the merge settings.", "error");
      if (current) paint(current);
    }
  };

  void loadMergeSettings(host.invoke).then(paint);
  return card;
}
