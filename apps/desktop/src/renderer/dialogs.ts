// Shared in-app UI primitives — toasts, a confirm dialog, and a text prompt —
// used by both the main renderer and the commit context menu. Self-contained
// (no dependency on the renderer's DOM helpers) so any module can import them.
// These replace the native alert()/confirm()/prompt(), which are jarring (and,
// for prompt(), unsupported) in an Electron renderer.

import { registerLayer, isMenuOpen} from "./overlays";

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
export function toast(message: string, kind: ToastKind = "info", timeoutMs?: number): void {
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
  t.append(icon, msg, close);
  stack.appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  let timer = 0;
  const dismiss = (): void => {
    if (!t.isConnected) return;
    window.clearTimeout(timer);
    t.classList.remove("in");
    t.classList.add("out");
    t.addEventListener("transitionend", () => t.remove(), { once: true });
    window.setTimeout(() => t.remove(), 280);
  };
  close.addEventListener("click", dismiss);
  timer = window.setTimeout(dismiss, timeoutMs ?? (kind === "error" ? 7000 : 4000));
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
  const close = (): void => {
    if (closed) return;
    closed = true;
    layer.release();
    const i = modalStack.indexOf(token);
    if (i >= 0) modalStack.splice(i, 1);
    spec.onClose();
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    prevFocus?.focus?.();
  };
  // A route change dismisses the modal like Esc would — but through `close`,
  // not `dismiss`, so a modal that refuses dismissal mid-clone still tears down
  // rather than being orphaned above a view it no longer belongs to.
  const layer = registerLayer(close);
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
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    modal((close) => {
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
      };
    });
  });
}

/** A modal text prompt (Electron's renderer has no window.prompt). */
/** A proper single-step form modal: a required title input + a body textarea →
 *  `{title, body}` or null. Replaces clumsy sequential prompts for issue/PR-style
 *  edits, so editing feels like GitHub, not a chain of one-line dialogs. */
export function editForm(opts: {
  title: string;
  okLabel?: string;
  titleValue?: string;
  titlePlaceholder?: string;
  bodyValue?: string;
  bodyPlaceholder?: string;
}): Promise<{ title: string; body: string } | null> {
  return new Promise((resolve) => {
    let settled = false;
    modal((close) => {
      const card = mk("div", "modal-card modal-card-form");
      const h = mk("div", "modal-title");
      h.textContent = opts.title;
      const titleInput = document.createElement("input");
      titleInput.className = "modal-input";
      titleInput.placeholder = opts.titlePlaceholder ?? "Title";
      titleInput.value = opts.titleValue ?? "";
      const bodyInput = document.createElement("textarea");
      bodyInput.className = "modal-input modal-textarea";
      bodyInput.placeholder = opts.bodyPlaceholder ?? "Description…";
      bodyInput.value = opts.bodyValue ?? "";
      bodyInput.rows = 7;
      const actions = mk("div", "modal-actions");
      const cancel = mk("button", "mini-btn");
      cancel.textContent = "Cancel";
      const ok = mk("button", "btn btn-primary modal-ok");
      const okSpan = mk("span");
      okSpan.textContent = opts.okLabel ?? "Save";
      ok.appendChild(okSpan);
      actions.append(cancel, ok);
      card.append(h, titleInput, bodyInput, actions);
      const done = (v: { title: string; body: string } | null): void => {
        settled = true;
        resolve(v);
        close();
      };
      const submit = (): void => {
        const t = titleInput.value.trim();
        if (!t) {
          titleInput.focus();
          return; // title is required
        }
        done({ title: t, body: bodyInput.value.trim() });
      };
      cancel.addEventListener("click", () => done(null));
      ok.addEventListener("click", submit);
      // Enter in the title moves to the body; ⌘/Ctrl+Enter anywhere submits.
      titleInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          bodyInput.focus();
        }
      });
      const metaSubmit = (e: KeyboardEvent): void => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      };
      titleInput.addEventListener("keydown", metaSubmit);
      bodyInput.addEventListener("keydown", metaSubmit);
      return {
        card,
        focusEl: titleInput,
        label: opts.title,
        onClose: () => {
          if (!settled) resolve(null);
        },
      };
    });
  });
}

export function promptInline(
  title: string,
  placeholder: string,
  value = "",
  okLabel = "Create",
  /** When true, an empty submission resolves "" (not null) — null then means
   *  ONLY an explicit cancel/dismiss. Lets callers tell "cleared" from "cancelled". */
  allowEmpty = false,
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
      const actions = mk("div", "modal-actions");
      const cancel = mk("button", "mini-btn");
      cancel.textContent = "Cancel";
      const ok = mk("button", "btn btn-primary modal-ok");
      const okSpan = mk("span");
      okSpan.textContent = okLabel;
      ok.appendChild(okSpan);
      actions.append(cancel, ok);
      card.append(h, input, actions);
      cancel.addEventListener("click", () => finish(null, close));
      ok.addEventListener("click", () => finish(submit(input.value), close));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(submit(input.value), close);
        }
      });
      return {
        card,
        focusEl: input,
        label: title,
        onClose: () => {
          if (!settled) resolve(null);
        },
      };
    });
  });
}
