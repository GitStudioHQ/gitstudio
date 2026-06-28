// Shared in-app UI primitives — toasts, a confirm dialog, and a text prompt —
// used by both the main renderer and the commit context menu. Self-contained
// (no dependency on the renderer's DOM helpers) so any module can import them.
// These replace the native alert()/confirm()/prompt(), which are jarring (and,
// for prompt(), unsupported) in an Electron renderer.

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

interface ModalSpec {
  card: HTMLElement;
  focusEl: HTMLElement;
  /** Accessible name for the dialog (announced by screen readers). */
  label?: string;
  /** Called on ANY close (button or dismiss) — resolve a default if needed. */
  onClose: () => void;
}

/** Focus-trapping modal scaffold shared by confirmDialog + promptInline. */
function modal(build: (close: () => void) => ModalSpec): void {
  const prevFocus = document.activeElement as HTMLElement | null;
  const overlay = mk("div", "modal-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  let spec: ModalSpec;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    spec.onClose();
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    prevFocus?.focus?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const f = Array.from(
      spec.card.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])"),
    ).filter((n) => !n.hasAttribute("disabled"));
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
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);
  setTimeout(() => spec.focusEl.focus(), 0);
}

/** A styled confirmation dialog (replaces native confirm()); resolves true/false. */
export function confirmDialog(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
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
      card.append(h, body, actions);
      cancel.addEventListener("click", () => {
        settled = true;
        resolve(false);
        close();
      });
      ok.addEventListener("click", () => {
        settled = true;
        resolve(true);
        close();
      });
      return {
        card,
        focusEl: ok,
        label: opts.title,
        onClose: () => {
          if (!settled) resolve(false);
        },
      };
    });
  });
}

/** A modal text prompt (Electron's renderer has no window.prompt). */
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
