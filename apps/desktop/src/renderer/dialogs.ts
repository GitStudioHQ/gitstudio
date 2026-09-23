// Shared in-app UI primitives — toasts, a confirm dialog, and a text prompt —
// used by both the main renderer and the commit context menu. Self-contained
// (no dependency on the renderer's DOM helpers) so any module can import them.
// These replace the native alert()/confirm()/prompt(), which are jarring (and,
// for prompt(), unsupported) in an Electron renderer.

import { registerLayer, isMenuOpen, holdBackground } from "./overlays";
import { mdEditor } from "./mdEditor";
import { wireDraft } from "./draftStore";
import { refNameProblem, sanitizeRefName } from "../shared/refName";

function mk(tag: string, cls = ""): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function gl(name: string): HTMLElement {
  const s = mk("span", `glyph codicon codicon-${name}`);
  s.setAttribute("aria-hidden", "true");
  return s;
}

export type ToastKind = "error" | "success" | "info";

/** A non-blocking, auto-dismissing in-app toast (replaces native alert()). */
/**
 * An action offered on a toast — almost always Undo.
 *
 * A reversible action that announces itself and then gives you no way back is
 * only reversible in principle. "Stopped tracking ~/Developer" is a sentence
 * you can read after the list has already changed under you, and the only
 * remedy was to find the folder again in a file picker.
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export function toast(
  message: string,
  kind: ToastKind = "info",
  timeoutMs?: number,
  action?: ToastAction,
): void {
  let stack = document.getElementById("toast-stack");
  if (!stack) {
    stack = mk("div", "toast-stack");
    stack.id = "toast-stack";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  const t = mk("div", `toast toast-${kind}`);
  const icon = gl(kind === "error" ? "error" : kind === "success" ? "pass-filled" : "info");
  const msg = mk("div", "toast-msg");
  msg.textContent = message;
  const close = mk("button", "toast-close");
  close.setAttribute("aria-label", "Dismiss");
  close.appendChild(gl("close"));
  t.append(icon, msg);
  if (action) {
    const act = mk("button", "toast-action");
    act.textContent = action.label;
    act.addEventListener("click", () => {
      // Dismiss FIRST: the handler re-renders, and a toast still on screen
      // afterwards reads as though the undo had not happened.
      dismiss();
      action.onClick();
    });
    t.appendChild(act);
  }
  t.append(close);
  stack.appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  let timer = 0;
  // eslint-disable-next-line prefer-const -- referenced by the action above.
  const dismiss = (): void => {
    if (!t.isConnected) return;
    window.clearTimeout(timer);
    t.classList.remove("in");
    t.classList.add("out");
    t.addEventListener("transitionend", () => t.remove(), { once: true });
    window.setTimeout(() => t.remove(), 280);
  };
  close.addEventListener("click", dismiss);
  // An undoable action gets longer to be undone in: four seconds is not enough
  // to read a sentence and decide you did not mean it.
  timer = window.setTimeout(
    dismiss,
    timeoutMs ?? (kind === "error" ? 7000 : action ? 10000 : 4000),
  );
}

export interface ModalSpec {
  card: HTMLElement;
  focusEl: HTMLElement;
  /** Accessible name for the dialog (announced by screen readers). */
  label?: string;
  /** Called on ANY close (button or dismiss) — resolve a default if needed. */
  onClose: () => void;
  /** Veto Esc/backdrop dismissal (return false to keep the modal up — e.g. a
   *  clone mid-flight). The explicit close() handed to build() always works. */
  canDismiss?: () => boolean;
  /**
   * Is there unsaved work in here right now?
   *
   * A route change tears every floating layer down, which is right for a menu or
   * a peek and wrong for a form someone is typing into. The window-focus refresh
   * routes, so saving a file in your editor while a half-written issue sat in
   * this dialog destroyed it — the user did nothing, and their text was gone.
   *
   * Returning true makes a BACKGROUND teardown skip this modal. Esc, the
   * backdrop and the modal's own close() are unaffected: those are the user
   * asking, and the user is allowed to throw their own work away.
   */
  hasUnsavedWork?: () => boolean;
}

/** Open-modal stack — Esc must dismiss only the TOPMOST modal, not every one
 *  listening on document (a prompt over the secrets manager used to take the
 *  manager down with it). */
const modalStack: symbol[] = [];

/**
 * THE focus-trapping modal scaffold — overlay, Esc, Tab trap, backdrop
 * dismissal, previous-focus restore. Every modal in the app builds on this
 * (confirm/prompt/edit here; the section views' form modals via the export) so
 * the dismissal contract can never drift between surfaces.
 */
export function openModal(build: (close: () => void) => ModalSpec): void {
  const prevFocus = document.activeElement as HTMLElement | null;
  const token = Symbol("modal");
  const overlay = mk("div", "modal-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  let spec: ModalSpec;
  let closed = false;
  /** Set once the overlay is in the DOM — see the holdBackground call below. */
  let releaseBackground: (() => void) | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    layer.release();
    const i = modalStack.indexOf(token);
    if (i >= 0) modalStack.splice(i, 1);
    spec.onClose();
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    // BEFORE restoring focus: focus cannot land inside an inert subtree, so
    // releasing after would silently drop the keyboard on <body>.
    releaseBackground?.();
    prevFocus?.focus?.();
  };
  // A route change dismisses the modal like Esc would — but through `close`,
  // not `dismiss`, so a modal that refuses dismissal mid-clone still tears down
  // rather than being orphaned above a view it no longer belongs to.
  //
  // …unless it holds work the user has not saved. A background refresh routing
  // underneath a form is not a reason to throw that form away.
  const layer = registerLayer(
    () => {
      if (spec?.hasUnsavedWork?.()) return;
      close();
    },
    "modal",
    // A veto leaves the dialog on screen, and the registry has to say so:
    // dropped from it, `isTop()` was false for a dialog that IS the top layer
    // (its Escape dead), and `openLayerCount()` was zero with it open (the
    // page's own ← navigating out from under it).
    () => overlay.isConnected,
  );
  const dismiss = (): void => {
    if (spec.canDismiss && !spec.canDismiss()) return;
    close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      if (modalStack[modalStack.length - 1] !== token) return; // a newer modal owns Esc
      if (document.body.classList.contains("cmdk-open")) return; // the palette owns Esc
      if (isMenuOpen()) return; // …and so does a menu opened from inside this dialog
      e.preventDefault();
      dismiss();
      return;
    }
    if (e.key !== "Tab") return;
    const f = Array.from(
      spec.card.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((n) => !n.hasAttribute("disabled") && n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  spec = build(close);
  if (spec.label) overlay.setAttribute("aria-label", spec.label);
  overlay.appendChild(spec.card);
  document.body.appendChild(overlay);
  /**
   * Hold the page behind the dialog.
   *
   * `aria-modal="true"` is a CLAIM, not a mechanism. The Tab wrap below acts
   * only when focus is exactly on the first or last focusable in the card — so
   * an in-dialog re-render that destroys the focused control, or a click on the
   * dialog's own heading, put focus on <body>, and the next Tab walked into the
   * dozens of controls behind the scrim: reachable, focusable and clickable
   * while invisible. A screen reader read the whole background as though no
   * dialog were open. Two of the app's four modal surfaces already did this;
   * the other two claimed it.
   *
   * The wrap stays as belt and braces — `inert` fixes the escape, the wrap
   * keeps the cycle tight.
   */
  releaseBackground = holdBackground(overlay);
  modalStack.push(token);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) dismiss();
  });
  document.addEventListener("keydown", onKey, true);
  setTimeout(() => spec.focusEl.focus(), 0);
}

/** Internal alias — the pre-export name the local wrappers were written against. */
const modal = openModal;

/** A styled confirmation dialog (replaces native confirm()); resolves true/false. */
export function confirmDialog(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Demand this exact text before enabling Confirm — for irreversible,
   *  disk-destroying actions where a mis-aimed click must not be enough. */
  requireTyped?: string;
  /** Close the dialog and answer `false` when this aborts.
   *
   *  A confirm can outlive the thing it is asking about. The agent's
   *  tool-approval dialog is the case: pressing Stop ends the turn in the main
   *  process, but the modal stayed on screen — and its Approve button then
   *  posted an approval for a run that no longer existed. A dialog tied to
   *  something cancellable should be cancelled with it. */
  signal?: AbortSignal;
  /**
   * While this returns true, a route change the user did not make leaves the
   * question on screen instead of answering it "Cancel".
   *
   * For a question asked DURING a git operation. A write moves a ref, the
   * repository watcher reports it ~250 ms later, the refresh re-routes — and
   * a re-route tears every floating layer down, so "Abort the rebase?" was
   * answered by nobody (memory: refresh-closing-dialogs). A question the user
   * owes an answer is work in progress (ModalSpec.hasUnsavedWork). A
   * predicate, not a flag: a repository SWITCH should still close it
   * (repoEpoch.whileSameRepo), since the verb acts on whatever is open.
   */
  holdWhile?: () => boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    modal((close) => {
      // Cancelled from OUTSIDE — see `opts.signal`. Reuses `settled` so the
      // close hook cannot resolve a second time.
      opts.signal?.addEventListener(
        "abort",
        () => {
          if (settled) return;
          settled = true;
          resolve(false);
          close();
        },
        { once: true },
      );
      const card = mk("div", "modal-card");
      const h = mk("div", "modal-title");
      h.textContent = opts.title;
      const body = mk("div", "modal-message");
      body.textContent = opts.message;
      const actions = mk("div", "modal-actions");
      const cancel = mk("button", "mini-btn");
      cancel.textContent = "Cancel";
      const ok = mk("button", `btn ${opts.danger ? "btn-danger" : "btn-primary"} modal-ok`);
      const okLabel = mk("span");
      okLabel.textContent = opts.confirmLabel ?? "Confirm";
      ok.appendChild(okLabel);
      actions.append(cancel, ok);
      card.append(h, body);
      let typedInput: HTMLInputElement | undefined;
      if (opts.requireTyped) {
        const hint = mk("div", "modal-message confirm-typed-hint");
        hint.textContent = `Type ${opts.requireTyped} to confirm.`;
        typedInput = document.createElement("input");
        typedInput.className = "modal-input confirm-typed-input";
        // NOT the required text: using it as the placeholder showed the answer
        // inside the box you had to type it into, which teaches you to copy
        // what is already on screen and defeats the point of the safeguard.
        typedInput.placeholder = "Type the name to confirm";
        typedInput.spellcheck = false;
        typedInput.autocapitalize = "off";
        typedInput.setAttribute("aria-label", `Type ${opts.requireTyped} to confirm`);
        const sync = (): void => {
          const match = typedInput!.value.trim() === opts.requireTyped;
          if (match) ok.removeAttribute("disabled");
          else ok.setAttribute("disabled", "true");
        };
        typedInput.addEventListener("input", sync);
        typedInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !ok.hasAttribute("disabled")) {
            e.preventDefault();
            ok.click();
          }
        });
        sync();
        card.append(hint, typedInput);
      }
      card.append(actions);
      cancel.addEventListener("click", () => {
        settled = true;
        resolve(false);
        close();
      });
      ok.addEventListener("click", () => {
        if (ok.hasAttribute("disabled")) return;
        settled = true;
        resolve(true);
        close();
      });
      return {
        card,
        // A destructive confirm used to open with the DESTROY button focused,
        // so the Return key that dismisses most dialogs deleted the branch
        // instead. Danger dialogs start on Cancel; a typed-confirmation dialog
        // starts in the field you have to fill in either way.
        focusEl: typedInput ?? (opts.danger ? cancel : ok),
        label: opts.title,
        onClose: () => {
          if (!settled) resolve(false);
        },
        hasUnsavedWork: () => opts.holdWhile?.() ?? false,
      };
    });
  });
}

/** A modal text prompt (Electron's renderer has no window.prompt). */
/*
 * `editForm` — a title input plus a body textarea in a modal — used to live
 * here. Both of its callers are routed PAGES now (`views/issueCompose.ts`),
 * because a modal has nowhere to put the third thing an issue is filed WITH:
 * its labels, its assignees and its milestone.
 */

/** The named validators a prompt can opt into. One for now; the vocabulary
 *  grows when a caller needs it, not before. */
export type DialogValidator = "refName";

const VALIDATORS: Record<DialogValidator, (v: string) => string | null> = {
  refName: refNameProblem,
};

/** An optional single checkbox in a prompt. `checked` is IN and OUT: seeded
 *  from here, and overwritten with the state at submit — read it back after the
 *  promise resolves. One mutable object rather than a richer return type,
 *  because changing what promptInline resolves would touch 22 call sites. */
export interface PromptCheck {
  label: string;
  checked: boolean;
  /** What the primary button says while the box is ticked. A button has to
   *  state what the click will do. */
  okLabelChecked?: string;
}

export interface PromptOpts {
  /** One line under the title saying what this does — and what it does not. */
  hint?: string;
  /** Opt in to live validation. When ABSENT nothing changes: no `input`
   *  listener is attached and `ok` is never given `disabled`. */
  validate?: DialogValidator;
  /** Offer the repaired form when what was typed is refused. Defaults on for
   *  `refName`. */
  suggest?: boolean;
  /** The caller's own rule on top of the validator — a message blocks, null
   *  allows. Where "that name is already taken" lives, which this app can
   *  answer from the refs it already has rather than a round trip. */
  extra?: (v: string) => string | null;
  check?: PromptCheck;
}

export function promptInline(
  title: string,
  placeholder: string,
  value = "",
  okLabel = "Create",
  /** When true, an empty submission resolves "" (not null) — null then means
   *  ONLY an explicit cancel/dismiss. Lets callers tell "cleared" from "cancelled". */
  allowEmpty = false,
  opts: PromptOpts = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null, close: () => void): void => {
      settled = true;
      resolve(v);
      close();
    };
    const submit = (raw: string): string | null => (allowEmpty ? raw.trim() : raw.trim() || null);
    modal((close) => {
      const card = mk("div", "modal-card");
      const h = mk("div", "modal-title");
      h.textContent = title;
      const input = document.createElement("input");
      input.className = "modal-input";
      input.placeholder = placeholder;
      input.value = value;
      input.id = "gs-prompt-input";
      const actions = mk("div", "modal-actions");
      const cancel = mk("button", "mini-btn");
      cancel.textContent = "Cancel";
      const ok = mk("button", "btn btn-primary modal-ok");
      const okSpan = mk("span");
      okSpan.textContent = okLabel;
      ok.appendChild(okSpan);
      actions.append(cancel, ok);
      card.append(h);

      let hintEl: HTMLElement | undefined;
      if (opts.hint) {
        hintEl = mk("div", "modal-message");
        hintEl.id = "gs-prompt-hint";
        hintEl.textContent = opts.hint;
        card.append(hintEl);
      }
      card.append(input);

      // The reason the primary button is off, in the field's own words.
      const err = mk("div", "prompt-error");
      err.id = "gs-prompt-error";
      err.setAttribute("role", "alert");
      err.hidden = true;
      // "Use instead <name> [Use]" — a correction offered, never imposed.
      const sug = mk("div", "prompt-suggest");
      sug.hidden = true;
      const sugCode = mk("code");
      const sugUse = mk("button", "mini-btn prompt-suggest-use");
      sugUse.textContent = "Use";
      sugUse.title = "Replace what you typed with this";
      (sugUse as HTMLButtonElement).type = "button";
      const sugLead = mk("span");
      sugLead.textContent = "Use instead";
      sug.append(sugLead, sugCode, sugUse);
      if (opts.validate) {
        card.append(err, sug);
        input.spellcheck = false;
        input.setAttribute("autocapitalize", "off");
        input.setAttribute("autocomplete", "off");
        input.setAttribute("aria-describedby", `${hintEl ? "gs-prompt-hint " : ""}gs-prompt-error`);
      } else if (hintEl) {
        input.setAttribute("aria-describedby", "gs-prompt-hint");
      }

      let box: HTMLInputElement | undefined;
      if (opts.check) {
        const wrap = mk("label", "modal-check");
        box = document.createElement("input");
        box.type = "checkbox";
        box.checked = opts.check.checked;
        const relabel = (): void => {
          okSpan.textContent =
            box!.checked && opts.check!.okLabelChecked ? opts.check!.okLabelChecked : okLabel;
        };
        box.addEventListener("change", relabel);
        relabel();
        wrap.append(box, document.createTextNode(opts.check.label));
        card.append(wrap);
      }
      card.append(actions);

      const problem = (v: string): string | null =>
        (opts.validate ? VALIDATORS[opts.validate](v) : null) ?? opts.extra?.(v) ?? null;

      /**
       * THE COMPATIBILITY RULE: with no `opts.validate`, nothing below runs —
       * no listener, and `ok` never gets `disabled`. The harness (and several
       * Actions prompts) set `.modal-input.value` directly and click Ok WITHOUT
       * dispatching an `input` event; a disabled button fires no click, so a
       * blanket disable would turn those into silent no-ops.
       */
      const sync = (): void => {
        const v = input.value.trim();
        // An empty field is refusable but never shouted at — it starts empty,
        // and scolding someone before they have typed is hostile.
        const msg = v ? problem(v) : null;
        err.textContent = msg ?? "";
        err.hidden = !msg;
        input.classList.toggle("is-invalid", !!msg);
        input.setAttribute("aria-invalid", String(!!msg));
        const fix =
          opts.validate === "refName" && opts.suggest !== false && v && msg
            ? sanitizeRefName(v)
            : "";
        const offer = !!fix && fix !== v && !problem(fix);
        if (offer) sugCode.textContent = fix; // textContent: git allows < > & in a ref
        sug.hidden = !offer;
        if ((!v && !allowEmpty) || msg) ok.setAttribute("disabled", "true");
        else ok.removeAttribute("disabled");
      };
      if (opts.validate) {
        input.addEventListener("input", sync);
        sugUse.addEventListener("click", () => {
          input.value = sugCode.textContent ?? "";
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
          sync();
        });
        sync(); // so the button starts honest
      }

      const done = (): void => {
        if (opts.validate && problem(input.value.trim())) return;
        if (opts.check && box) opts.check.checked = box.checked;
        finish(submit(input.value), close);
      };
      cancel.addEventListener("click", () => finish(null, close));
      ok.addEventListener("click", done);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          done();
        }
      });
      return {
        card,
        focusEl: input,
        label: title,
        // A half-typed branch name is work; openModal already knows what to do.
        hasUnsavedWork: () => input.value.trim() !== value.trim(),
        onClose: () => {
          if (!settled) resolve(null);
        },
      };
    });
  });
}

/** One row of `promptChoice`. */
export interface ChoiceOption {
  id: string;
  label: string;
  /** What will actually happen, in full. It WRAPS — which is the whole reason
   *  this is a modal and not a menu. */
  sub: string;
  /** codicon name, without the `codicon-` prefix. */
  icon?: string;
}

/**
 * Ask a consequential either/or.
 *
 * Not a menu: a menu row's sub-label is one nowrap, ellipsised line on the
 * label's own row, so a sentence like "Push feat/x, track it, and delete
 * origin/feat-x" comes out truncated — and a menu needs an anchor, which is
 * gone by the time a question like this gets asked.
 *
 * Always resolves an id: Escape, the backdrop and Cancel all resolve
 * `cancelId`, so no caller can forget the null branch.
 */
export function promptChoice(opts: {
  title: string;
  hint?: string;
  choices: readonly ChoiceOption[];
  cancelId: string;
}): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    modal((close) => {
      const card = mk("div", "modal-card");
      const h = mk("div", "modal-title");
      h.textContent = opts.title;
      card.append(h);
      if (opts.hint) {
        const hint = mk("div", "modal-message");
        hint.textContent = opts.hint;
        card.append(hint);
      }
      const list = mk("div", "modal-choices");
      const rows: HTMLElement[] = [];
      for (const c of opts.choices) {
        const row = mk("button", "modal-choice");
        (row as HTMLButtonElement).type = "button";
        if (c.icon) row.append(gl(c.icon));
        const text = mk("div", "modal-choice-text");
        const label = mk("div", "modal-choice-label");
        label.textContent = c.label;
        const sub = mk("div", "modal-choice-sub");
        sub.textContent = c.sub;
        text.append(label, sub);
        row.append(text);
        // A pick IS the commit here — there is no confirm button to press after.
        row.addEventListener("click", () => {
          settled = true;
          resolve(c.id);
          close();
        });
        rows.push(row);
        list.append(row);
      }
      // Keys on the ROWS, never on document: a handler on document throws
      // inside any e.target.closest() guard and passes on a broken build.
      list.addEventListener("keydown", (e) => {
        const i = rows.indexOf(document.activeElement as HTMLElement);
        if (i < 0) return;
        let next = -1;
        if (e.key === "ArrowDown") next = (i + 1) % rows.length;
        else if (e.key === "ArrowUp") next = (i - 1 + rows.length) % rows.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = rows.length - 1;
        if (next < 0) return;
        e.preventDefault();
        rows[next].focus();
      });
      const actions = mk("div", "modal-actions");
      const cancel = mk("button", "mini-btn");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        settled = true;
        resolve(opts.cancelId);
        close();
      });
      actions.append(cancel);
      card.append(list, actions);
      return {
        card,
        focusEl: rows[0],
        label: opts.title,
        onClose: () => {
          if (!settled) resolve(opts.cancelId);
        },
      };
    });
  });
}

/**
 * Open a form, submit it, and give it BACK if the submit fails.
 *
 * Every create/edit flow in the app had the same shape: collect the text, close
 * the dialog, then send it. When the send failed — offline, a permissions error,
 * a validation the API rejects — the user got a toast and an empty screen, and
 * everything they had written was gone. For a release body or an issue
 * description that can be several minutes of work destroyed by one bad request.
 *
 * `submit` returns an error message to keep the loop going, or `undefined` when
 * it succeeded. On failure the form re-opens carrying exactly what was typed,
 * with the reason shown, so the fix is one edit away instead of a retype.
 */
export async function formWithRetry<V>(
  open: (seed: V | undefined, error: string | undefined) => Promise<V | null>,
  submit: (value: V) => Promise<string | undefined>,
): Promise<V | undefined> {
  let seed: V | undefined;
  let error: string | undefined;
  // Bounded: a submit that fails forever must not trap the user in a loop they
  // cannot leave. Cancelling (a null from `open`) exits immediately.
  for (let attempt = 0; attempt < 20; attempt++) {
    const value = await open(seed, error);
    if (value === null) return undefined; // the user chose to abandon it
    const failure = await submit(value);
    if (failure === undefined) return value;
    seed = value;
    error = failure;
  }
  return undefined;
}
