// A new pull request, as one form: the branch it goes into and the one it
// comes from, its title and description (the repository's template when it
// has one), Draft, reviewers, assignees and labels — and a preview of the
// commits and files it will have. Not a chain of questions: everything is on
// one screen, and nothing is sent until Create.
//
// A typed DOM component, host-agnostic, like the list and the page beside it
// (prList.ts, prPage.ts): the extension mounts it in an editor tab
// (create-main.ts), and the desktop can mount the same class. It holds no
// GitHub state: the host sends a full PrCreateViewState after every change
// and hears back PrCreateMessageToHost. What the component owns is what the
// user typed and picked; it takes the host's PROPOSED title and description
// only while that field is untouched (`proposed.key` says when they were
// proposed from something new — another head, base or template).
//
// A state is PAINTED IN PLACE (conflicts/patch.ts): built into a detached
// copy, only what differs is written, so a state that lands while you type
// touches neither the box nor the scroll.
//
// Every control says what it does, in words; the glyphs are codicons from the
// shared vocabulary; colours go through the CSSOM (the page's CSP drops a
// style attribute).

import type {
  PrCreateFile,
  PrCreateMessageToHost,
  PrCreateViewState,
  PrListAction,
  PrListButton,
  PrListMessage,
  PrPerson,
} from "@gitstudio/host-bridge/prProtocol";
import { PR_ACTIONS } from "@gitstudio/engine/forge/pullRequests";
import { FILE_STATUS } from "@gitstudio/engine/forge/prPage";
import { commitList, pushWords } from "@gitstudio/engine/forge/prCreate";
import { patchChildren } from "../conflicts/patch";
import { ageWords } from "./prList";
import { avatarSrc } from "./avatarSrc";

export interface PullRequestCreateOptions {
  post(message: PrCreateMessageToHost): void;
}

// ── Small DOM helpers ────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function codicon(name: string, extra = ""): HTMLElement {
  const s = el("span", `codicon codicon-${name}${extra ? ` ${extra}` : ""}`);
  s.setAttribute("aria-hidden", "true");
  return s;
}

function button(cls: string, key: string, act: string, label?: string): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  b.dataset.key = key;
  b.dataset.act = act;
  if (label !== undefined) b.appendChild(el("span", "prp-btn-label", label));
  return b;
}

/**
 * A button's action, kept with the button — never written into the page and
 * parsed back out of it, where anything that can touch the DOM could change it.
 */
const BUTTON_ACTIONS = new WeakMap<Element, PrListAction>();


function hueOf(login: string): number {
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) % 360;
  return h;
}

function avatar(p: PrPerson | null | undefined, size: number): HTMLElement {
  const wrap = el("span", "prp-avatar");
  wrap.setAttribute("aria-hidden", "true");
  wrap.style.setProperty("--prp-avatar", `${size}px`);
  const login = p?.login ?? "ghost";
  const initial = el("span", "prp-avatar-initial", (login.replace(/^\W+/, "")[0] ?? "?").toUpperCase());
  initial.style.setProperty("--prp-hue", String(hueOf(login)));
  wrap.appendChild(initial);
  const src = avatarSrc(p?.avatarUrl);
  if (src) {
    const img = el("img", "prp-avatar-img");
    img.alt = "";
    img.src = src;
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.dataset.key = `img-${src}`;
    wrap.appendChild(img);
  }
  return wrap;
}

/**
 * Append children with a space between each: read aloud (or as text), the
 * pieces are words, not one run-on word. In a flex row the spaces take no room.
 */
function spaced(parent: HTMLElement, ...kids: (Node | string)[]): void {
  kids.forEach((k, i) => {
    if (i > 0) parent.append(" ");
    parent.append(k);
  });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// ── Pickers ──────────────────────────────────────────────────────────────────

type PickerKind = "base" | "head" | "push" | "target" | "template" | "reviewers" | "assignees" | "labels";

interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  icon?: string;
  lead?: HTMLElement;
  checked?: boolean;
}

const PICKER_WORDS: Record<PickerKind, { title: string; filter: string; empty: string }> = {
  base: { title: "The branch it goes into", filter: "Find a branch, or type one", empty: "No branch matches" },
  head: { title: "The branch it comes from", filter: "Find a branch", empty: "No branch matches" },
  push: { title: "Push it to", filter: "Find a remote", empty: "No remote matches" },
  target: { title: "The repository it opens on", filter: "Find a repository", empty: "No repository matches" },
  template: { title: "Start the description from", filter: "Find a template", empty: "No template matches" },
  reviewers: { title: "Ask for a review from", filter: "Find someone, or type a login", empty: "No one matches" },
  assignees: { title: "Assign it to", filter: "Find someone, or type a login", empty: "No one matches" },
  labels: { title: "Label it", filter: "Find a label", empty: "No label matches" },
};

// ── The component ────────────────────────────────────────────────────────────

export class PullRequestCreate {
  private state: PrCreateViewState | undefined;
  private readonly view: HTMLElement;
  private readonly layer: HTMLElement;
  private title = "";
  private body = "";
  private titleTouched = false;
  private bodyTouched = false;
  private proposedKey: string | undefined;
  private aiSeq = -1;
  /** A template was picked: its text joins a description already written, never replaces it. */
  private templateAsked = false;
  private draft = false;
  private readonly reviewers: string[] = [];
  private readonly assignees: string[] = [];
  private readonly labels: string[] = [];
  /** Tried to create with something missing: say what, in place. */
  private tried = false;
  private picker: { kind: PickerKind; anchor: HTMLElement; el: HTMLElement; query: string; input?: HTMLInputElement; width?: number } | undefined;
  private focusAfter: string | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: PullRequestCreateOptions,
  ) {
    this.view = el("div", "prp prc");
    this.view.setAttribute("role", "main");
    this.view.setAttribute("aria-label", "New pull request");
    this.layer = el("div", "prp-layer prc-layer");
    this.root.append(this.view, this.layer);
    this.view.addEventListener("click", (e) => this.onClick(e));
    this.view.addEventListener("input", (e) => this.onInput(e));
    this.view.addEventListener("change", (e) => this.onChange(e));
    this.view.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.layer.addEventListener("keydown", (e) => this.onPickerKey(e));
    this.view.addEventListener(
      "error",
      (e) => {
        const t = e.target as HTMLElement | null;
        if (t instanceof HTMLImageElement && t.classList.contains("prp-avatar-img")) t.closest(".prp-avatar")?.classList.add("is-broken");
      },
      true,
    );
    document.addEventListener("mousedown", (e) => {
      const p = this.picker;
      if (p && !p.el.contains(e.target as Node) && !p.anchor.contains(e.target as Node)) this.closePicker(false);
    });
    window.addEventListener("blur", () => this.closePicker(false));
    window.addEventListener("resize", () => this.closePicker(false));
    window.addEventListener(
      "scroll",
      (e) => {
        if (this.picker && !this.picker.el.contains(e.target as Node)) this.closePicker(false);
      },
      true,
    );
    opts.post({ type: "ready" });
  }

  /** Paint a state from the host. An older one than on screen is ignored. */
  render(state: PrCreateViewState): void {
    if (this.state && state.seq < this.state.seq) return;
    this.state = state;
    if (state.proposed.key !== this.proposedKey) {
      const first = this.proposedKey === undefined;
      this.proposedKey = state.proposed.key;
      if (!this.titleTouched) this.title = state.proposed.title;
      if (!this.bodyTouched || !this.body.trim()) this.body = state.proposed.body;
      else if (this.templateAsked && state.proposed.bodyFrom === "template") this.body = `${this.body.replace(/\s+$/, "")}\n\n${state.proposed.body}`;
      this.templateAsked = false;
      if (first && state.status === "ready") this.focusAfter = ".prc-title";
    }
    if (state.aiBody && state.aiBody.seq !== this.aiSeq) {
      this.aiSeq = state.aiBody.seq;
      this.body = state.aiBody.body;
      this.bodyTouched = true;
    }
    // A choice the repository no longer offers is dropped (another target).
    if (state.options) {
      const people = new Set(state.options.people.map((p) => p.login.toLowerCase()));
      const labelNames = new Set(state.options.labels.map((l) => l.name));
      const keepTyped = (x: string) => people.has(x.toLowerCase()) || LOGIN.test(x);
      retain(this.reviewers, keepTyped);
      retain(this.assignees, keepTyped);
      retain(this.labels, (x) => labelNames.has(x));
    }
    if (!state.canSetMetadata) {
      this.reviewers.length = 0;
      this.assignees.length = 0;
      this.labels.length = 0;
    }
    this.paint();
    if (this.focusAfter && state.status === "ready") {
      const sel = this.focusAfter;
      this.focusAfter = undefined;
      this.view.querySelector<HTMLElement>(sel)?.focus();
    }
  }

  private paint(): void {
    const s = this.state;
    if (!s) return;
    const fresh = el("div");
    this.build(fresh, s);
    patchChildren(this.view, fresh);
    this.syncFields();
    if (this.picker) this.drawPicker(false);
  }

  /** The boxes show what the component holds (a proposal, a draft) — never touched while they agree. */
  private syncFields(): void {
    const t = this.view.querySelector<HTMLInputElement>(".prc-title");
    if (t && t.value !== this.title) t.value = this.title;
    const b = this.view.querySelector<HTMLTextAreaElement>(".prc-body");
    if (b && b.value !== this.body) b.value = this.body;
    const d = this.view.querySelector<HTMLInputElement>(".prc-draft");
    if (d && d.checked !== this.draft) d.checked = this.draft;
  }

  // ── Building ───────────────────────────────────────────────────────────────

  private build(into: HTMLElement, s: PrCreateViewState): void {
    const progress = el("div", `prp-progress${s.refreshing || s.status === "loading" || s.busy || s.compare.status === "loading" ? " is-on" : ""}`);
    progress.setAttribute("aria-hidden", "true");
    progress.appendChild(el("span", "prp-progress-bar"));
    into.appendChild(progress);
    const page = el("div", "prp-page prc-page");
    into.appendChild(page);
    page.appendChild(this.buildHead(s));
    if (s.status === "message" && s.message) {
      page.appendChild(this.buildMessage(s.message, "prp-message", "message"));
      return;
    }
    if (s.notice) page.appendChild(this.buildMessage(s.notice, "prp-notice", "notice"));
    if (s.existing) page.appendChild(this.buildExisting(s));
    if (s.status === "loading") {
      page.appendChild(this.buildSkeleton());
      return;
    }
    const grid = el("div", "prc-grid");
    const [fields, foot] = this.buildMain(s);
    grid.append(fields, this.buildSide(s), foot);
    page.appendChild(grid);
    page.appendChild(this.buildPreview(s));
  }

  private buildHead(s: PrCreateViewState): HTMLElement {
    const head = el("header", "prp-head prc-head");
    const crumb = el("div", "prp-crumb");
    if (s.targets.length > 1) {
      const t = button("prc-crumb-btn", "pick-target", "pick");
      t.dataset.picker = "target";
      t.append(codicon("repo"), el("span", "prc-crumb-repo", s.target), codicon("chevron-down"));
      t.title = `Opens on ${s.target} — choose another repository`;
      t.setAttribute("aria-haspopup", "listbox");
      t.setAttribute("aria-label", `Repository: ${s.target}. Choose another`);
      crumb.appendChild(t);
    } else {
      crumb.append(codicon("repo"), el("span", "prp-crumb-repo", s.target));
    }
    head.appendChild(crumb);
    const titleRow = el("div", "prp-title-row");
    const h1 = el("h1", "prp-title", PR_ACTIONS.newPullRequest.label);
    titleRow.appendChild(h1);
    // Read the branches and GitHub again: a commit, a pull or a push made
    // elsewhere is read on its own; this is for anything else (a branch
    // pushed from another machine, a template just added on GitHub).
    const refresh = button("prp-icon-btn prc-refresh", "refresh", "refresh");
    refresh.appendChild(codicon("refresh"));
    refresh.title = "Refresh — read the branches and GitHub again";
    refresh.setAttribute("aria-label", "Refresh: read the branches and GitHub again");
    refresh.disabled = !!s.busy || s.status === "loading";
    titleRow.appendChild(refresh);
    head.appendChild(titleRow);

    if (s.status !== "message") {
      const flow = el("div", "prc-flow");
      flow.setAttribute("role", "group");
      flow.setAttribute("aria-label", "Branches");
      const arrow = el("span", "prc-flow-arrow");
      arrow.appendChild(codicon("arrow-left"));
      const h = s.head;
      const fork = !!h?.owner && h.ref.includes(":");
      const sum = el("span", "prc-flow-sum");
      if (s.compare.status === "ready") {
        const c = s.compare;
        spaced(sum, el("span", "", plural(c.commitsTotal, "commit")), el("span", "prp-dot", "·"), el("span", "", plural(c.files.length, "file")));
        if (c.additions > 0 || c.deletions > 0) {
          sum.append(" ");
          spaced(sum, el("span", "prp-dot", "·"), el("span", "prp-add", `+${c.additions.toLocaleString("en-US")}`), el("span", "prp-del", `−${c.deletions.toLocaleString("en-US")}`));
        }
      } else if (s.compare.status === "loading") {
        sum.textContent = "Comparing…";
      }
      spaced(
        flow,
        el("span", "prc-flow-word", "Into"),
        this.branchButton("base", s.base, "git-branch", s.base ? `Into ${s.base} — choose the branch it goes into` : "Choose the branch it goes into", "Pick a base"),
        arrow,
        el("span", "prc-flow-word", "from"),
        this.branchButton("head", h ? h.ref : undefined, fork ? "repo-forked" : "git-branch", h ? `From ${h.ref} — choose the branch it comes from` : "Choose the branch it comes from", "Pick a branch"),
        sum,
      );
      head.appendChild(flow);
    }
    return head;
  }

  private branchButton(kind: "base" | "head", name: string | undefined, icon: string, title: string, empty: string): HTMLButtonElement {
    const b = button(`prc-branch${name ? "" : " is-empty"}`, `pick-${kind}`, "pick");
    b.dataset.picker = kind;
    b.append(codicon(icon), el("span", "prc-branch-name", name ?? empty), codicon("chevron-down", "prc-branch-chevron"));
    b.title = title;
    b.setAttribute("aria-haspopup", "listbox");
    b.setAttribute("aria-label", title);
    b.disabled = !!this.state?.busy;
    return b;
  }

  private buildExisting(s: PrCreateViewState): HTMLElement {
    const e = s.existing!;
    const box = el("div", "prp-notice tone-info prc-existing");
    box.dataset.key = `existing-${e.number}`;
    box.setAttribute("role", "status");
    const icon = el("span", "prp-notice-icon");
    icon.appendChild(codicon(e.draft ? "git-pull-request-draft" : "git-pull-request"));
    box.appendChild(icon);
    const body = el("div", "prp-notice-body");
    body.appendChild(el("div", "prp-notice-title", `${s.head?.branch ?? "This branch"} already has an open pull request`));
    body.appendChild(el("div", "prp-notice-detail", `#${e.number} ${e.title}`));
    const row = el("div", "prp-notice-buttons");
    const open = button("gs-btn gs-btn--primary prp-btn", "open-existing", "openExisting");
    open.append(codicon("git-pull-request"), el("span", "prp-btn-label", `Open #${e.number}`));
    open.title = `Open pull request #${e.number}`;
    row.appendChild(open);
    body.appendChild(row);
    box.appendChild(body);
    return box;
  }

  /** The fields, and the foot with Create — apart, so a narrow form puts the rail between them. */
  private buildMain(s: PrCreateViewState): [HTMLElement, HTMLElement] {
    const main = el("div", "prc-main");
    const busy = !!s.busy;
    const titleProblem = this.tried && !this.title.trim();

    const tf = el("label", "prp-field prc-title-field");
    tf.appendChild(el("span", "prp-field-label", "Title"));
    const title = el("input", `prp-input prc-title${titleProblem ? " is-invalid" : ""}`);
    title.type = "text";
    title.dataset.key = "title";
    title.spellcheck = true;
    title.placeholder = "What the pull request does";
    title.setAttribute("aria-label", "Title");
    title.setAttribute("aria-required", "true");
    if (titleProblem) {
      title.setAttribute("aria-invalid", "true");
      title.setAttribute("aria-describedby", "prc-title-problem");
    }
    title.disabled = busy;
    tf.appendChild(title);
    if (titleProblem) {
      const p = el("span", "prc-field-problem", "A title is required.");
      p.id = "prc-title-problem";
      tf.appendChild(p);
    }
    main.appendChild(tf);

    const bf = el("div", "prp-field prc-body-field");
    const bh = el("div", "prc-body-head");
    const bl = el("label", "prp-field-label", "Description");
    bl.htmlFor = "prc-body";
    bh.appendChild(bl);
    const tools = el("div", "prc-tools");
    tools.setAttribute("role", "toolbar");
    tools.setAttribute("aria-label", "Description");
    if (s.templates.length > 0) {
      const t = button("prp-ghost prc-tool", "pick-template", "pick");
      t.dataset.picker = "template";
      t.append(codicon("file"), el("span", "", s.template ? `Template: ${baseName(s.template)}` : "Template"), codicon("chevron-down"));
      t.title = "Start the description from one of the repository's templates";
      t.setAttribute("aria-haspopup", "listbox");
      t.disabled = busy;
      tools.appendChild(t);
    }
    if (s.compare.commits.length > 0) {
      const c = button("prp-ghost prc-tool", "insert-commits", "insertCommits");
      c.append(codicon("list-unordered"), el("span", "", "Commit list"));
      c.title = "Add the commits to the description, as a list";
      c.disabled = busy;
      tools.appendChild(c);
    }
    if (s.ai) {
      const a = button("prp-ghost prc-tool", "ai-draft", "aiDraft");
      a.append(codicon(s.busy === "ai" ? "loading" : "sparkle", s.busy === "ai" ? "codicon-modifier-spin" : ""), el("span", "", s.busy === "ai" ? "Drafting…" : "Draft with AI"));
      a.title = "Write the description from the commits and the diff with GitBrain (replaces what is there)";
      a.disabled = busy || s.compare.status !== "ready";
      tools.appendChild(a);
    }
    bh.appendChild(tools);
    bf.appendChild(bh);
    const body = el("textarea", "prp-textarea prc-body");
    body.id = "prc-body";
    body.dataset.key = "body";
    body.rows = 12;
    body.placeholder = "Describe the change. Markdown is fine.";
    body.disabled = busy;
    bf.appendChild(body);
    main.appendChild(bf);

    const draft = el("label", "prp-check prc-draft-row");
    const box = el("input", "prp-check-input prc-draft");
    box.type = "checkbox";
    box.dataset.key = "draft";
    box.dataset.act = "draft";
    box.disabled = busy;
    const words = el("span", "prc-draft-text");
    words.append(el("span", "prp-check-label", "Create as draft"), el("span", "prp-hint", "A draft can't be merged until it's marked ready."));
    draft.append(box, words);
    main.appendChild(draft);

    const foot = el("div", "prc-foot");
    const push = s.head ? pushWords(s.head) : undefined;
    // The title's own problem is said at the title; this line is the host's reason.
    const problem = s.problem;
    // Where the branch is pushed, when a push is in question: another of
    // the clone's GitHub remotes can be picked (your fork, the repository
    // it opens on).
    const elsewhere = (s.pushRemotes ?? []).some((r) => r.name !== s.head?.remote);
    const pushAt = (line: HTMLElement) => {
      if (!elsewhere || !s.head) return;
      const b = button("prp-link prc-push-pick", "pick-push", "pick");
      b.dataset.picker = "push";
      b.append(el("span", "", "Push to another remote"), codicon("chevron-down", "prc-push-chevron"));
      b.title = s.head.remote ? `Pushed to ${s.head.remote} — choose another of this clone's GitHub remotes` : "Choose where to push it";
      b.setAttribute("aria-haspopup", "listbox");
      b.disabled = busy;
      line.append(" ", b);
    };
    if (push && !s.problem) {
      const p = el("p", "prc-note");
      p.dataset.key = "push-note";
      const words = el("span", "prc-note-text", push);
      pushAt(words);
      p.append(codicon("cloud-upload"), words);
      foot.appendChild(p);
    }
    if (problem) {
      const p = el("p", "prc-note prc-problem");
      p.dataset.key = "problem";
      p.id = "prc-problem";
      p.setAttribute("role", "status");
      const words = el("span", "prc-note-text", problem);
      if (s.head?.push === "diverged" || s.head?.push === "unknown") pushAt(words);
      p.append(codicon("info"), words);
      foot.appendChild(p);
    }
    const buttons = el("div", "prp-panel-foot prc-buttons");
    const needsPush = s.head?.push === "new" || s.head?.push === "ahead";
    const create = button("gs-btn gs-btn--primary prp-btn prc-create", "create", "create");
    create.append(
      codicon(s.busy === "create" ? "loading" : "git-pull-request", s.busy === "create" ? "codicon-modifier-spin" : ""),
      el("span", "prp-btn-label", s.busy === "create" ? (needsPush ? "Pushing and creating…" : "Creating…") : needsPush ? "Push and create pull request" : "Create pull request"),
    );
    create.title = needsPush ? `Push ${s.head?.branch}, then create the pull request on ${s.target}` : `Create the pull request on ${s.target}`;
    create.disabled = busy || !!s.problem || s.status !== "ready";
    if (s.problem) create.setAttribute("aria-describedby", "prc-problem");
    const cancel = button("gs-btn prp-btn prc-cancel", "cancel", "cancel", "Cancel");
    cancel.title = "Close this form — nothing is created";
    cancel.disabled = s.busy === "create";
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const keys = el("span", "prp-hint prc-keys", `${mac ? "Cmd" : "Ctrl"}+Enter creates it`);
    buttons.append(create, cancel, keys);
    foot.appendChild(buttons);
    return [main, foot];
  }

  private buildSide(s: PrCreateViewState): HTMLElement {
    const side = el("aside", "prp-rail prc-side");
    side.setAttribute("aria-label", "Reviewers, assignees and labels");
    const people = new Map((s.options?.people ?? []).map((p) => [p.login.toLowerCase(), p] as const));
    const personOf = (login: string): PrPerson => people.get(login.toLowerCase()) ?? { login, avatarUrl: null };
    const section = (kind: "reviewers" | "assignees" | "labels", title: string, content: HTMLElement[], empty: string, extra?: HTMLElement) => {
      const sec = el("section", "prp-rail-section prc-side-section");
      sec.dataset.key = `side-${kind}`;
      const h = el("div", "prc-side-head");
      h.appendChild(el("h2", "prp-rail-title", title));
      const edit = button("prp-icon-btn prc-side-edit", `pick-${kind}`, "pick");
      edit.dataset.picker = kind;
      edit.appendChild(codicon("gear"));
      edit.title = s.canSetMetadata ? `Choose ${title.toLowerCase()}` : (s.metadataNote ?? "");
      edit.setAttribute("aria-label", `Choose ${title.toLowerCase()}`);
      edit.setAttribute("aria-haspopup", "listbox");
      edit.disabled = !s.canSetMetadata || !!s.busy;
      h.appendChild(edit);
      sec.appendChild(h);
      if (content.length === 0) sec.appendChild(el("p", "prp-rail-empty", empty));
      else for (const c of content) sec.appendChild(c);
      if (extra) sec.appendChild(extra);
      return sec;
    };
    const personRow = (login: string, kind: string) => {
      const row = el("div", "prp-person");
      row.dataset.key = `${kind}-${login}`;
      row.append(avatar(personOf(login), 20), el("span", "prp-person-name", login));
      const x = button("prp-icon-btn prc-remove", `remove-${kind}-${login}`, "remove");
      x.dataset.kind = kind;
      x.dataset.value = login;
      x.appendChild(codicon("close"));
      x.title = `Remove ${login}`;
      x.setAttribute("aria-label", `Remove ${login}`);
      x.disabled = !!s.busy;
      row.appendChild(x);
      return row;
    };
    side.appendChild(section("reviewers", "Reviewers", this.reviewers.map((l) => personRow(l, "reviewers")), "No one yet"));
    let assignSelf: HTMLElement | undefined;
    if (s.canSetMetadata && s.viewer && this.assignees.length === 0) {
      assignSelf = button("prp-link prc-self", "assign-self", "assignSelf");
      assignSelf.textContent = "Assign yourself";
      assignSelf.title = `Assign it to ${s.viewer.login}`;
    }
    side.appendChild(section("assignees", "Assignees", this.assignees.map((l) => personRow(l, "assignees")), "No one", assignSelf));
    const colors = new Map((s.options?.labels ?? []).map((l) => [l.name, l.color] as const));
    const labelRow = el("div", "prp-labels");
    for (const name of this.labels) {
      const chip = el("span", "prp-label prc-label");
      chip.dataset.key = `label-${name}`;
      chip.style.setProperty("--prp-label", `#${colors.get(name) ?? "888888"}`);
      chip.appendChild(el("span", "", name));
      const x = button("prc-label-x", `remove-labels-${name}`, "remove");
      x.dataset.kind = "labels";
      x.dataset.value = name;
      x.appendChild(codicon("close"));
      x.title = `Remove the label ${name}`;
      x.setAttribute("aria-label", `Remove the label ${name}`);
      x.disabled = !!s.busy;
      chip.appendChild(x);
      labelRow.appendChild(chip);
    }
    side.appendChild(section("labels", "Labels", this.labels.length ? [labelRow] : [], "None yet"));
    if (!s.canSetMetadata && s.metadataNote) side.appendChild(el("p", "prp-hint prc-side-note", s.metadataNote));
    return side;
  }

  private buildPreview(s: PrCreateViewState): HTMLElement {
    const box = el("section", "prc-preview");
    box.setAttribute("aria-label", "What the pull request will have");
    const c = s.compare;
    if (c.status === "failed") {
      box.appendChild(this.buildMessage({ icon: "warning", tone: "warning", title: "Couldn't compare the branches", detail: c.error, buttons: [{ label: "Retry", icon: "refresh", action: { kind: "retry" } }] }, "prp-notice", "compare-failed"));
      return box;
    }
    if (c.stale) {
      box.appendChild(el("p", "prp-hint prc-stale", `Compared with ${s.base} as last fetched: GitHub couldn't be reached.`));
    }
    // Commits.
    const commits = el("div", "prc-block");
    commits.dataset.key = "block-commits";
    const ch = el("h2", "prc-block-title");
    ch.append(codicon("git-commit"), el("span", "", "Commits"), el("span", "prp-count", c.status === "ready" ? c.commitsTotal.toLocaleString("en-US") : "…"));
    commits.appendChild(ch);
    if (c.status === "loading" || c.status === "idle") {
      commits.appendChild(this.rowsSkeleton("commits"));
    } else if (c.commits.length === 0) {
      commits.appendChild(el("p", "prp-empty prc-empty", s.head && s.base ? `${s.head.branch} has no commits that ${s.base} doesn't.` : "Pick both branches to see what it will have."));
    } else {
      const list = el("ol", "prc-commits");
      for (const k of c.commits) {
        const li = el("li", "prc-commit");
        li.dataset.key = `commit-${k.sha}`;
        const sha = el("code", "prc-sha", k.shortSha);
        sha.title = k.sha;
        const subject = el("span", "prc-subject", k.subject);
        subject.title = k.subject;
        const meta = el("span", "prc-commit-meta", `${k.author} · ${ageWords(k.date, s.now)}`);
        spaced(li, codicon("git-commit", "prc-commit-glyph"), subject, meta, sha);
        list.appendChild(li);
      }
      commits.appendChild(list);
      if (c.commitsTotal > c.commits.length) commits.appendChild(el("p", "prp-hint", `The first ${c.commits.length.toLocaleString("en-US")} of ${c.commitsTotal.toLocaleString("en-US")} commits.`));
    }
    box.appendChild(commits);
    // Files.
    const files = el("div", "prc-block");
    files.dataset.key = "block-files";
    const fh = el("h2", "prc-block-title");
    fh.append(codicon("code"), el("span", "", "Files changed"), el("span", "prp-count", c.status === "ready" ? c.files.length.toLocaleString("en-US") : "…"));
    if (c.status === "ready" && (c.additions > 0 || c.deletions > 0)) {
      const stat = el("span", "prc-block-stat");
      stat.append(el("span", "prp-add", `+${c.additions.toLocaleString("en-US")}`), el("span", "prp-del", `−${c.deletions.toLocaleString("en-US")}`));
      fh.appendChild(stat);
    }
    files.appendChild(fh);
    if (c.status === "loading" || c.status === "idle") {
      files.appendChild(this.rowsSkeleton("files"));
    } else if (c.files.length === 0) {
      files.appendChild(el("p", "prp-empty prc-empty", "No files change."));
    } else {
      const list = el("ul", "prc-files");
      for (const f of c.files) list.appendChild(this.fileRow(f));
      files.appendChild(list);
    }
    box.appendChild(files);
    return box;
  }

  private fileRow(f: PrCreateFile): HTMLElement {
    const li = el("li", "prc-file-item");
    const b = button("prc-file", `file-${f.path}`, "openFile");
    b.dataset.path = f.path;
    const st = FILE_STATUS[f.status];
    const letter = el("span", `prp-file-status is-${st.tone}`, st.letter);
    letter.title = st.word;
    letter.setAttribute("aria-hidden", "true");
    const slash = f.path.lastIndexOf("/");
    const name = el("span", "prc-file-name", slash >= 0 ? f.path.slice(slash + 1) : f.path);
    const dir = el("span", "prc-file-dir", slash >= 0 ? f.path.slice(0, slash) : "");
    const counts = el("span", "prc-file-counts");
    if (f.binary) counts.appendChild(el("span", "prp-hint", "Binary"));
    else spaced(counts, ...[...(f.additions > 0 ? [el("span", "prp-add", `+${f.additions}`)] : []), ...(f.deletions > 0 ? [el("span", "prp-del", `−${f.deletions}`)] : [])]);
    spaced(b, letter, name, dir, counts);
    const was = f.previousPath ? ` (renamed from ${f.previousPath})` : "";
    b.title = `${f.path}${was} — ${st.word}. Open its diff`;
    b.setAttribute("aria-label", `${st.word}: ${f.path}${was}. Open its diff`);
    li.appendChild(b);
    return li;
  }

  private rowsSkeleton(key: string): HTMLElement {
    const sk = el("div", "prc-rows-sk");
    sk.dataset.key = `sk-${key}`;
    sk.setAttribute("aria-busy", "true");
    sk.setAttribute("aria-label", key === "commits" ? "Loading the commits" : "Loading the files");
    for (let i = 0; i < 3; i++) sk.appendChild(el("span", "prp-sk prc-sk-row"));
    return sk;
  }

  private buildSkeleton(): HTMLElement {
    const sk = el("div", "prp-skeleton");
    sk.setAttribute("aria-busy", "true");
    sk.setAttribute("aria-label", "Loading the form");
    for (const w of ["line-1", "block", "line-2", "block-2"]) sk.appendChild(el("span", `prp-sk prp-sk-${w}`));
    return sk;
  }

  private buildMessage(m: PrListMessage, cls: string, key: string): HTMLElement {
    const box = el("div", `${cls} tone-${m.tone}`);
    box.dataset.key = `${key}-${m.title}`;
    box.setAttribute("role", m.tone === "error" ? "alert" : "status");
    const icon = el("span", `${cls}-icon`);
    icon.appendChild(codicon(m.icon));
    box.appendChild(icon);
    const body = el("div", `${cls}-body`);
    body.appendChild(el("div", `${cls}-title`, m.title));
    if (m.detail) body.appendChild(el("div", `${cls}-detail`, m.detail));
    if (m.buttons.length > 0) {
      const row = el("div", `${cls}-buttons`);
      m.buttons.forEach((b, i) => row.appendChild(this.actionButton(b, `${key}-btn-${i}`)));
      body.appendChild(row);
    }
    box.appendChild(body);
    return box;
  }

  private actionButton(b: PrListButton, key: string): HTMLButtonElement {
    const btn = button(`gs-btn prp-btn${b.primary ? " gs-btn--primary" : ""}`, key, "action");
    BUTTON_ACTIONS.set(btn, b.action);
    if (b.icon) btn.appendChild(codicon(b.icon));
    btn.appendChild(el("span", "prp-btn-label", b.label));
    if (b.title) btn.title = b.title;
    return btn;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private onInput(e: Event): void {
    const t = e.target as HTMLElement;
    if (t.classList.contains("prc-title")) {
      this.title = (t as HTMLInputElement).value;
      this.titleTouched = true;
      if (this.tried && this.title.trim()) this.paint();
    } else if (t.classList.contains("prc-body")) {
      this.body = (t as HTMLTextAreaElement).value;
      this.bodyTouched = true;
    }
  }

  private onChange(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.dataset.act === "draft") this.draft = t.checked;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.create();
    }
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!t || (t as HTMLButtonElement).disabled) return;
    const s = this.state;
    switch (t.dataset.act) {
      case "pick":
        if (this.picker?.anchor === t) this.closePicker(true);
        else this.openPicker(t.dataset.picker as PickerKind, t);
        return;
      case "create":
        this.create();
        return;
      case "refresh":
        this.opts.post({ type: "refresh" });
        return;
      case "cancel":
        this.opts.post({ type: "cancel" });
        return;
      case "openExisting":
        this.opts.post({ type: "openExisting" });
        return;
      case "insertCommits": {
        const list = commitList(s?.compare.commits ?? []);
        if (!list) return;
        this.body = this.body.trim() ? `${this.body.replace(/\s+$/, "")}\n\n${list}` : list;
        this.bodyTouched = true;
        this.syncFields();
        this.view.querySelector<HTMLTextAreaElement>(".prc-body")?.focus();
        return;
      }
      case "aiDraft":
        this.opts.post({ type: "aiDraft" });
        return;
      case "openFile":
        if (t.dataset.path) this.opts.post({ type: "openFile", path: t.dataset.path });
        return;
      case "remove": {
        const list = this.listOf(t.dataset.kind as "reviewers" | "assignees" | "labels");
        const i = list.indexOf(t.dataset.value ?? "");
        if (i >= 0) list.splice(i, 1);
        this.paint();
        return;
      }
      case "assignSelf":
        if (s?.viewer && !this.assignees.includes(s.viewer.login)) this.assignees.push(s.viewer.login);
        this.paint();
        return;
      case "action":
        {
          const action = BUTTON_ACTIONS.get(t);
          if (action) this.opts.post({ type: "action", action });
        }
        return;
    }
  }

  private listOf(kind: "reviewers" | "assignees" | "labels"): string[] {
    return kind === "reviewers" ? this.reviewers : kind === "assignees" ? this.assignees : this.labels;
  }

  /** Create: everything typed and picked goes, in one message. */
  private create(): void {
    const s = this.state;
    if (!s || s.busy || s.status !== "ready" || s.problem) return;
    if (!this.title.trim()) {
      this.tried = true;
      this.paint();
      this.view.querySelector<HTMLElement>(".prc-title")?.focus();
      return;
    }
    this.closePicker(false);
    this.opts.post({
      type: "create",
      title: this.title.trim(),
      body: this.body,
      draft: this.draft,
      reviewers: [...this.reviewers],
      assignees: [...this.assignees],
      labels: [...this.labels],
    });
  }

  // ── Pickers ────────────────────────────────────────────────────────────────

  private openPicker(kind: PickerKind, anchor: HTMLElement): void {
    this.closePicker(false);
    const m = el("div", "prp-menu prc-picker");
    this.picker = { kind, anchor, el: m, query: "" };
    anchor.setAttribute("aria-expanded", "true");
    this.layer.appendChild(m);
    this.drawPicker(true);
  }

  private itemsFor(kind: PickerKind, q: string): { items: PickerItem[]; typed?: PickerItem; multi: boolean } {
    const s = this.state!;
    const match = (text: string) => !q || text.toLowerCase().includes(q.toLowerCase());
    switch (kind) {
      case "base": {
        const items = s.bases.filter((b) => match(b.name)).map((b) => ({ id: b.name, label: b.name, icon: "git-branch", checked: b.name === s.base, ...(b.isDefault ? { detail: "default" } : {}) }));
        const t = q.trim();
        const typed = t && !s.bases.some((b) => b.name === t) && /^[^\s~^:?*[\\]+$/.test(t) && !t.startsWith("-") ? { id: t, label: `Use ${t}`, icon: "edit", detail: "a branch not listed" } : undefined;
        return { items, ...(typed ? { typed } : {}), multi: false };
      }
      case "head":
        return {
          items: s.branches.filter((b) => match(b.name)).map((b) => ({ id: b.name, label: b.name, icon: "git-branch", checked: b.name === s.head?.branch, ...(b.current ? { detail: "checked out" } : {}) })),
          multi: false,
        };
      case "push":
        return {
          items: (s.pushRemotes ?? [])
            .filter((r) => match(`${r.name} ${r.repo}`))
            .map((r) => ({ id: r.name, label: r.name, icon: "repo", detail: r.detail ? `${r.repo} — ${r.detail}` : r.repo, checked: r.name === s.head?.remote })),
          multi: false,
        };
      case "target":
        return { items: s.targets.filter((t) => match(t.id)).map((t) => ({ id: t.id, label: t.id, icon: "repo", detail: t.detail, checked: t.id === s.target })), multi: false };
      case "template":
        return {
          items: [
            ...(match("none") ? [{ id: "", label: "No template", icon: "circle-slash", checked: !s.template }] : []),
            ...s.templates.filter((t) => match(t.filename)).map((t) => ({ id: t.filename, label: baseName(t.filename), detail: t.filename, icon: "file", checked: t.filename === s.template })),
          ],
          multi: false,
        };
      case "labels":
        return {
          items: (s.options?.labels ?? [])
            .filter((l) => match(l.name))
            .map((l) => {
              const sw = el("span", "prc-swatch");
              sw.style.setProperty("--prp-label", `#${l.color}`);
              return { id: l.name, label: l.name, lead: sw, checked: this.labels.includes(l.name), ...(l.description ? { detail: l.description } : {}) };
            }),
          multi: true,
        };
      default: {
        const chosen = this.listOf(kind);
        const viewer = s.viewer?.login;
        const people = (s.options?.people ?? []).filter((p) => match(p.login) && !(kind === "reviewers" && viewer && p.login.toLowerCase() === viewer.toLowerCase()));
        const items: PickerItem[] = people.map((p) => ({ id: p.login, label: p.login, lead: avatar(p, 16), checked: chosen.some((c) => c.toLowerCase() === p.login.toLowerCase()), ...(viewer && p.login.toLowerCase() === viewer.toLowerCase() ? { detail: "you" } : {}) }));
        for (const c of chosen) if (!items.some((i) => i.id.toLowerCase() === c.toLowerCase()) && match(c)) items.unshift({ id: c, label: c, icon: "account", checked: true });
        const t = q.trim().replace(/^@/, "");
        const typed = t && LOGIN.test(t) && !items.some((i) => i.id.toLowerCase() === t.toLowerCase()) ? { id: t, label: `@${t}`, icon: "account", detail: "someone not listed" } : undefined;
        return { items, ...(typed ? { typed } : {}), multi: true };
      }
    }
  }

  private drawPicker(focusFilter: boolean): void {
    const p = this.picker;
    if (!p || !this.state) return;
    const words = PICKER_WORDS[p.kind];
    const m = p.el;
    const hadFocus = m.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const focusedId = hadFocus?.dataset.id;
    const { items, typed, multi } = this.itemsFor(p.kind, p.query);
    m.replaceChildren();
    m.setAttribute("aria-label", words.title);
    const head = el("div", "prc-picker-title", words.title);
    head.setAttribute("aria-hidden", "true");
    m.appendChild(head);
    // One filter box for the picker's life: redrawn around it, it keeps the
    // keyboard, the caret and whatever an input method is composing.
    let input = p.input;
    if (!input) {
      input = el("input", "prc-picker-filter");
      input.type = "text";
      input.placeholder = words.filter;
      input.setAttribute("aria-label", words.filter);
      input.spellcheck = false;
      const box = input;
      box.addEventListener("input", () => {
        p.query = box.value;
        this.drawPicker(false);
      });
      p.input = input;
    }
    if (input.value !== p.query) input.value = p.query;
    m.appendChild(input);
    const list = el("div", "prc-picker-items");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", words.title);
    if (multi) list.setAttribute("aria-multiselectable", "true");
    const all = typed ? [...items, typed] : items;
    for (const it of all) {
      const b = el("button", `prp-menu-item prc-picker-item${it.checked ? " is-checked" : ""}`);
      b.type = "button";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", it.checked ? "true" : "false");
      b.dataset.id = it.id;
      const lead = el("span", "prc-picker-lead");
      if (it.lead) lead.appendChild(it.lead);
      else if (it.icon) lead.appendChild(codicon(it.icon));
      b.appendChild(lead);
      b.appendChild(el("span", "prc-picker-label", it.label));
      b.append(" ");
      b.appendChild(el("span", "prc-picker-detail", it.detail ?? ""));
      const check = el("span", "prc-picker-check");
      if (it.checked) check.appendChild(codicon("check"));
      b.appendChild(check);
      b.addEventListener("click", () => this.choose(p.kind, it.id, multi));
      list.appendChild(b);
    }
    if (all.length === 0) list.appendChild(el("div", "prc-picker-empty", words.empty));
    m.appendChild(list);
    if (p.kind === "labels" || p.kind === "reviewers" || p.kind === "assignees") {
      const foot = el("div", "prc-picker-foot", this.state.options?.truncated ? "Only the first 100 are listed; type to find others." : "");
      if (foot.textContent) m.appendChild(foot);
    }
    this.placePicker();
    if (focusedId !== undefined) (m.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusedId)}"]`) ?? input).focus();
    else if (focusFilter || hadFocus === input || !m.contains(document.activeElement)) input.focus();
  }

  private choose(kind: PickerKind, id: string, multi: boolean): void {
    if (multi) {
      const list = this.listOf(kind as "reviewers" | "assignees" | "labels");
      const i = list.findIndex((x) => x.toLowerCase() === id.toLowerCase());
      if (i >= 0) list.splice(i, 1);
      else list.push(id);
      if (this.picker) this.picker.query = "";
      this.paint();
      return;
    }
    this.closePicker(true);
    const s = this.state;
    if (!s) return;
    if (kind === "base" && id !== s.base) this.opts.post({ type: "base", branch: id });
    else if (kind === "head" && id !== s.head?.branch) this.opts.post({ type: "head", branch: id });
    else if (kind === "push" && id !== s.head?.remote) this.opts.post({ type: "pushRemote", remote: id });
    else if (kind === "target" && id !== s.target) this.opts.post({ type: "target", id });
    else if (kind === "template" && (id || undefined) !== s.template) {
      // A template replaces an untouched description, and joins one you wrote.
      this.templateAsked = true;
      this.opts.post({ type: "template", filename: id || null });
    }
  }

  private placePicker(): void {
    const p = this.picker;
    if (!p) return;
    const m = p.el;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // As wide as its rows want when it opens — "upstream  acme/webapp —
    // where it opens" whole — from 320px up to 480px, never wider than the
    // view; and that width for its life, so typing a filter moves nothing.
    if (p.width === undefined) {
      m.style.width = "max-content";
      // The fractional width, rounded UP: offsetWidth rounds to the nearest
      // pixel, and half a pixel short is an ellipsis.
      p.width = Math.ceil(m.getBoundingClientRect().width);
    }
    const width = Math.min(Math.max(320, p.width), 480, vw - 16);
    m.style.width = `${width}px`;
    m.style.maxHeight = `${Math.max(160, Math.min(420, vh - 16))}px`;
    const r = p.anchor.getBoundingClientRect();
    let x = r.left;
    let y = r.bottom + 4;
    x = Math.max(8, Math.min(x, vw - width - 8));
    const h = m.offsetHeight;
    if (y + h > vh - 8) y = Math.max(8, r.top - h - 4);
    m.style.left = `${x}px`;
    m.style.top = `${y}px`;
  }

  private closePicker(returnFocus: boolean): void {
    const p = this.picker;
    if (!p) return;
    this.picker = undefined;
    p.anchor.removeAttribute("aria-expanded");
    p.el.remove();
    if (returnFocus) {
      const key = p.anchor.dataset.key;
      (p.anchor.isConnected ? p.anchor : key ? this.view.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null)?.focus();
    }
  }

  private onPickerKey(e: KeyboardEvent): void {
    const p = this.picker;
    if (!p) return;
    const items = [...p.el.querySelectorAll<HTMLElement>(".prc-picker-item")];
    const inFilter = (document.activeElement as HTMLElement | null)?.classList.contains("prc-picker-filter");
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (j: number) => {
      e.preventDefault();
      items[(j + items.length) % items.length]?.focus();
    };
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        this.closePicker(true);
        return;
      case "Tab":
        this.closePicker(true);
        return;
      case "ArrowDown":
        return move(inFilter ? 0 : at + 1);
      case "ArrowUp":
        return move(inFilter ? items.length - 1 : at - 1);
      case "Home":
        if (!inFilter) move(0);
        return;
      case "End":
        if (!inFilter) move(items.length - 1);
        return;
      case "Enter":
        if (inFilter) {
          e.preventDefault();
          items[0]?.click();
        }
        return;
    }
  }
}

function retain(list: string[], keep: (x: string) => boolean): void {
  for (let i = list.length - 1; i >= 0; i--) if (!keep(list[i])) list.splice(i, 1);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
