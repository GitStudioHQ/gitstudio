// A pull request's page: what it is, who wrote and reviews it, whether it can
// be merged and how, the conversation, its commits, its checks and its
// changed files — and the review you are writing of it.
//
// A typed DOM component, host-agnostic, like the Pull Requests list beside it
// (prList.ts): the extension mounts it in an editor tab (page-main.ts), and
// the desktop can mount the same class. It holds no GitHub state: the host
// sends a full PrPageViewState (host-bridge/prProtocol) after every change and
// hears back PrPageMessageToHost. What the component owns is what is on
// screen — the tab, what is typed, which box is open, which commit is
// expanded, which folder is folded.
//
// A state is PAINTED IN PLACE (conflicts/patch.ts): the page is built from the
// state into a detached copy and only what differs is written, so a poll
// while you type in a reply box touches neither the box nor the scroll. A
// rendered body is keyed by its text, and left alone while it is unchanged
// (an expanded <details> in it stays expanded).
//
// Every control says what it does, in words: a label on it, or — for an
// icon button — a title and an accessible name. Glyphs are codicons from the
// shared vocabulary (engine/forge/pullRequests, forge/prPage), never invented
// marks. Colours are set through the CSSOM, which the page's CSP allows; a
// style attribute it would drop.

import type {
  PrCheck,
  PrDetail,
  PrListAction,
  PrListButton,
  PrListMessage,
  PrMergeMethod,
  PrPageFile,
  PrPageMessageToHost,
  PrPageTab,
  PrPageViewState,
  PrPerson,
  PrReviewer,
  PrThread,
  PrTimelineItem,
} from "@gitstudio/host-bridge/prProtocol";
import { CI_STATES, PR_ACTIONS, PR_STATES, PR_TABS, REVIEW_DECISIONS, ciWords } from "@gitstudio/engine/forge/pullRequests";
import {
  CHECK_STATES,
  FILE_STATUS,
  MERGE_METHODS,
  PR_PAGE_ACTION_WORDS,
  REVIEW_STATE_WORDS,
  checkWords,
  defaultMergeTitle,
  fileTree,
  mergeBoxOf,
  mergeMethodsFor,
  prPageActions,
  reviewVerdictsFor,
  timelineEventWords,
  type PrFileNode,
  type PrPageAction,
} from "@gitstudio/engine/forge/prPage";
import { splitIssueRefs } from "@gitstudio/engine/forge/issueRefs";
import { renderMarkdown } from "../markdown";
import { patchChildren } from "../conflicts/patch";
import { ageWords } from "./prList";

export interface PullRequestPageOptions {
  post(message: PrPageMessageToHost): void;
  /** The merge method offered first (the extension's gitstudio.pr.defaultMergeMethod). */
  preferredMethod?: PrMergeMethod;
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

/** An avatar's src: GitHub's avatar host over https, or an inline image — nothing else loads. */
function avatarSrc(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (/^data:image\/(png|svg\+xml|jpeg|gif|webp);/.test(url)) return url;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "avatars.githubusercontent.com" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function hueOf(login: string): number {
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) % 360;
  return h;
}

function avatar(p: { login?: string; avatarUrl?: string | null } | null, size: number, team = false): HTMLElement {
  const wrap = el("span", `prp-avatar${team ? " is-team" : ""}`);
  wrap.setAttribute("aria-hidden", "true");
  wrap.style.setProperty("--prp-avatar", `${size}px`);
  if (team) {
    wrap.appendChild(codicon("organization"));
    return wrap;
  }
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

/** A person's name as the page writes it; a deleted account is "ghost", as on GitHub. */
function who(p: PrPerson | null | undefined): string {
  return p?.login ?? "ghost";
}

function fullDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "";
}

/** "3 days ago", with the exact time as its title. */
function when(iso: string, now: number, cls = "prp-when"): HTMLElement {
  const t = el("time", cls, ageWords(iso, now));
  t.dateTime = iso;
  t.title = fullDate(iso);
  return t;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** A small hash of a string, to key a rendered body by its text. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ── Prose: GitHub's Markdown, sanitised, with its references made links ─────

const md = new Map<string, string>();

/** A body as safe HTML (the shared sanitising renderer), cached by its text. */
function renderBody(src: string): string {
  let html = md.get(src);
  if (html === undefined) {
    html = renderMarkdown(src);
    if (md.size > 400) md.clear();
    md.set(src, html);
  }
  return html;
}

const MENTION = /(^|[^\w`@/])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![\w-])/g;

/**
 * `#12`, `owner/repo#12` and `@login` in prose, as GitHub links them — never
 * inside a link, code or a pre. A reference names its repository: a bare
 * `#12` is this repository's, never whichever one happens to be active.
 */
function linkRefs(root: HTMLElement, repo: string): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.parentElement?.closest("a, code, pre")) continue;
    if (/#\d|@[A-Za-z0-9]/.test(t.data)) texts.push(t);
  }
  for (const t of texts) {
    const frag = document.createDocumentFragment();
    for (const piece of splitIssueRefs(t.data)) {
      if (piece.ref) {
        const target = piece.ref.repo ?? repo;
        const a = el("a", "prp-ref", piece.text);
        a.href = `https://github.com/${target}/issues/${piece.ref.number}`;
        a.dataset.refRepo = target;
        a.dataset.refNumber = String(piece.ref.number);
        a.title = `${target}#${piece.ref.number}`;
        frag.appendChild(a);
        continue;
      }
      let last = 0;
      const text = piece.text;
      MENTION.lastIndex = 0;
      for (let m = MENTION.exec(text); m; m = MENTION.exec(text)) {
        const start = m.index + m[1].length;
        if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
        const a = el("a", "prp-mention", `@${m[2]}`);
        a.href = `https://github.com/${m[2]}`;
        frag.appendChild(a);
        last = start + 1 + m[2].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    }
    t.replaceWith(frag);
  }
}

function prose(src: string, repo: string, key: string, empty?: string): HTMLElement {
  const box = el("div", "prp-md");
  box.dataset.key = `md-${key}-${hash(src)}`;
  if (!src.trim()) {
    box.appendChild(el("p", "prp-md-empty", empty ?? "No description provided."));
    return box;
  }
  box.innerHTML = renderBody(src);
  linkRefs(box, repo);
  return box;
}

// ── The component ────────────────────────────────────────────────────────────

const TABS: PrPageTab[] = ["conversation", "commits", "checks", "files"];
const PR_ACTIONS_MORE = PR_ACTIONS.more;
/** Where the keyboard goes when the merge box opens: the method chosen. */
const MERGE_FOCUS = ".prp-method.is-on input";
/** Where it goes when the merge box can't open: the status line that says why. */
const WHY_NO_MERGE = '[data-key="status-merge"], [data-key="status-done"]';

/** The tabs: the desktop's words and glyphs (the shared PR_TABS). */
const TAB_WORDS: Record<PrPageTab, { label: string; icon: string }> = PR_TABS;

type Verdict = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
const VERDICT_WORDS: Record<Verdict, { label: string; icon: string; hint: string }> = {
  COMMENT: { label: "Comment", icon: "comment", hint: "Feedback without an explicit approval" },
  APPROVE: { label: "Approve", icon: "check", hint: "The change is good to merge" },
  REQUEST_CHANGES: { label: "Request changes", icon: "request-changes", hint: "Must be addressed before merging" },
};

export class PullRequestPage {
  private state: PrPageViewState | undefined;
  private readonly view: HTMLElement;
  private readonly layer: HTMLElement;
  private tab: PrPageTab | undefined;
  private panel: "merge" | "review" | undefined;
  private confirmDiscard = false;
  private method: PrMergeMethod | undefined;
  private readonly titles = new Map<PrMergeMethod, string>();
  private deleteBranch = false;
  private verdict: Verdict = "COMMENT";
  private readonly drafts = new Map<string, string>();
  private readonly expanded = new Set<string>();
  private readonly folded = new Set<string>();
  private readonly shownResolved = new Set<string>();
  private moreOpen = false;
  private focusSeq = -1;
  private restoreSeq = -1;
  private sentSeq = -1;
  /** An element to focus once the next paint is on screen. */
  private focusAfter: string | undefined;
  /** A box the host asked to open, waiting for the pull request to arrive. */
  private asked: "merge" | "review" | undefined;
  /** The data-key of the header button that opened the box: the keyboard goes back to it. */
  private opener: string | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: PullRequestPageOptions,
  ) {
    this.view = el("div", "prp");
    this.view.setAttribute("role", "main");
    this.layer = el("div", "prp-layer");
    this.root.append(this.view, this.layer);
    this.view.addEventListener("click", (e) => this.onClick(e));
    this.view.addEventListener("input", (e) => this.onInput(e));
    this.view.addEventListener("change", (e) => this.onChange(e));
    this.view.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.layer.addEventListener("click", (e) => this.onClick(e));
    this.layer.addEventListener("keydown", (e) => this.onMenuKey(e));
    this.view.addEventListener(
      "error",
      (e) => {
        const t = e.target as HTMLElement | null;
        if (t instanceof HTMLImageElement && t.classList.contains("prp-avatar-img")) t.closest(".prp-avatar")?.classList.add("is-broken");
      },
      true,
    );
    document.addEventListener("mousedown", (e) => {
      if (this.moreOpen && !this.layer.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[data-act="more"]')) this.closeMore(false);
    });
    window.addEventListener("blur", () => this.closeMore(false));
    window.addEventListener("resize", () => this.closeMore(false));
    // The page scrolled from under the open menu: its button has moved away.
    window.addEventListener("scroll", () => this.closeMore(false), true);
    opts.post({ type: "ready" });
  }

  /** Paint a state from the host. An older one than on screen is ignored. */
  render(state: PrPageViewState): void {
    if (this.state && state.seq < this.state.seq) return;
    this.state = state;
    if (this.tab === undefined) this.tab = state.tab;
    if (state.focus && state.focus.seq !== this.focusSeq) {
      this.focusSeq = state.focus.seq;
      if (state.focus.tab) this.tab = state.focus.tab;
      if (state.focus.open) {
        // Asked for from elsewhere (the list's Merge…, the palette): the box
        // opens once the pull request is here — the host asks as soon as the
        // page is ready, which is before GitHub has answered.
        this.panel = state.focus.open;
        this.asked = state.focus.open;
        this.opener = `act-${state.focus.open}`;
        this.confirmDiscard = false;
      }
    }
    let restored: string | undefined;
    if (state.restore && state.restore.seq !== this.restoreSeq) {
      this.restoreSeq = state.restore.seq;
      if (!this.drafts.get(state.restore.key)) {
        this.drafts.set(state.restore.key, state.restore.body);
        restored = state.restore.key;
      }
    }
    if (state.sent && state.sent.seq !== this.sentSeq) {
      this.sentSeq = state.sent.seq;
      this.clearBox(state.sent.key);
      if (state.sent.key === "review") {
        this.panel = undefined;
        this.confirmDiscard = false;
        this.verdict = "COMMENT";
      }
    }
    const pr = state.pr;
    if (pr) {
      // A box whose reason has gone closes: a merged pull request has nothing
      // to merge, a blocked one can't be merged.
      if (this.panel === "merge" && !mergeBoxOf(pr)?.canMerge) this.panel = undefined;
      if (this.panel === "review" && pr.kind !== "open" && pr.kind !== "draft") this.panel = undefined;
      if (this.asked) {
        // The box asked for, and the keyboard in it — or, when it can't open
        // (blocked, a draft, merged or closed meanwhile), on the status line
        // that says why.
        this.asked = undefined;
        this.focusAfter = this.panel === "merge" ? MERGE_FOCUS : this.panel === "review" ? ".prp-review-body" : WHY_NO_MERGE;
      }
    } else if (state.status === "message") {
      // The pull request couldn't be read: nothing to open a box on.
      this.panel = undefined;
      this.asked = undefined;
    }
    // Where the keyboard was, when a paint takes its box away (sent, merged,
    // closed from the host): it goes back where the box came from.
    const active = document.activeElement as HTMLElement | null;
    const inBox = !!active && this.view.contains(active) && !!active.closest(".prp-panel");
    const fresh = el("div");
    this.build(fresh, state);
    patchChildren(this.view, fresh, {
      // A rendered body is keyed by its text: while that is unchanged, what
      // the reader did to it (an opened <details>) stays.
      opaque: (live) => (live.classList.contains("prp-md") ? ["data-key"] : undefined),
      runtimeClasses: ["is-pressed", "is-asked"],
    });
    this.syncControls();
    // Words the host sent back go into their box even while it has the
    // keyboard: it was emptied when they were sent.
    if (restored) {
      for (const box of this.view.querySelectorAll<HTMLTextAreaElement>("[data-draft]")) {
        if (box.dataset.draft === restored && box.value === "") box.value = this.drafts.get(restored) ?? "";
      }
    }
    if (this.moreOpen) this.drawMore();
    if (this.focusAfter) {
      const sel = this.focusAfter;
      this.focusAfter = undefined;
      const target = this.view.querySelector<HTMLElement>(sel);
      if (target && sel === WHY_NO_MERGE) {
        // Ringed while it has the keyboard, however the page was reached —
        // and not when a click lands on it.
        target.classList.add("is-asked");
        target.addEventListener("blur", () => target.classList.remove("is-asked"), { once: true });
      }
      target?.focus();
    } else if (inBox && (!document.activeElement || document.activeElement === document.body)) {
      this.focusBack();
    }
  }

  /**
   * The keyboard, back where a box came from once it closes: the button that
   * opened it — or, when that is off (Merge, while merging is blocked) or
   * gone, the first header control that can be pressed.
   */
  private focusBack(): void {
    const opener = this.opener ? this.view.querySelector<HTMLButtonElement>(`.prp-actions [data-key="${this.opener}"]`) : null;
    const target = opener && !opener.disabled ? opener : this.view.querySelector<HTMLElement>(".prp-actions button:not(:disabled)");
    target?.focus();
  }

  // ── Building ───────────────────────────────────────────────────────────────

  private build(into: HTMLElement, s: PrPageViewState): void {
    const progress = el("div", `prp-progress${s.refreshing || s.status === "loading" || s.busy.length > 0 ? " is-on" : ""}`);
    progress.setAttribute("aria-hidden", "true");
    progress.appendChild(el("span", "prp-progress-bar"));
    into.appendChild(progress);
    const page = el("div", "prp-page");
    into.appendChild(page);
    if (s.notice) page.appendChild(this.buildMessage(s.notice, "prp-notice", "notice"));
    if (s.status === "message" && s.message) {
      // Which pull request it is, when the list said, above why it can't be shown.
      if (s.preview) page.appendChild(this.buildHead(s));
      page.appendChild(this.buildMessage(s.message, "prp-message", "message"));
      return;
    }
    page.appendChild(this.buildHead(s));
    const pr = s.pr;
    if (!pr) {
      page.appendChild(this.buildSkeleton());
      return;
    }
    if (this.panel === "merge") page.appendChild(this.buildMergePanel(s, pr));
    if (this.panel === "review") page.appendChild(this.buildReviewPanel(s, pr));
    page.appendChild(this.buildTabs(s, pr));
    const body = el("div", "prp-tabpanel");
    body.id = `prp-panel-${this.tab}`;
    body.setAttribute("role", "tabpanel");
    body.setAttribute("aria-labelledby", `prp-tab-${this.tab}`);
    body.dataset.key = `panel-${this.tab}`;
    switch (this.tab) {
      case "commits":
        this.buildCommits(body, s, pr);
        break;
      case "checks":
        this.buildChecks(body, s, pr);
        break;
      case "files":
        this.buildFiles(body, s, pr);
        break;
      default:
        this.buildConversation(body, s, pr);
    }
    page.appendChild(body);
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

  private buildSkeleton(): HTMLElement {
    const sk = el("div", "prp-skeleton");
    sk.setAttribute("aria-busy", "true");
    sk.setAttribute("aria-label", "Loading the pull request");
    for (const w of ["tabs", "line-1", "line-2", "block", "line-3", "block-2"]) sk.appendChild(el("span", `prp-sk prp-sk-${w}`));
    return sk;
  }

  // ── The header ─────────────────────────────────────────────────────────────

  private buildHead(s: PrPageViewState): HTMLElement {
    const pr = s.pr;
    const head = el("header", "prp-head");
    const kind = pr?.kind ?? s.preview?.kind ?? "open";
    const st = PR_STATES[kind];

    const crumb = el("div", "prp-crumb");
    crumb.append(codicon("repo"), el("span", "prp-crumb-repo", s.repo), el("span", "prp-crumb-num", `#${s.number}`));
    head.appendChild(crumb);

    const titleRow = el("div", "prp-title-row");
    const pill = el("span", `prp-state tone-${st.tone}`);
    pill.append(codicon(st.codicon), el("span", "prp-state-word", st.word));
    pill.title = `This pull request is ${st.word.toLowerCase()}`;
    titleRow.appendChild(pill);
    const h1 = el("h1", "prp-title");
    h1.append(el("span", "prp-title-text", pr?.title ?? s.preview?.title ?? `Pull request #${s.number}`), el("span", "prp-title-num", ` #${s.number}`));
    titleRow.appendChild(h1);
    head.appendChild(titleRow);

    const author = pr?.author ?? s.preview?.author ?? null;
    const sub = el("div", "prp-sub");
    const whoEl = el("span", "prp-who");
    whoEl.append(avatar(author, 18), el("strong", "prp-author", who(author)));
    sub.appendChild(whoEl);
    const headRef = pr?.headRef ?? s.preview?.headRef ?? "";
    const baseRef = pr?.baseRef ?? s.preview?.baseRef ?? "";
    const headName = pr?.isFork && pr.headOwner ? `${pr.headOwner}:${headRef}` : headRef;
    const verb = kind === "merged" ? "merged" : "wants to merge";
    const n = pr?.commitCount;
    sub.appendChild(el("span", "prp-sub-text", ` ${verb} ${n !== undefined ? `${plural(n, "commit")} ` : ""}into `));
    sub.appendChild(this.branchChip(baseRef, false, `The branch it ${kind === "merged" ? "went" : "goes"} into`));
    sub.appendChild(el("span", "prp-sub-text", " from "));
    const headChip = this.branchChip(headName, !!pr?.isFork, pr?.isFork ? `From ${pr.headRepo ?? "a fork that was deleted"}` : "Its branch");
    if (s.checkedOut) {
      headChip.classList.add("is-current");
      headChip.title = "Its branch — the one checked out here";
    }
    sub.appendChild(headChip);
    if (s.checkedOut) sub.appendChild(el("span", "prp-here", "Checked out"));
    if (pr) {
      sub.appendChild(el("span", "prp-dot", "·"));
      const opened = el("span", "prp-sub-text");
      opened.append("opened ", when(pr.createdAt, s.now));
      sub.appendChild(opened);
    }
    head.appendChild(sub);

    if (pr) {
      head.appendChild(this.buildActions(s, pr));
      const status = this.buildStatus(s, pr);
      if (status) head.appendChild(status);
    }
    return head;
  }

  private branchChip(name: string, fork: boolean, title: string): HTMLElement {
    const c = el("span", "prp-branch");
    c.append(codicon(fork ? "repo-forked" : "git-branch"), el("span", "prp-branch-name", name));
    c.title = `${title}: ${name}`;
    return c;
  }

  private isBusy(what: string): boolean {
    return !!this.state?.busy.includes(what as never);
  }

  private buildActions(s: PrPageViewState, pr: PrDetail): HTMLElement {
    const row = el("div", "prp-actions");
    row.setAttribute("role", "toolbar");
    row.setAttribute("aria-label", "Pull request actions");
    const acts = prPageActions(pr);
    const pending = s.review?.comments.length ?? 0;
    const add = (a: PrPageAction, primary: boolean) => {
      const w = PR_PAGE_ACTION_WORDS[a];
      const b = button(`gs-btn prp-btn${primary ? " gs-btn--primary" : ""}`, `act-${a}`, a);
      b.appendChild(codicon(w.icon));
      let label = w.label;
      let title = w.title;
      // Merge and Review open a box under the header: a chevron says so, as
      // the desktop's menu buttons do.
      let chevron = false;
      if (a === "merge") {
        chevron = true;
        b.setAttribute("aria-expanded", this.panel === "merge" ? "true" : "false");
        const box = mergeBoxOf(pr);
        if (box && !box.canMerge) {
          b.disabled = true;
          title = `${box.title}. ${box.detail}`;
        }
      }
      if (a === "review") {
        chevron = true;
        label = pending > 0 ? `Review (${pending} pending)` : w.label;
        title = pending > 0 ? `Submit your review — ${plural(pending, "pending comment")} will be sent with it` : w.title;
        b.setAttribute("aria-expanded", this.panel === "review" ? "true" : "false");
        if (pending > 0) b.classList.add("has-pending");
      }
      const busyWord: Partial<Record<PrPageAction, [string, string]>> = {
        markReady: ["ready", "Marking ready…"],
        reopen: ["reopen", "Reopening…"],
        checkout: ["checkout", "Checking out…"],
      };
      const busy = busyWord[a];
      if (busy && this.isBusy(busy[0])) {
        label = busy[1];
        b.disabled = true;
      }
      if (a === "merge" && this.isBusy("merge")) {
        label = "Merging…";
        b.disabled = true;
      }
      b.appendChild(el("span", "prp-btn-label", label));
      if (chevron) b.appendChild(codicon(b.getAttribute("aria-expanded") === "true" ? "chevron-up" : "chevron-down", "prp-btn-chevron"));
      b.title = title;
      row.appendChild(b);
    };
    if (acts.primary) add(acts.primary, true);
    for (const a of acts.buttons) add(a, false);
    const more = button("gs-btn prp-btn prp-more-btn", "more", "more");
    more.appendChild(codicon(PR_ACTIONS_MORE.icon));
    more.title = PR_ACTIONS_MORE.title;
    more.setAttribute("aria-label", PR_ACTIONS_MORE.label);
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", this.moreOpen ? "true" : "false");
    row.appendChild(more);
    row.appendChild(el("span", "prp-actions-gap"));
    // Refresh and Open on GitHub stay together at the end, wrapped or not.
    const end = el("span", "prp-actions-end");
    const refresh = button("prp-icon-btn", "refresh", "refresh");
    refresh.appendChild(codicon("refresh"));
    refresh.title = "Refresh — read the pull request again";
    refresh.setAttribute("aria-label", "Refresh the pull request");
    end.appendChild(refresh);
    const gh = button("prp-icon-btn", "github", "openOnGitHub");
    gh.appendChild(codicon("link-external"));
    gh.title = "Open on GitHub";
    gh.setAttribute("aria-label", "Open this pull request on GitHub");
    end.appendChild(gh);
    row.appendChild(end);
    return row;
  }

  /** Reviews, checks, and whether it can be merged — or how it ended. */
  private buildStatus(s: PrPageViewState, pr: PrDetail): HTMLElement | undefined {
    const box = el("section", "prp-status");
    box.setAttribute("aria-label", "Status");
    if (pr.kind === "merged" || pr.kind === "closed") {
      const line = el("div", `prp-status-row tone-${PR_STATES[pr.kind].tone}`);
      line.dataset.key = "status-done";
      // Where the keyboard lands when Merge… was asked of a pull request that has ended.
      line.tabIndex = -1;
      const glyph = el("span", "prp-status-glyph");
      glyph.appendChild(codicon(PR_STATES[pr.kind].codicon));
      line.appendChild(glyph);
      const text = el("div", "prp-status-text");
      const title = el("div", "prp-status-title");
      if (pr.kind === "merged") {
        title.append(`Merged${pr.mergedBy ? ` by ${who(pr.mergedBy)}` : ""} into ${pr.baseRef} `);
        if (pr.mergedAt) title.appendChild(when(pr.mergedAt, s.now));
      } else {
        title.append("Closed without merging ");
        if (pr.closedAt) title.appendChild(when(pr.closedAt, s.now));
      }
      text.appendChild(title);
      line.appendChild(text);
      box.appendChild(line);
      return box;
    }
    // Reviews.
    const approvers = pr.reviewers.filter((r) => r.verdict === "APPROVED").map((r) => r.login ?? r.team ?? "");
    const blockers = pr.reviewers.filter((r) => r.verdict === "CHANGES_REQUESTED").map((r) => r.login ?? r.team ?? "");
    const waiting = pr.reviewers.filter((r) => r.requested).map((r) => r.login ?? r.team ?? "");
    let reviewLine: { tone: string; icon: string; title: string; detail?: string };
    // GitHub's decision is the word when it has one; a repository that
    // requires no review has none, and the reviewers' own verdicts speak.
    const decision = pr.reviewDecision;
    if (decision === "CHANGES_REQUESTED" || (!decision && blockers.length > 0)) {
      reviewLine = { tone: "failure", icon: REVIEW_DECISIONS.CHANGES_REQUESTED.codicon, title: "Changes requested", detail: blockers.length ? `By ${blockers.join(", ")}.` : undefined };
    } else if (decision === "APPROVED" || (!decision && approvers.length > 0)) {
      reviewLine = { tone: "success", icon: REVIEW_DECISIONS.APPROVED.codicon, title: "Approved", detail: approvers.length ? `By ${approvers.join(", ")}.` : undefined };
    } else if (decision === "REVIEW_REQUIRED") {
      reviewLine = { tone: "pending", icon: REVIEW_DECISIONS.REVIEW_REQUIRED.codicon, title: "Review required", detail: waiting.length ? `Waiting on ${waiting.join(", ")}.` : "At least one approving review is required to merge." };
    } else {
      reviewLine = { tone: "muted", icon: "eye", title: waiting.length ? "Review requested" : "No reviews yet", detail: waiting.length ? `Waiting on ${waiting.join(", ")}.` : undefined };
    }
    box.appendChild(this.statusRow("status-reviews", reviewLine.tone, reviewLine.icon, reviewLine.title, reviewLine.detail));
    // Checks.
    const ci = CI_STATES[pr.ci.state];
    const checks = this.statusRow("status-checks", ci.tone, ci.codicon, ciWords(pr.ci), pr.ci.state === "none" ? "Nothing runs on this branch's commits." : undefined);
    if (pr.ci.state !== "none") {
      const show = button("prp-link", "status-show-checks", "tab");
      show.dataset.value = "checks";
      show.textContent = "Show checks";
      show.title = "Every check on its latest commit";
      checks.querySelector(".prp-status-text")?.append(" ", show);
    }
    box.appendChild(checks);
    // Merge.
    const m = mergeBoxOf(pr);
    if (m) {
      const row = this.statusRow("status-merge", m.tone, m.icon, m.title, m.detail);
      // Where the keyboard lands when Merge… was asked and the box can't open: why.
      row.tabIndex = -1;
      // The fix, unless the header's own primary action is already it.
      if (m.fix && !(m.fix === "markReady" && prPageActions(pr).primary === "markReady")) {
        const words = {
          updateBranch: [PR_PAGE_ACTION_WORDS.updateBranch.label, PR_PAGE_ACTION_WORDS.updateBranch.icon, `Merge ${pr.baseRef} into this branch on GitHub`, "updateBranch", "Updating…"],
          checkout: ["Checkout to resolve", PR_PAGE_ACTION_WORDS.checkout.icon, "Check out its branch here, to merge the base into it and resolve the conflicts", "checkout", "Checking out…"],
          markReady: [PR_PAGE_ACTION_WORDS.markReady.label, PR_PAGE_ACTION_WORDS.markReady.icon, PR_PAGE_ACTION_WORDS.markReady.title, "markReady", "Marking ready…"],
          refresh: ["Refresh", "refresh", "Ask GitHub again", "refresh", "Refreshing…"],
        }[m.fix];
        const b = button("gs-btn prp-btn prp-status-fix", `fix-${m.fix}`, words[3]);
        b.appendChild(codicon(words[1]));
        const busyKey = m.fix === "markReady" ? "ready" : m.fix;
        const busy = m.fix === "refresh" ? s.refreshing : this.isBusy(busyKey);
        b.appendChild(el("span", "prp-btn-label", busy ? words[4] : words[0]));
        b.disabled = busy;
        b.title = words[2];
        row.appendChild(b);
      }
      box.appendChild(row);
    }
    return box;
  }

  private statusRow(key: string, tone: string, icon: string, title: string, detail?: string): HTMLElement {
    const row = el("div", `prp-status-row tone-${tone}`);
    row.dataset.key = key;
    const glyph = el("span", "prp-status-glyph");
    glyph.appendChild(codicon(icon));
    row.appendChild(glyph);
    const text = el("div", "prp-status-text");
    text.appendChild(el("span", "prp-status-title", title));
    // A space between: read aloud, the title and its detail are two words, not one.
    if (detail) text.append(" ", el("span", "prp-status-detail", detail));
    row.appendChild(text);
    return row;
  }

  // ── The merge box ──────────────────────────────────────────────────────────

  private methods(pr: PrDetail): PrMergeMethod[] {
    return mergeMethodsFor(pr, this.opts.preferredMethod);
  }

  private buildMergePanel(s: PrPageViewState, pr: PrDetail): HTMLElement {
    const panel = el("section", "prp-panel prp-merge");
    panel.dataset.key = "panel-merge";
    panel.setAttribute("aria-label", "Merge this pull request");
    const methods = this.methods(pr);
    const method = this.method && methods.includes(this.method) ? this.method : methods[0];
    this.method = method;
    const head = el("div", "prp-panel-head");
    head.append(codicon("git-merge"), el("h2", "prp-panel-title", `Merge #${pr.number} into ${pr.baseRef}`));
    panel.appendChild(head);
    const list = el("div", "prp-methods");
    list.setAttribute("role", "radiogroup");
    list.setAttribute("aria-label", "How to merge");
    for (const m of methods) {
      const w = MERGE_METHODS[m];
      const on = m === method;
      const label = el("label", `prp-method${on ? " is-on" : ""}`);
      label.dataset.key = `method-${m}`;
      const input = el("input", "prp-method-input");
      input.type = "radio";
      input.name = "prp-merge-method";
      input.value = m;
      input.dataset.act = "method";
      input.dataset.key = `method-input-${m}`;
      label.appendChild(input);
      const glyph = el("span", "prp-method-glyph");
      glyph.appendChild(codicon(w.icon));
      label.appendChild(glyph);
      const text = el("span", "prp-method-text");
      text.append(el("span", "prp-method-label", w.label), el("span", "prp-method-what", w.what(pr.commitCount || pr.commits.length || 1, pr.baseRef)));
      label.appendChild(text);
      list.appendChild(label);
    }
    panel.appendChild(list);
    if (method !== "rebase") {
      const field = el("label", "prp-field");
      field.dataset.key = "merge-title-field";
      field.appendChild(el("span", "prp-field-label", "Commit title"));
      const input = el("input", "prp-input prp-merge-title");
      input.type = "text";
      input.dataset.key = `merge-title-${method}`;
      input.spellcheck = false;
      input.setAttribute("aria-label", "Commit title");
      field.appendChild(input);
      panel.appendChild(field);
    }
    const sameRepo = !pr.isFork;
    if (pr.repo.deleteBranchOnMerge) {
      panel.appendChild(el("p", "prp-note", `GitHub deletes ${pr.headRef} after it is merged.`));
    } else if (sameRepo && pr.viewer.canDeleteBranch) {
      const check = el("label", "prp-check");
      check.dataset.key = "delete-branch";
      const box = el("input", "prp-check-input prp-delete-branch");
      box.type = "checkbox";
      box.dataset.act = "deleteBranch";
      check.append(box, el("span", "prp-check-label", `Delete ${pr.headRef} on GitHub after merging`));
      panel.appendChild(check);
    }
    const foot = el("div", "prp-panel-foot");
    const go = button("gs-btn gs-btn--primary prp-btn", "merge-confirm", "mergeConfirm");
    go.appendChild(codicon(MERGE_METHODS[method].icon));
    go.appendChild(el("span", "prp-btn-label", this.isBusy("merge") ? "Merging…" : MERGE_METHODS[method].confirm));
    go.disabled = this.isBusy("merge");
    go.title = MERGE_METHODS[method].what(pr.commitCount || 1, pr.baseRef);
    const cancel = button("gs-btn prp-btn", "merge-cancel", "closePanel", "Cancel");
    cancel.title = "Close without merging";
    foot.append(go, cancel);
    panel.appendChild(foot);
    return panel;
  }

  // ── The review box ─────────────────────────────────────────────────────────

  private buildReviewPanel(s: PrPageViewState, pr: PrDetail): HTMLElement {
    const panel = el("section", "prp-panel prp-review");
    panel.dataset.key = "panel-review";
    panel.setAttribute("aria-label", "Your review");
    const review = s.review;
    const pending = review?.comments ?? [];
    const head = el("div", "prp-panel-head");
    head.append(codicon("comment-discussion"), el("h2", "prp-panel-title", `Review #${pr.number}`));
    panel.appendChild(head);
    const verdicts = reviewVerdictsFor(pr);
    if (!verdicts.find((v) => v.event === this.verdict)?.allowed) this.verdict = "COMMENT";
    const list = el("div", "prp-verdicts");
    list.setAttribute("role", "radiogroup");
    list.setAttribute("aria-label", "Your verdict");
    for (const v of verdicts) {
      const w = VERDICT_WORDS[v.event];
      const on = v.event === this.verdict;
      const label = el("label", `prp-verdict${on ? " is-on" : ""}${v.allowed ? "" : " is-off"} verdict-${v.event.toLowerCase()}`);
      label.dataset.key = `verdict-${v.event}`;
      const input = el("input", "prp-verdict-input");
      input.type = "radio";
      input.name = "prp-verdict";
      input.value = v.event;
      input.dataset.act = "verdict";
      input.dataset.key = `verdict-input-${v.event}`;
      input.disabled = !v.allowed;
      label.appendChild(input);
      const glyph = el("span", "prp-verdict-glyph");
      glyph.appendChild(codicon(w.icon));
      label.appendChild(glyph);
      const text = el("span", "prp-verdict-text");
      text.append(el("span", "prp-verdict-label", w.label), el("span", "prp-verdict-hint", v.allowed ? w.hint : (v.why ?? "")));
      label.appendChild(text);
      if (!v.allowed && v.why) label.title = v.why;
      list.appendChild(label);
    }
    panel.appendChild(list);
    const field = el("label", "prp-field");
    field.appendChild(el("span", "prp-field-label", "Summary"));
    const area = el("textarea", "prp-textarea prp-review-body");
    area.dataset.key = "review-body";
    area.dataset.draft = "review";
    area.rows = 4;
    area.placeholder = this.verdict === "COMMENT" && pending.length === 0 ? "Write a comment (a Comment review needs one)" : "Leave a summary (optional)";
    area.setAttribute("aria-label", "Review summary");
    field.appendChild(area);
    panel.appendChild(field);

    const box = el("div", "prp-pending");
    box.dataset.key = "pending";
    if (pending.length === 0) {
      box.appendChild(el("p", "prp-note", "No line comments yet. In Files, open a file and click + beside a changed line to add one."));
    } else {
      const title = el("div", "prp-pending-title");
      title.append(codicon("comment-draft"), el("span", "", `${plural(pending.length, "pending comment")} will be sent with this review`));
      box.appendChild(title);
      if (review?.stale) {
        box.appendChild(el("p", "prp-note tone-pending", `Written on ${review.headSha.slice(0, 7)} — the pull request has moved on to ${pr.headSha.slice(0, 7)}. They are sent on the commit they were written on.`));
      }
      const ul = el("ul", "prp-pending-list");
      pending.forEach((c, i) => {
        const li = el("li", "prp-pending-item");
        const b = button("prp-pending-row", `pending-${i}`, "openPending");
        b.dataset.path = c.path;
        b.dataset.line = String(c.line);
        b.dataset.side = c.side;
        const where = `${c.path}:${c.startLine && c.startLine !== c.line ? `${c.startLine}–` : ""}${c.line}${c.side === "LEFT" ? " (removed lines)" : ""}`;
        b.append(codicon("comment-draft"), el("span", "prp-pending-where", where), el("span", "prp-pending-body", c.body.split("\n")[0]));
        b.title = `Open ${c.path} at line ${c.line}`;
        li.appendChild(b);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    panel.appendChild(box);

    const foot = el("div", "prp-panel-foot");
    if (this.confirmDiscard) {
      const q = el("div", "prp-confirm");
      q.setAttribute("role", "alertdialog");
      q.setAttribute("aria-label", "Discard your pending comments?");
      q.append(codicon("warning"), el("span", "prp-confirm-text", `Discard ${plural(pending.length, "pending comment")}? They haven't been sent to GitHub, and this can't be undone.`));
      const yes = button("gs-btn prp-btn prp-btn-danger", "discard-yes", "discardYes", "Discard");
      yes.title = "Delete them — nothing is sent";
      const no = button("gs-btn prp-btn", "discard-no", "discardNo", "Keep them");
      no.title = "Keep your pending comments";
      q.append(yes, no);
      foot.appendChild(q);
    } else {
      const busy = this.isBusy("review");
      const go = button("gs-btn gs-btn--primary prp-btn", "review-submit", "submitReview");
      go.appendChild(codicon(VERDICT_WORDS[this.verdict].icon));
      go.appendChild(el("span", "prp-btn-label", busy ? "Submitting…" : "Submit review"));
      go.disabled = busy;
      go.title = `Send your review as ${VERDICT_WORDS[this.verdict].label}${pending.length ? `, with ${plural(pending.length, "comment")}` : ""}`;
      foot.appendChild(go);
      if (pending.length > 0) {
        const discard = button("gs-btn prp-btn", "review-discard", "discard", "Discard pending comments…");
        discard.title = "Throw your pending comments away without sending them";
        discard.disabled = busy;
        foot.appendChild(discard);
      }
      const cancel = button("gs-btn prp-btn", "review-close", "closePanel", "Close");
      cancel.title = pending.length ? "Close this box — your pending comments are kept" : "Close this box";
      foot.appendChild(cancel);
    }
    panel.appendChild(foot);
    return panel;
  }

  // ── The tabs ───────────────────────────────────────────────────────────────

  private buildTabs(s: PrPageViewState, pr: PrDetail): HTMLElement {
    const nav = el("div", "prp-tabs");
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-label", "Pull request");
    const counts: Record<PrPageTab, string | undefined> = {
      conversation: String(pr.timeline.filter((t) => t.kind === "comment").length + pr.threads.reduce((n, t) => n + t.totalComments, 0)),
      commits: String(pr.commitCount),
      checks: pr.checksTotal ? String(pr.checksTotal) : undefined,
      files: String(pr.changedFiles),
    };
    for (const t of TABS) {
      const on = t === this.tab;
      const b = button(`prp-tab${on ? " is-on" : ""}`, `tab-${t}`, "tab");
      b.id = `prp-tab-${t}`;
      b.dataset.value = t;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.setAttribute("aria-controls", `prp-panel-${t}`);
      b.tabIndex = on ? 0 : -1;
      if (t === "checks" && pr.ci.state !== "none") {
        const c = CI_STATES[pr.ci.state];
        const g = codicon(c.codicon, `prp-tab-ci tone-${c.tone}`);
        b.appendChild(g);
      } else {
        b.appendChild(codicon(TAB_WORDS[t].icon));
      }
      b.appendChild(el("span", "prp-tab-word", TAB_WORDS[t].label));
      if (counts[t] !== undefined) b.appendChild(el("span", "prp-count", counts[t]));
      if (t === "files" && (s.review?.comments.length ?? 0) > 0) {
        const p = el("span", "prp-count is-pending", `${s.review!.comments.length} pending`);
        b.appendChild(p);
      }
      const label = `${TAB_WORDS[t].label}${counts[t] !== undefined ? `, ${counts[t]}` : ""}${t === "checks" ? `, ${ciWords(pr.ci).toLowerCase()}` : ""}`;
      b.setAttribute("aria-label", label);
      nav.appendChild(b);
    }
    return nav;
  }

  // ── Conversation ───────────────────────────────────────────────────────────

  private buildConversation(into: HTMLElement, s: PrPageViewState, pr: PrDetail): void {
    const grid = el("div", "prp-conv");
    const main = el("div", "prp-conv-main");
    const rail = el("aside", "prp-rail");
    rail.setAttribute("aria-label", "About this pull request");
    grid.append(main, rail);
    into.appendChild(grid);

    // The description, as its author's first comment.
    main.appendChild(this.entry("desc", pr.author, "opened this", pr.createdAt, s, prose(pr.body, s.repo, "desc"), "prp-entry-desc"));

    if (pr.timelineTotal > pr.timeline.length) {
      const more = el("p", "prp-note prp-timeline-cut");
      more.dataset.key = "timeline-cut";
      more.append(`Showing the latest ${pr.timeline.length} of ${pr.timelineTotal.toLocaleString("en-US")} events. `);
      const gh = button("prp-link", "timeline-gh", "openOnGitHub");
      gh.textContent = "Open on GitHub for the rest";
      more.appendChild(gh);
      main.appendChild(more);
    }
    const threadsByReview = new Map<string, PrThread[]>();
    const loose: PrThread[] = [];
    for (const t of pr.threads) {
      if (t.reviewId && pr.timeline.some((i) => i.kind === "review" && i.id === t.reviewId)) {
        const list = threadsByReview.get(t.reviewId) ?? [];
        list.push(t);
        threadsByReview.set(t.reviewId, list);
      } else loose.push(t);
    }
    for (const item of pr.timeline) main.appendChild(this.timelineItem(item, s, pr, threadsByReview.get(item.id) ?? []));
    if (loose.length > 0) {
      const sec = el("section", "prp-loose");
      sec.dataset.key = "loose-threads";
      sec.appendChild(el("h3", "prp-section-title", "Review threads"));
      for (const t of loose) sec.appendChild(this.thread(t, s));
      main.appendChild(sec);
    }
    if (pr.threadsTotal > pr.threads.length) {
      main.appendChild(el("p", "prp-note", `Showing ${pr.threads.length} of ${pr.threadsTotal} review threads. Open on GitHub for the rest.`));
    }
    main.appendChild(this.composer(s));

    // The rail: who reviews it, who it is assigned to, its labels.
    rail.appendChild(this.railSection("Reviewers", pr.reviewers.length === 0 ? "No one yet" : undefined, pr.reviewers.map((r) => this.reviewerRow(r))));
    rail.appendChild(
      this.railSection(
        "Assignees",
        pr.assignees.length === 0 ? "No one" : undefined,
        pr.assignees.map((a) => {
          const row = el("div", "prp-person");
          row.dataset.key = `assignee-${a.login}`;
          row.append(avatar(a, 18), el("span", "prp-person-name", a.login));
          return row;
        }),
      ),
    );
    const labels = el("div", "prp-labels");
    for (const l of pr.labels) {
      const c = el("span", "prp-label", l.name);
      c.style.setProperty("--prp-label", `#${l.color}`);
      c.title = `Label: ${l.name}`;
      labels.appendChild(c);
    }
    rail.appendChild(this.railSection("Labels", pr.labels.length === 0 ? "None" : undefined, pr.labels.length ? [labels] : []));
  }

  private railSection(title: string, empty: string | undefined, rows: HTMLElement[]): HTMLElement {
    const sec = el("section", "prp-rail-section");
    sec.dataset.key = `rail-${title}`;
    sec.appendChild(el("h3", "prp-rail-title", title));
    if (empty) sec.appendChild(el("p", "prp-rail-empty", empty));
    for (const r of rows) sec.appendChild(r);
    return sec;
  }

  private reviewerRow(r: PrReviewer): HTMLElement {
    const row = el("div", "prp-person is-reviewer");
    const name = r.team ? `@${r.team}` : (r.login ?? "ghost");
    row.dataset.key = `reviewer-${name}`;
    row.appendChild(avatar(r.team ? null : { login: r.login, avatarUrl: r.avatarUrl }, 18, !!r.team));
    // The name, then what they said under it: a 220px rail has no room for
    // "Changes requested" beside a login without cutting one of them.
    const text = el("span", "prp-person-text");
    text.appendChild(el("span", "prp-person-name", name));
    const tags = el("span", "prp-person-tags");
    const said: string[] = [];
    if (r.verdict && r.verdict !== "PENDING") {
      const v = REVIEW_STATE_WORDS[r.verdict];
      const tag = el("span", `prp-verdict-tag tone-${v.tone}`);
      tag.append(codicon(v.codicon), el("span", "prp-verdict-tag-word", v.word));
      tags.appendChild(tag);
      said.push(v.word.toLowerCase());
    }
    if (r.requested) {
      const tag = el("span", "prp-verdict-tag tone-pending");
      tag.append(codicon("clock"), el("span", "prp-verdict-tag-word", r.verdict ? "Asked again" : "Awaiting review"));
      tags.appendChild(tag);
      said.push(r.verdict ? "asked to review again" : "asked to review");
    }
    if (tags.childNodes.length) text.appendChild(tags);
    row.appendChild(text);
    row.setAttribute("aria-label", `${name}${said.length ? `: ${said.join(", ")}` : ""}`);
    return row;
  }

  /** One entry of the conversation: who, what they did and when, and what they wrote. */
  private entry(key: string, author: PrPerson | null, did: string, at: string, s: PrPageViewState, body: HTMLElement | undefined, cls = "", extra?: HTMLElement): HTMLElement {
    const e = el("article", `prp-entry${cls ? ` ${cls}` : ""}`);
    e.dataset.key = `entry-${key}`;
    e.appendChild(avatar(author, 32));
    const card = el("div", "prp-card");
    const head = el("div", "prp-card-head");
    head.append(el("strong", "prp-author", who(author)), el("span", "prp-card-did", ` ${did} `), when(at, s.now));
    if (extra) head.appendChild(extra);
    card.appendChild(head);
    if (body) {
      const b = el("div", "prp-card-body");
      b.appendChild(body);
      card.appendChild(b);
    }
    e.appendChild(card);
    return e;
  }

  private timelineItem(item: PrTimelineItem, s: PrPageViewState, pr: PrDetail, threads: PrThread[]): HTMLElement {
    if (item.kind === "comment") {
      const sending = item.sending ? el("span", "prp-sending", "Sending…") : undefined;
      return this.entry(item.id, item.author, "commented", item.createdAt, s, prose(item.body, s.repo, item.id), item.sending ? "is-sending" : "", sending);
    }
    if (item.kind === "review") {
      const v = REVIEW_STATE_WORDS[item.state];
      const wrap = el("div", "prp-review-item");
      wrap.dataset.key = `review-${item.id}`;
      const line = el("div", `prp-event tone-${v.tone}`);
      const badge = el("span", "prp-event-glyph");
      badge.appendChild(codicon(v.codicon));
      line.appendChild(badge);
      const text = el("span", "prp-event-text");
      text.append(avatar(item.author, 18), el("strong", "prp-author", who(item.author)), ` ${v.verb} `, when(item.createdAt, s.now));
      if (item.sending) text.appendChild(el("span", "prp-sending", "Sending…"));
      line.appendChild(text);
      wrap.appendChild(line);
      if (item.body.trim()) {
        const card = el("div", "prp-card prp-review-body-card");
        const b = el("div", "prp-card-body");
        b.appendChild(prose(item.body, s.repo, item.id));
        card.appendChild(b);
        wrap.appendChild(card);
      }
      for (const t of threads) wrap.appendChild(this.thread(t, s));
      return wrap;
    }
    const w = timelineEventWords(item, pr.baseRef);
    const line = el("div", `prp-event tone-${w.tone}`);
    line.dataset.key = `event-${item.id}`;
    const badge = el("span", "prp-event-glyph");
    badge.appendChild(codicon(w.codicon));
    line.appendChild(badge);
    const text = el("span", "prp-event-text");
    text.append(avatar(item.actor, 18), el("strong", "prp-author", who(item.actor)), ` ${w.text} `, when(item.createdAt, s.now));
    line.appendChild(text);
    return line;
  }

  /** A review thread: where it is, its comments, a reply box, and Resolve. */
  private thread(t: PrThread, s: PrPageViewState): HTMLElement {
    const box = el("section", `prp-thread${t.resolved ? " is-resolved" : ""}${t.outdated ? " is-outdated" : ""}`);
    box.dataset.key = `thread-${t.id}`;
    const collapsed = t.resolved && !this.shownResolved.has(t.id);
    const head = el("div", "prp-thread-head");
    const where = button("prp-thread-where", `thread-open-${t.id}`, "openThread");
    where.dataset.thread = t.id;
    const line = t.line ?? t.originalLine;
    const place = el("span", "prp-thread-path", t.path);
    if (line) place.appendChild(el("span", "prp-thread-line", `:${t.startLine && t.startLine !== line ? `${t.startLine}–` : ""}${line}`));
    where.append(codicon("file"), place);
    where.title = t.outdated ? `Open ${t.path} — the lines this was written on have changed since` : `Open ${t.path} at line ${line}`;
    head.appendChild(where);
    if (t.outdated) head.appendChild(this.tag("Outdated", "history", "The code it was written on has changed since"));
    if (t.resolved) head.appendChild(this.tag(t.resolvedBy ? `Resolved by ${t.resolvedBy}` : "Resolved", "check", "This conversation is resolved"));
    head.appendChild(el("span", "prp-grow"));
    if (t.resolved) {
      const toggle = button("prp-link", `thread-toggle-${t.id}`, "toggleThread");
      toggle.dataset.thread = t.id;
      toggle.textContent = collapsed ? `Show ${plural(t.comments.length, "comment")}` : "Hide";
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      head.appendChild(toggle);
    }
    box.appendChild(head);
    if (collapsed) return box;
    for (const c of t.comments) {
      const row = el("div", `prp-thread-comment${c.sending ? " is-sending" : ""}`);
      row.dataset.key = `comment-${c.id}`;
      const top = el("div", "prp-thread-comment-head");
      top.append(avatar(c.author, 20), el("strong", "prp-author", who(c.author)), " ", when(c.createdAt, s.now));
      if (c.sending) top.appendChild(el("span", "prp-sending", "Sending…"));
      row.appendChild(top);
      row.appendChild(prose(c.body, s.repo, c.id, " "));
      box.appendChild(row);
    }
    if (t.totalComments > t.comments.length) box.appendChild(el("p", "prp-note", `${t.totalComments - t.comments.length} more on GitHub.`));
    const foot = el("div", "prp-thread-foot");
    if (t.canReply) {
      const area = el("textarea", "prp-textarea prp-reply");
      area.dataset.key = `reply-${t.id}`;
      area.dataset.draft = `reply:${t.id}`;
      area.rows = 1;
      area.placeholder = "Reply…";
      area.setAttribute("aria-label", `Reply to the conversation on ${t.path}`);
      foot.appendChild(area);
      const send = button("gs-btn prp-btn", `reply-send-${t.id}`, "reply", this.isBusy(`reply:${t.id}`) ? "Replying…" : "Reply");
      send.dataset.thread = t.id;
      send.title = "Post your reply on GitHub";
      send.disabled = this.isBusy(`reply:${t.id}`) || !(this.drafts.get(`reply:${t.id}`) ?? "").trim();
      foot.appendChild(send);
    }
    const canToggle = t.resolved ? t.canUnresolve : t.canResolve;
    if (canToggle) {
      const r = button("gs-btn prp-btn", `resolve-${t.id}`, "resolve");
      r.dataset.thread = t.id;
      r.dataset.value = t.resolved ? "unresolve" : "resolve";
      const busy = this.isBusy(`resolve:${t.id}`);
      r.appendChild(codicon(t.resolved ? "issue-reopened" : "check"));
      r.appendChild(el("span", "prp-btn-label", busy ? (t.resolved ? "Unresolving…" : "Resolving…") : t.resolved ? "Unresolve" : "Resolve conversation"));
      r.disabled = busy;
      r.title = t.resolved ? "Open this conversation again" : "Mark this conversation resolved";
      foot.appendChild(r);
    }
    if (foot.childNodes.length) box.appendChild(foot);
    return box;
  }

  private tag(word: string, icon: string, title: string): HTMLElement {
    const t = el("span", "prp-tag");
    t.append(codicon(icon), el("span", "", word));
    t.title = title;
    return t;
  }

  private composer(s: PrPageViewState): HTMLElement {
    const box = el("section", "prp-composer");
    box.dataset.key = "composer";
    box.appendChild(avatar(s.pr?.viewer.login ? { login: s.pr.viewer.login, avatarUrl: s.pr.viewer.avatarUrl ?? null } : null, 32));
    const card = el("div", "prp-card prp-composer-card");
    const area = el("textarea", "prp-textarea prp-comment");
    area.dataset.key = "comment-body";
    area.dataset.draft = "comment";
    area.rows = 3;
    area.placeholder = "Leave a comment — Markdown works";
    area.setAttribute("aria-label", "Add a comment to the conversation");
    card.appendChild(area);
    const foot = el("div", "prp-composer-foot");
    foot.appendChild(el("span", "prp-hint", "Ctrl+Enter to send"));
    const busy = this.isBusy("comment");
    const send = button("gs-btn gs-btn--primary prp-btn", "comment-send", "comment");
    send.append(codicon("comment"), el("span", "prp-btn-label", busy ? "Commenting…" : "Comment"));
    send.disabled = busy || !(this.drafts.get("comment") ?? "").trim();
    send.title = "Post your comment on GitHub";
    foot.appendChild(send);
    card.appendChild(foot);
    box.appendChild(card);
    return box;
  }

  // ── Commits ────────────────────────────────────────────────────────────────

  private buildCommits(into: HTMLElement, s: PrPageViewState, pr: PrDetail): void {
    if (pr.commits.length === 0) {
      into.appendChild(el("p", "prp-empty", "No commits."));
      return;
    }
    if (pr.commitCount > pr.commits.length) {
      into.appendChild(el("p", "prp-note", `Showing the latest ${pr.commits.length} of ${pr.commitCount} commits. Open on GitHub for the rest.`));
    }
    const list = el("ul", "prp-commits");
    list.setAttribute("aria-label", "Commits");
    for (const c of pr.commits) {
      const li = el("li", "prp-commit");
      li.dataset.key = `commit-${c.sha}`;
      const open = this.expanded.has(c.sha);
      const row = button("prp-commit-row", `commit-row-${c.sha}`, "commit");
      row.dataset.sha = c.sha;
      row.setAttribute("aria-expanded", open ? "true" : "false");
      row.appendChild(codicon(open ? "chevron-down" : "chevron-right", "prp-twisty"));
      row.appendChild(avatar(c.author ?? { login: c.authorName, avatarUrl: null }, 20));
      const text = el("span", "prp-commit-text");
      text.append(el("span", "prp-commit-headline", c.headline), el("span", "prp-commit-meta", `${c.author?.login ?? c.authorName} committed ${ageWords(c.committedAt, s.now)}`));
      row.appendChild(text);
      // Its checks, or an empty slot: the sha column lines up either way.
      const g = el("span", `prp-commit-ci${c.ci !== "none" ? ` tone-${CI_STATES[c.ci].tone}` : ""}`);
      if (c.ci !== "none") {
        g.appendChild(codicon(CI_STATES[c.ci].codicon));
        g.title = CI_STATES[c.ci].word;
      }
      row.appendChild(g);
      row.appendChild(el("span", "prp-sha", c.shortSha));
      row.title = `${c.headline}\n${c.sha}`;
      row.setAttribute("aria-label", `Commit ${c.shortSha}: ${c.headline}, by ${c.author?.login ?? c.authorName}, ${ageWords(c.committedAt, s.now)}${c.ci !== "none" ? `, ${CI_STATES[c.ci].word.toLowerCase()}` : ""}`);
      li.appendChild(row);
      if (open) {
        const detail = el("div", "prp-commit-detail");
        if (c.body.trim()) detail.appendChild(el("pre", "prp-commit-body", c.body.trim()));
        const files = s.commitFiles[c.sha];
        if (!files || files.status === "loading") {
          detail.appendChild(el("p", "prp-note", "Loading its files…"));
        } else if (files.status === "failed") {
          const p = el("p", "prp-note tone-failure");
          p.append(`Couldn't load its files. ${files.error ?? ""} `);
          const retry = button("prp-link", `commit-retry-${c.sha}`, "commitRetry");
          retry.dataset.sha = c.sha;
          retry.textContent = "Retry";
          retry.title = "Read its files again";
          p.appendChild(retry);
          detail.appendChild(p);
        } else {
          const ul = el("ul", "prp-flat-files");
          for (const f of files.files ?? []) ul.appendChild(this.fileRow(f, `cf-${c.sha}`, 0, s, { sha: c.sha }));
          if ((files.files ?? []).length === 0) ul.appendChild(el("li", "prp-note", "No file changes."));
          detail.appendChild(ul);
        }
        li.appendChild(detail);
      }
      list.appendChild(li);
    }
    into.appendChild(list);
  }

  // ── Checks ─────────────────────────────────────────────────────────────────

  private buildChecks(into: HTMLElement, s: PrPageViewState, pr: PrDetail): void {
    const ci = CI_STATES[pr.ci.state];
    const head = el("div", `prp-checks-head tone-${ci.tone}`);
    const g = el("span", "prp-status-glyph");
    g.appendChild(codicon(ci.codicon));
    head.append(g, el("span", "prp-checks-sum", ciWords(pr.ci)));
    const commit = pr.commits.at(-1);
    if (commit) head.appendChild(el("span", "prp-checks-on", `on ${commit.shortSha}`));
    into.appendChild(head);
    if (pr.checks.length === 0) {
      into.appendChild(el("p", "prp-empty", "No checks run on this pull request's latest commit."));
      return;
    }
    if (pr.checksTotal > pr.checks.length) into.appendChild(el("p", "prp-note", `Showing ${pr.checks.length} of ${pr.checksTotal} checks.`));
    const list = el("ul", "prp-checks");
    list.setAttribute("aria-label", "Checks");
    pr.checks.forEach((c, i) => list.appendChild(this.checkRow(c, i, s)));
    into.appendChild(list);
  }

  private checkRow(c: PrCheck, i: number, s: PrPageViewState): HTMLElement {
    const w = CHECK_STATES[c.state];
    const li = el("li", `prp-check-row tone-${w.tone}`);
    li.dataset.key = `check-${i}-${c.workflow ?? c.app ?? ""}-${c.name}`;
    const g = el("span", "prp-check-glyph");
    g.appendChild(codicon(w.codicon));
    g.title = w.word;
    li.appendChild(g);
    const text = el("span", "prp-check-text");
    const name = el("span", "prp-check-name");
    if (c.workflow ?? c.app) name.appendChild(el("span", "prp-check-group", `${c.workflow ?? c.app} / `));
    name.append(c.name);
    text.appendChild(name);
    const said = checkWords(c, s.now);
    text.appendChild(el("span", "prp-check-words", c.description ? `${said} — ${c.description}` : said));
    li.appendChild(text);
    // Required, and Details: each in its own column, empty or not, so every
    // row's Details sits in the same place.
    const req = el("span", "prp-check-req");
    if (c.required) req.appendChild(this.tag("Required", "lock", "Required to pass before merging"));
    li.appendChild(req);
    const link = el("span", "prp-check-link");
    if (c.url) {
      const b = button("prp-ghost", `check-details-${i}`, "openUrl");
      b.dataset.url = c.url;
      b.append(codicon("link-external"), el("span", "prp-btn-label", "Details"));
      b.title = `Open ${c.name}'s details`;
      b.setAttribute("aria-label", `Details of ${c.name}`);
      link.appendChild(b);
    }
    li.appendChild(link);
    li.setAttribute("aria-label", `${c.workflow ? `${c.workflow} / ` : ""}${c.name}: ${said}${c.required ? ", required" : ""}`);
    return li;
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  private buildFiles(into: HTMLElement, s: PrPageViewState, pr: PrDetail): void {
    const bar = el("div", "prp-files-head");
    const sum = el("span", "prp-files-sum");
    sum.append(plural(pr.changedFiles, "file"), " ");
    if (pr.additions > 0) sum.appendChild(el("span", "prp-add", `+${pr.additions.toLocaleString("en-US")}`));
    if (pr.deletions > 0) sum.appendChild(el("span", "prp-del", `−${pr.deletions.toLocaleString("en-US")}`));
    bar.appendChild(sum);
    bar.appendChild(el("span", "prp-grow"));
    const open = pr.kind === "open" || pr.kind === "draft";
    if (open) {
      const hint = el("span", "prp-hint", "Open a file, then click + beside a changed line to comment");
      bar.appendChild(hint);
      if (!s.review?.started && (s.review?.comments.length ?? 0) === 0) {
        const start = button("gs-btn prp-btn", "files-start-review", "startReview");
        start.append(codicon(PR_PAGE_ACTION_WORDS.review.icon), el("span", "prp-btn-label", "Start review"));
        start.title = "Open the first file, ready for your comments";
        bar.appendChild(start);
      }
    }
    into.appendChild(bar);
    const files = s.files;
    if (!files) {
      into.appendChild(el("p", "prp-note", "Loading the changed files…"));
      return;
    }
    if (files.error) {
      const p = el("p", "prp-note tone-failure");
      p.textContent = `Couldn't load the changed files. ${files.error}`;
      into.appendChild(p);
      if (files.items.length === 0) return;
    } else if (files.items.length < pr.changedFiles) {
      into.appendChild(el("p", "prp-note", `Showing ${files.items.length} of ${pr.changedFiles} files${pr.changedFiles > 3000 ? " — GitHub lists at most 3,000" : ""}. Open on GitHub for the rest.`));
    }
    if (files.items.length === 0) {
      into.appendChild(el("p", "prp-empty", "No changed files."));
      return;
    }
    const tree = el("ul", "prp-tree");
    tree.setAttribute("role", "tree");
    tree.setAttribute("aria-label", "Changed files");
    const walk = (nodes: PrFileNode[], depth: number, parent: HTMLElement) => {
      for (const n of nodes) {
        if (n.kind === "file") {
          parent.appendChild(this.fileRow(n.file, "f", depth, s));
          continue;
        }
        const folded = this.folded.has(n.path);
        const li = el("li", "prp-dir");
        li.dataset.key = `dir-${n.path}`;
        li.setAttribute("role", "treeitem");
        li.setAttribute("aria-expanded", folded ? "false" : "true");
        const b = button("prp-dir-row", `dir-row-${n.path}`, "dir");
        b.dataset.dir = n.path;
        b.style.setProperty("--prp-depth", String(depth));
        b.append(codicon(folded ? "chevron-right" : "chevron-down", "prp-twisty"), codicon(folded ? "folder" : "folder-opened", "prp-dir-icon"), el("span", "prp-dir-name", n.name));
        b.title = n.path;
        li.appendChild(b);
        if (!folded) {
          const ul = el("ul", "prp-tree-group");
          ul.setAttribute("role", "group");
          walk(n.children, depth + 1, ul);
          li.appendChild(ul);
        }
        parent.appendChild(li);
      }
    };
    walk(fileTree(files.items), 0, tree);
    into.appendChild(tree);
  }

  private fileRow(f: PrPageFile, prefix: string, depth: number, s: PrPageViewState, commit?: { sha: string }): HTMLElement {
    const li = el("li", "prp-file");
    li.dataset.key = `${prefix}-${f.path}`;
    li.setAttribute("role", commit ? "listitem" : "treeitem");
    const st = FILE_STATUS[f.status];
    const b = button("prp-file-row", `${prefix}-row-${f.path}`, commit ? "openCommitFile" : "openFile");
    b.dataset.path = f.path;
    if (commit) b.dataset.sha = commit.sha;
    b.style.setProperty("--prp-depth", String(depth));
    b.appendChild(el("span", "prp-twisty-gap"));
    const letter = el("span", `prp-file-status is-${st.tone}`, st.letter);
    letter.title = st.word;
    b.appendChild(letter);
    const name = el("span", "prp-file-name");
    const base = f.path.slice(f.path.lastIndexOf("/") + 1);
    if (commit) {
      const dir = f.path.slice(0, f.path.length - base.length);
      if (dir) name.appendChild(el("span", "prp-file-dir", dir));
    }
    name.appendChild(el("span", "prp-file-base", base));
    if (f.previousPath) name.appendChild(el("span", "prp-file-from", ` ← ${f.previousPath}`));
    b.appendChild(name);
    if (!commit) {
      const threads = (s.pr?.threads ?? []).filter((t) => t.path === f.path).length;
      const pending = (s.review?.comments ?? []).filter((c) => c.path === f.path).length;
      if (threads > 0) {
        const t = el("span", "prp-file-badge");
        t.append(codicon("comment"), el("span", "", String(threads)));
        t.title = `${plural(threads, "conversation")} on this file`;
        b.appendChild(t);
      }
      if (pending > 0) {
        const t = el("span", "prp-file-badge is-pending");
        t.append(codicon("comment-draft"), el("span", "", `${pending} pending`));
        t.title = `${plural(pending, "pending comment")} of yours on this file`;
        b.appendChild(t);
      }
    }
    const counts = el("span", "prp-file-counts");
    if (f.noDiff && f.additions === 0 && f.deletions === 0) counts.appendChild(el("span", "prp-file-binary", "Binary"));
    if (f.additions > 0) counts.appendChild(el("span", "prp-add", `+${f.additions}`));
    if (f.deletions > 0) counts.appendChild(el("span", "prp-del", `−${f.deletions}`));
    b.appendChild(counts);
    b.title = `${st.word}: ${f.previousPath ? `${f.previousPath} → ` : ""}${f.path}${f.noDiff ? " (GitHub shows no diff for it)" : ""}`;
    b.setAttribute("aria-label", `${f.path}, ${st.word.toLowerCase()}${f.previousPath ? ` from ${f.previousPath}` : ""}, ${f.additions} added, ${f.deletions} removed`);
    li.appendChild(b);
    return li;
  }

  // ── Controls the component owns ────────────────────────────────────────────

  /** Bring every control's live value in line with what the component holds. */
  private syncControls(): void {
    for (const area of this.view.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("[data-draft]")) {
      const want = this.drafts.get(area.dataset.draft ?? "") ?? "";
      if (area.value !== want && document.activeElement !== area) area.value = want;
    }
    const pr = this.state?.pr;
    const title = this.view.querySelector<HTMLInputElement>(".prp-merge-title");
    if (title && pr && this.method) {
      const want = this.titles.get(this.method) ?? defaultMergeTitle(pr, this.method, this.state!.repo.split("/")[0]);
      if (!this.titles.has(this.method)) this.titles.set(this.method, want);
      if (title.value !== want && document.activeElement !== title) title.value = want;
    }
    for (const r of this.view.querySelectorAll<HTMLInputElement>(".prp-method-input")) r.checked = r.value === this.method;
    for (const r of this.view.querySelectorAll<HTMLInputElement>(".prp-verdict-input")) r.checked = r.value === this.verdict;
    const del = this.view.querySelector<HTMLInputElement>(".prp-delete-branch");
    if (del) del.checked = this.deleteBranch;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private repaint(): void {
    if (this.state) this.render(this.state);
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) {
      if (t.dataset.draft) {
        const had = (this.drafts.get(t.dataset.draft) ?? "").trim().length > 0;
        this.drafts.set(t.dataset.draft, t.value);
        // The send button follows whether there is anything to send.
        if (had !== t.value.trim().length > 0) this.repaint();
      } else if (t.classList.contains("prp-merge-title") && this.method) {
        this.titles.set(this.method, t.value);
      }
    }
  }

  private onChange(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.dataset.act === "method") {
      this.method = t.value as PrMergeMethod;
      this.repaint();
    } else if (t.dataset.act === "verdict") {
      this.verdict = t.value as Verdict;
      this.repaint();
    } else if (t.dataset.act === "deleteBranch") {
      this.deleteBranch = t.checked;
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLTextAreaElement && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const d = t.dataset.draft ?? "";
      if (d === "comment") this.sendComment();
      else if (d === "review") this.submitReview();
      else if (d.startsWith("reply:")) this.sendReply(d.slice(6));
      return;
    }
    if (t.classList.contains("prp-tab") && ["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const all = [...this.view.querySelectorAll<HTMLElement>(".prp-tab")];
      const i = all.indexOf(t);
      const j = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + all.length) % all.length;
      const next = all[j];
      if (next) {
        this.setTab(next.dataset.value as PrPageTab);
        this.view.querySelector<HTMLElement>(`#prp-tab-${next.dataset.value}`)?.focus();
      }
      return;
    }
    if (e.key === "Escape" && this.panel && (t.closest(".prp-panel") || t === document.body)) {
      e.preventDefault();
      if (this.confirmDiscard) {
        this.confirmDiscard = false;
        this.repaint();
        this.view.querySelector<HTMLElement>('[data-act="discard"]')?.focus();
        return;
      }
      this.panel = undefined;
      this.repaint();
      this.focusBack();
    }
  }

  private setTab(tab: PrPageTab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    this.opts.post({ type: "tab", tab });
    this.repaint();
  }

  /** Empty a box whose words were sent (the host puts them back if GitHub refuses them). */
  private clearBox(key: string): void {
    this.drafts.delete(key);
    for (const box of this.view.querySelectorAll<HTMLTextAreaElement>("[data-draft]")) if (box.dataset.draft === key) box.value = "";
  }

  private sendComment(): void {
    const body = (this.drafts.get("comment") ?? "").trim();
    if (!body || this.isBusy("comment")) return;
    this.clearBox("comment");
    this.opts.post({ type: "comment", body });
    this.repaint();
  }

  private sendReply(threadId: string): void {
    const key = `reply:${threadId}`;
    const body = (this.drafts.get(key) ?? "").trim();
    if (!body || this.isBusy(key)) return;
    this.clearBox(key);
    this.opts.post({ type: "reply", threadId, body });
    this.repaint();
  }

  private submitReview(): void {
    if (this.isBusy("review")) return;
    const body = (this.drafts.get("review") ?? "").trim();
    this.opts.post({ type: "submitReview", event: this.verdict, body });
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    // A link in a body goes to the host: a reference opens its page here.
    const a = target.closest<HTMLAnchorElement>("a[href]");
    if (a && (this.view.contains(a) || this.layer.contains(a))) {
      e.preventDefault();
      const n = Number(a.dataset.refNumber);
      if (a.dataset.refRepo && Number.isSafeInteger(n) && n > 0) this.opts.post({ type: "openRef", repo: a.dataset.refRepo, number: n });
      else if (/^https?:\/\//i.test(a.href)) this.opts.post({ type: "openUrl", url: a.href });
      return;
    }
    const t = target.closest<HTMLElement>("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "method" || act === "verdict" || act === "deleteBranch") return; // their change event does it
    switch (act) {
      case "tab":
        this.setTab(t.dataset.value as PrPageTab);
        return;
      case "merge":
        this.panel = this.panel === "merge" ? undefined : "merge";
        this.opener = t.dataset.key;
        this.focusAfter = this.panel ? MERGE_FOCUS : undefined;
        this.repaint();
        return;
      case "review":
        this.panel = this.panel === "review" ? undefined : "review";
        this.opener = t.dataset.key;
        this.confirmDiscard = false;
        this.focusAfter = this.panel ? ".prp-review-body" : undefined;
        this.repaint();
        return;
      case "approve":
        // The review box, with Approve chosen: an approval is a public, named
        // act, and the box is where its summary is written — as on the desktop.
        this.panel = "review";
        this.opener = t.dataset.key;
        this.verdict = "APPROVE";
        this.confirmDiscard = false;
        this.focusAfter = ".prp-review-body";
        this.repaint();
        return;
      case "closePanel":
        this.panel = undefined;
        this.confirmDiscard = false;
        this.repaint();
        this.focusBack();
        return;
      case "mergeConfirm": {
        const pr = this.state?.pr;
        if (!pr || !this.method || this.isBusy("merge")) return;
        const title = this.method === "rebase" ? undefined : (this.titles.get(this.method) ?? "").trim();
        const deleteBranch = !pr.isFork && !pr.repo.deleteBranchOnMerge && pr.viewer.canDeleteBranch && this.deleteBranch;
        this.opts.post({ type: "merge", method: this.method, ...(title ? { title } : {}), deleteBranch });
        return;
      }
      case "submitReview":
        this.submitReview();
        return;
      case "discard":
        this.confirmDiscard = true;
        this.focusAfter = '[data-act="discardNo"]';
        this.repaint();
        return;
      case "discardNo":
        this.confirmDiscard = false;
        this.focusAfter = '[data-act="discard"]';
        this.repaint();
        return;
      case "discardYes":
        this.confirmDiscard = false;
        this.opts.post({ type: "discardReview" });
        this.repaint();
        return;
      case "comment":
        this.sendComment();
        return;
      case "reply":
        if (t.dataset.thread) this.sendReply(t.dataset.thread);
        return;
      case "resolve":
        if (t.dataset.thread) this.opts.post({ type: "resolve", threadId: t.dataset.thread, resolved: t.dataset.value === "resolve" });
        return;
      case "toggleThread": {
        const id = t.dataset.thread ?? "";
        if (this.shownResolved.has(id)) this.shownResolved.delete(id);
        else this.shownResolved.add(id);
        this.repaint();
        return;
      }
      case "openThread": {
        const th = this.state?.pr?.threads.find((x) => x.id === t.dataset.thread);
        if (th) this.opts.post({ type: "openFile", path: th.path, ...(th.line ? { line: th.line, side: th.side } : {}) });
        return;
      }
      case "openPending": {
        const line = Number(t.dataset.line);
        this.opts.post({ type: "openFile", path: t.dataset.path ?? "", ...(Number.isSafeInteger(line) && line > 0 ? { line, side: t.dataset.side === "LEFT" ? "LEFT" : "RIGHT" } : {}) });
        return;
      }
      case "commit": {
        const sha = t.dataset.sha ?? "";
        if (this.expanded.has(sha)) this.expanded.delete(sha);
        else {
          this.expanded.add(sha);
          const known = this.state?.commitFiles[sha];
          if (!known || known.status === "failed") this.opts.post({ type: "expandCommit", sha });
        }
        this.repaint();
        return;
      }
      case "commitRetry":
        if (t.dataset.sha) this.opts.post({ type: "expandCommit", sha: t.dataset.sha });
        return;
      case "dir": {
        const d = t.dataset.dir ?? "";
        if (this.folded.has(d)) this.folded.delete(d);
        else this.folded.add(d);
        this.repaint();
        return;
      }
      case "openFile":
        if (t.dataset.path) this.opts.post({ type: "openFile", path: t.dataset.path });
        return;
      case "openCommitFile":
        if (t.dataset.path && t.dataset.sha) this.opts.post({ type: "openCommitFile", sha: t.dataset.sha, path: t.dataset.path });
        return;
      case "openUrl":
        if (t.dataset.url && /^https?:\/\//i.test(t.dataset.url)) this.opts.post({ type: "openUrl", url: t.dataset.url });
        return;
      case "more":
        if (this.moreOpen) this.closeMore(true);
        else this.openMore();
        return;
      case "action":
        {
          const action = BUTTON_ACTIONS.get(t);
          if (action) this.opts.post({ type: "action", action });
        }
        return;
      case "startReview":
        this.opts.post({ type: "startReview" });
        return;
      case "checkout":
      case "refresh":
      case "openOnGitHub":
      case "copyLink":
      case "close":
      case "reopen":
      case "markReady":
      case "updateBranch":
        this.closeMore(false);
        this.opts.post({ type: act });
        return;
    }
  }

  // ── More Actions ───────────────────────────────────────────────────────────

  private openMore(): void {
    this.moreOpen = true;
    this.drawMore();
    this.layer.querySelector<HTMLElement>(".prp-menu-item")?.focus();
    this.view.querySelector('[data-act="more"]')?.setAttribute("aria-expanded", "true");
  }

  private closeMore(returnFocus: boolean): void {
    if (!this.moreOpen) return;
    this.moreOpen = false;
    this.layer.replaceChildren();
    const anchor = this.view.querySelector<HTMLElement>('[data-act="more"]');
    anchor?.setAttribute("aria-expanded", "false");
    if (returnFocus) anchor?.focus();
  }

  private drawMore(): void {
    const pr = this.state?.pr;
    const anchor = this.view.querySelector<HTMLElement>('[data-act="more"]');
    if (!pr || !anchor) {
      this.closeMore(false);
      return;
    }
    const menu = el("div", "prp-menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "More actions");
    // The desktop's More actions: Update branch · Close pull request · Copy
    // link, a line between the groups. Open on GitHub and Refresh have their
    // own buttons at the header's end.
    const items: PrPageAction[] = prPageActions(pr).more;
    for (const [i, a] of items.entries()) {
      if (i > 0 && (a === "close" || a === "copyLink")) {
        const sep = el("div", "prp-menu-sep");
        sep.setAttribute("role", "separator");
        menu.appendChild(sep);
      }
      const w = PR_PAGE_ACTION_WORDS[a];
      const b = button("prp-menu-item", `menu-${a}`, a);
      b.setAttribute("role", "menuitem");
      const busy = a === "close" && this.isBusy("close");
      b.append(codicon(w.icon), el("span", "prp-menu-label", busy ? "Closing…" : w.label));
      b.disabled = busy;
      b.title = w.title;
      if (a === "close") b.classList.add("is-danger");
      menu.appendChild(b);
    }
    this.layer.replaceChildren(menu);
    const r = anchor.getBoundingClientRect();
    const width = 220;
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
    menu.style.top = `${r.bottom + 4}px`;
  }

  private onMenuKey(e: KeyboardEvent): void {
    if (!this.moreOpen) return;
    const items = [...this.layer.querySelectorAll<HTMLElement>(".prp-menu-item:not([disabled])")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      this.closeMore(e.key === "Escape");
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1]?.focus();
    }
  }
}
