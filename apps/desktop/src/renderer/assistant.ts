// The Assistant view — an agent that automates Git/dev workflow tasks in the
// open repository using the user's OWN connected model. It streams the agent's
// reasoning and every tool call/result live, and asks for explicit approval
// before any write or destructive action (the human-in-the-loop gate).
//
// Rendered as a SectionRender so it slots into the shell's view router with no
// renderer.ts surgery beyond a nav entry. All listeners are scoped to a single
// run and torn down when it ends, so navigating away never leaks.

import { host } from "./bridge";
import { gget } from "./cache";
import { el, span, glyph, openMenu, relTimeISO } from "./ui";
import type { MenuItem } from "./ui";
import { confirmDialog, toast } from "./dialogs";
import { runAgentTurn, addBubble, markdownBlock, errorBlock, connectPrompt, elText, setBusy, scrollDown, atBottom } from "./chatRender";
import type { SectionRender } from "./views/common";
import type { AiModelOption, AiSettingsView, ChatView } from "../shared/ipc";

/** A goal handed in from elsewhere (✨ actions in PR/issue views) — consumed
 *  by the next render. The ✨ flow used to open a CHAT TAB in the bottom dock,
 *  which split the screen in half; now it lands here, in the one AI surface. */
let pendingGoal: string | null = null;
/** What the USER BUBBLE should say for that goal.
 *
 *  A ✨ action's goal is a whole prompt — "Analyze this issue:" plus the title,
 *  the body and every comment on it — and it was posted verbatim as the user's
 *  chat message. Opening ✨ Analyze on a busy issue put several screens of
 *  quoted text into the transcript as if the reader had typed it, burying the
 *  answer below the fold. The dock's chat tab has carried a short label for
 *  exactly this since it was written (`seedLabel` → `runAgentTurn`'s
 *  `displayText`); the section path dropped it on the floor. */
let pendingLabel: string | undefined;

/** The Assistant currently on screen, if there is one — so a ✨ action can be
 *  handed to it instead of rebuilding the view around it. Cleared when the view
 *  is torn down. */
let live:
  | { run: (goal: string, label?: string) => void; busy: () => boolean; el: HTMLElement }
  | undefined;

/**
 * Seed a goal for the Assistant, and say whether the caller still needs to
 * route there.
 *
 * `false` means it has already been handed to the Assistant on screen. The
 * caller used to route unconditionally with `force: true`, which drops the view
 * from the cache and rebuilds it — so firing a second ✨ action while the agent
 * was answering the first destroyed the transcript and the Stop button and
 * orphaned the run, with no confirm and no cancel. Exactly the defect the
 * refreshAll exemption fixes, reached through a different door.
 */
export function seedAssistantGoal(goal: string, label?: string): boolean {
  // The BUSY test asks about identity, not attachment.
  //
  // Every ✨ action fires from another view — an issue, a PR, the compare page
  // — and "assistant" is keep-alive, so by the time this runs the wrap is
  // PARKED: detached, and very much alive with a turn streaming into it. An
  // `isConnected` guard therefore made this branch unreachable in every real
  // case, which is the identical mistake `onAiChanged` twenty lines below
  // carries a comment about. The toast below had never once been shown.
  if (live?.busy()) {
    toast("The agent is still working — stop it first, or wait for it to finish.", "info");
    return false;
  }
  // The IDLE branch keeps `isConnected`, deliberately. A parked view can be
  // evicted from the cache (leaving during the initial gate drops it), and
  // `live` is never cleared — so running a goal into an evicted node would
  // write it into a true orphan and the route below would then build a fresh,
  // empty Assistant with the goal lost.
  if (live?.el.isConnected) {
    live.run(goal, label);
    return false;
  }
  pendingGoal = goal;
  pendingLabel = label;
  return true;
}

/** Agent write permission, remembered across navigations within a session. */
let permission: "read" | "write" | "destructive" = "read";
/** The explicit model id the user picked (from the provider's models). */
let selectedModelId: string | undefined;
/** Reasoning depth for the Assistant — seeded from the saved agent config. */
let thinkLevel: "off" | "auto" | "extended" = "auto";

const THINK_OPTS: Array<{ id: "off" | "auto" | "extended"; label: string }> = [
  { id: "off", label: "No thinking" },
  { id: "auto", label: "Auto thinking" },
  { id: "extended", label: "Extended thinking" },
];
const ACCESS_OPTS: Array<{ id: "read" | "write" | "destructive"; label: string }> = [
  { id: "read", label: "Read-only" },
  { id: "write", label: "Allow commits" },
  { id: "destructive", label: "Allow everything" },
];
const thinkText = (id: string): string => THINK_OPTS.find((o) => o.id === id)?.label ?? "Thinking";
const accessText = (id: string): string => ACCESS_OPTS.find((o) => o.id === id)?.label ?? "Access";
/** Trim a long model id for the chip ("anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"). */
const shortModel = (id: string): string => id.split("/").pop() ?? id;

/** The six things people ask a repository agent first. Each is a card in the
 *  empty state (label + what it does) and a chip in the composer once a
 *  conversation is under way. Every goal says what it may NOT do. */
const QUICK_ACTIONS: Array<{ icon: string; label: string; desc: string; goal: string }> = [
  {
    icon: "git-commit",
    label: "Draft a commit",
    desc: "A message for what's staged, for you to approve.",
    goal: "Draft a commit message for my staged changes and show it to me. Don't commit unless I confirm.",
  },
  {
    icon: "list-unordered",
    label: "Summarize my changes",
    desc: "What the working tree changes, in a few bullets.",
    goal: "Summarize my current working-tree changes in a few bullet points.",
  },
  {
    icon: "eye",
    label: "Review my changes",
    desc: "Bugs, risks and regrets, before they are committed.",
    goal: "Review my uncommitted changes: point out bugs, risks and anything I would regret committing. Don't change anything.",
  },
  {
    icon: "git-compare",
    label: "What does this branch add?",
    desc: "This branch against the default branch, explained.",
    goal: "Compare the current branch against the default branch and explain, concisely, what it changes.",
  },
  {
    icon: "tag",
    label: "Draft release notes",
    desc: "From the commits since the last tag.",
    goal: "Draft release notes from the commits since the last tag.",
  },
  {
    icon: "git-branch",
    label: "Which branches can go?",
    desc: "Merged and stale branches, and which are safe to delete.",
    goal: "List the local branches that are merged or stale and say which are safe to delete. Don't delete anything.",
  },
];

export const renderAssistant: SectionRender = (wrap, nav) => {
  wrap.classList.add("assistant-view");

  let currentChatId: string | undefined;

  const header = el("div", "assistant-head");
  const titleWrap = el("div", "assistant-title-wrap");
  const title = el("div", "assistant-title");
  title.append(glyph("sparkle"), span("Assistant"));
  // The chat's own subject, once it has one — "Assistant" alone said nothing
  // about which of your conversations was on screen.
  const chatTitle = el("span", "assistant-chat-title");
  chatTitle.hidden = true;
  const setChatTitle = (t: string | undefined): void => {
    const v = (t ?? "").trim();
    chatTitle.textContent = v;
    chatTitle.title = v;
    chatTitle.hidden = !v;
  };
  titleWrap.append(title, chatTitle);
  const connTag = el("span", "assistant-model");
  // New-chat + chat-history controls — sessions persist across refresh/restart.
  const newBtn = el("button", "assistant-iconbtn") as HTMLButtonElement;
  newBtn.dataset.baseTitle = "New chat";
  newBtn.title = "New chat";
  newBtn.append(glyph("add"));
  newBtn.addEventListener("click", () => void newChat());
  const histBtn = el("button", "assistant-iconbtn") as HTMLButtonElement;
  histBtn.dataset.baseTitle = "Chat history";
  histBtn.title = "Chat history";
  histBtn.append(glyph("history"));
  histBtn.addEventListener("click", () => void openHistory());
  /** The two chat-management controls — off while the gate is closed, since
   *  there are no chats to manage and their handlers return on their own. */
  const chatBtns: HTMLButtonElement[] = [newBtn, histBtn];
  header.append(titleWrap, newBtn, histBtn);

  // Three compact dropdown "chips" — the agent's options shown directly here and
  // propagated from the connected provider (no Settings setup needed). Each pick
  // is remembered (persisted to the agent config).
  const controls = el("div", "assistant-controls");
  /**
   * Disabled in the ACCESSIBILITY tree, not only in CSS.
   *
   * `.is-disabled` sets `opacity: .5` and `pointer-events: none`, which tells a
   * sighted mouse user everything and a screen-reader user nothing: the chips
   * still announced as ordinary buttons, and their labels measured 2.93:1 with
   * no state to explain why.
   */
  const setControlsDisabled = (off: boolean): void => {
    controls.classList.toggle("is-disabled", off);
    controls.setAttribute("aria-disabled", String(off));
    for (const b of controls.querySelectorAll("button")) {
      b.setAttribute("aria-disabled", String(off));
      b.tabIndex = off ? -1 : 0;
    }
  };

  /** Build a chip whose menu items are produced fresh each open. */
  /** The three run-setting chips, so one rule can say when they take effect. */
  const settingChips: HTMLElement[] = [];
  const makeChip = (icon: string, initial: string, items: () => MenuItem[]): { el: HTMLElement; set: (t: string) => void } => {
    const b = el("button", "assistant-chip-ctl");
    settingChips.push(b);
    const ic = glyph(icon);
    const lab = span(initial, "assistant-chip-label");
    const car = glyph("chevron-down");
    car.classList.add("assistant-chip-caret");
    b.append(ic, lab, car);
    b.addEventListener("click", () => openMenu(b, items()));
    return { el: b, set: (t: string) => (lab.textContent = t) };
  };

  let modelOptions: AiModelOption[] = [];
  const modelChip = makeChip("sparkle", "Model", () => {
    if (modelOptions.length === 0) return [{ label: "No models available", disabled: true }];
    return modelOptions.map((m) => ({
      label: m.label ?? shortModel(m.id),
      current: m.id === selectedModelId,
      onClick: () => {
        selectedModelId = m.id;
        modelChip.set(shortModel(m.id));
        void host.invoke("ai:setAgentConfig", { modelId: m.id });
      },
    }));
  });
  const thinkChip = makeChip("lightbulb", thinkText(thinkLevel), () =>
    THINK_OPTS.map((o) => ({
      label: o.label,
      current: o.id === thinkLevel,
      onClick: () => {
        thinkLevel = o.id;
        thinkChip.set(o.label);
        void host.invoke("ai:setAgentConfig", { thinking: o.id });
      },
    })),
  );
  const accessChip = makeChip("shield", accessText(permission), () =>
    ACCESS_OPTS.map((o) => ({
      label: o.label,
      current: o.id === permission,
      onClick: () => {
        permission = o.id;
        accessChip.set(o.label);
        void host.invoke("ai:setAgentConfig", { permission: o.id });
      },
    })),
  );
  // The connection's name leads its own settings, at the right — after the
  // chat's title it read as part of the title.
  controls.append(connTag, modelChip.el, thinkChip.el, accessChip.el);
  header.append(controls);

  const transcript = el("div", "assistant-transcript");
  // Reachable by keyboard. A scrollable region that cannot take focus cannot be
  // scrolled by anything but a pointer — PageUp, Home and the arrows all need a
  // focused scroller to act on, and this one had no tabindex at all. It is the
  // longest-lived scroller in the app: a chat you have been working in all day.
  transcript.tabIndex = 0;
  transcript.setAttribute("role", "log");
  transcript.setAttribute("aria-label", "Conversation");
  // The transcript and the "Jump to latest" pill share a frame, so the pill
  // floats over the tail of the conversation instead of scrolling with it.
  const body = el("div", "assistant-body");
  const jump = el("button", "assistant-jump") as HTMLButtonElement;
  jump.append(glyph("arrow-down"), span("Jump to latest"));
  jump.hidden = true;
  jump.addEventListener("click", () => {
    scrollDown(transcript, true);
    jump.hidden = true;
  });
  body.append(transcript, jump);

  const composer = el("div", "assistant-composer");
  const quick = el("div", "assistant-quick");
  const chips: HTMLButtonElement[] = [];
  for (const qa of QUICK_ACTIONS) {
    const chip = el("button", "assistant-chip") as HTMLButtonElement;
    chip.append(glyph(qa.icon), span(qa.label));
    chip.title = qa.desc;
    // `fromInput: false` — a chip carries its OWN goal, so clearing the
    // composer would throw away a message the user had typed and not yet sent,
    // in exchange for running something else entirely.
    chip.addEventListener("click", () => void runGoal(qa.goal, false));
    quick.append(chip);
    chips.push(chip);
  }
  const inputRow = el("div", "assistant-input-row");
  const input = document.createElement("textarea");
  input.className = "assistant-input";
  input.rows = 2;
  input.placeholder = "Ask about this repository, or tell the agent what to do…";
  input.setAttribute("aria-label", "Message the agent");
  const send = el("button", "btn btn-primary assistant-send") as HTMLButtonElement;
  // An up arrow, not a paper plane: `codicon-send` is a thin diagonal outline
  // whose mass sits optically off-centre in a round button, and it suffers most
  // in a single-weight icon font. Up is orthogonal, centrable, and literal —
  // the transcript it feeds is directly above.
  send.append(glyph("arrow-up"));
  send.title = "Send · Enter";
  send.setAttribute("aria-keyshortcuts", "Enter");
  inputRow.append(input, send);
  // Under the box: where the agent is working, and how to send.
  const foot = el("div", "assistant-foot");
  const context = el("span", "assistant-context");
  const hint = el("span", "assistant-hint");
  hint.textContent = "Enter to send · Shift+Enter for a new line";
  foot.append(context, hint);
  composer.append(quick, inputRow, foot);

  // replaceChildren, not append: mountSection puts a loading skeleton in this
  // container first, and the Assistant renders synchronously — so appending
  // left a six-row shimmer pinned above the header, 278px of the pane,
  // pretending to load something forever.
  wrap.replaceChildren(header, body, composer);

  // "gitstudio · main" — the agent acts on the OPEN repository, and the
  // composer says which before you tell it to do anything to it.
  void (async () => {
    const [repo, sync] = await Promise.all([
      gget("repo:current", undefined, 4000).catch(() => undefined),
      gget("sync:status", undefined, 4000).catch(() => undefined),
    ]);
    if (!repo) return;
    context.replaceChildren(glyph("repo"), span(repo.name, "assistant-context-repo"));
    if (sync?.branch) context.append(span("·", "assistant-context-dot"), span(sync.branch, "assistant-context-branch"));
    context.title = repo.root;
  })();

  // The pill shows when content lands below a reader who has scrolled up — the
  // one case where the transcript deliberately does NOT move (chatRender's
  // scrollDown) and so needs a way back down.
  transcript.addEventListener("scroll", () => {
    if (atBottom(transcript)) jump.hidden = true;
  });
  new MutationObserver(() => {
    jump.hidden = atBottom(transcript) || transcript.scrollHeight <= transcript.clientHeight + 24;
  }).observe(transcript, { childList: true, subtree: true, characterData: true });

  let running = false;
  /** Stops the turn currently streaming — the same abort the Stop button uses,
   *  reachable from the places that would otherwise leave a run going with its
   *  transcript detached. */
  let cancelRun: (() => void) | undefined;
  /** The connection gate refused — every control stays off until Settings
   *  changes, and nothing transient (a finished run, a re-render) may quietly
   *  turn them back on. */
  let gated = false;

  /** Send is off with nothing to send. It used to be lit over an empty
   *  composer, and clicking it called `runGoal("")`, which returns on its own
   *  first line — a primary button that did nothing, with no way to tell that
   *  from a broken one. */
  /** Everything the composer owns, in one place.
   *
   *  The chips and the two "New chat" entry points were enabled in states where
   *  pressing them did nothing at all: a chip during a run hit `runGoal`'s
   *  `if (running) return`, and New chat while gated hit its own `if (gated)
   *  return`. Both guards are correct and neither is visible, so the control
   *  looked live and answered with silence. */
  const syncControls = (): void => {
    const off = gated || running;
    for (const c of chips) {
      c.disabled = off;
      c.title = gated
        ? "Connect a model to use the Assistant"
        : running
          ? "The agent is still working"
          : "";
    }
    for (const b of chatBtns) {
      b.disabled = gated;
      b.title = gated ? "Connect a model to use the Assistant" : b.dataset.baseTitle || "";
    }
    // The model, thinking level and access are read when a turn STARTS and
    // travel with it. Changing one mid-run relabels the chip and leaves the
    // running turn on the old value — so the chip states, in the present tense,
    // something the agent working below it is not doing. It stays usable (you
    // are usually setting up the next message) and says when it applies.
    for (const b of settingChips) {
      b.title = running ? "Applies to your next message — this turn keeps what it started with" : "";
    }
  };

  const syncSend = (): void => {
    syncControls();
    // HANDS OFF while a turn is running. During a run this button is not Send —
    // `swapToCancel` has turned it into Stop, and it owns its own enabled
    // state. Including `running` in this expression meant that typing your next
    // message while the agent worked disabled the Stop button on the first
    // keystroke: the only way to stop a running agent, taken away by using the
    // composer it sits next to.
    if (running) return;
    send.disabled = gated || !input.value.trim();
    // Say WHY it is off. The chips beside it already do, so gated and empty
    // used to be indistinguishable on the one primary action of the surface.
    // The gated string is verbatim the chips' string above.
    send.title = gated ? "Connect a model to use the Assistant" : "Send · Enter";
  };

  /** Grow with the text, up to the height the stylesheet already budgets.
   *  Locked at two rows, a pasted commit message or a paragraph-long task was
   *  read through a 40px slot while 180px of empty composer sat under it. */
  const autoGrow = (): void => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  };
  input.addEventListener("input", () => {
    syncSend();
    autoGrow();
  });

  const empty = el("div", "assistant-empty");
  empty.append(
    glyph("sparkle"),
    elText("div", "assistant-empty-title", "Your repo's AI agent"),
    elText(
      "div",
      "assistant-empty-sub",
      "It reads real status, diffs and history before acting, and asks before it writes anything. Start with one of these, or describe a task.",
    ),
  );
  // The quick actions as CARDS, each with a line of what it does — the same
  // six the composer's chips run once a conversation is under way.
  const grid = el("div", "assistant-qa-grid");
  for (const qa of QUICK_ACTIONS) {
    const card = el("button", "assistant-qa-card") as HTMLButtonElement;
    card.append(glyph(qa.icon), elText("span", "assistant-qa-title", qa.label), elText("span", "assistant-qa-desc", qa.desc));
    card.addEventListener("click", () => void runGoal(qa.goal, false));
    grid.append(card);
    chips.push(card);
  }
  empty.append(grid);
  /** `is-empty` on the view hides the composer's chips while the cards are up
   *  — the same six actions twice on one screen read as a mistake. */
  const showEmpty = (): void => {
    transcript.replaceChildren(empty);
    wrap.classList.add("is-empty");
  };
  const hideEmpty = (): void => {
    empty.remove();
    wrap.classList.remove("is-empty");
  };
  const showGatePrompt = (): void => {
    transcript.replaceChildren(connectPrompt(nav));
    wrap.classList.add("is-empty");
  };
  showEmpty();

  // Gate on a usable connection.
  //
  // Held as a PROMISE: a ✨ goal seeded from another view starts at the bottom
  // of this function, synchronously, while this is still in flight — so it ran
  // before `permission`, `thinkLevel` and `selectedModelId` had been read out
  // of settings, and then had its transcript wiped by the `restoreChat` below
  // landing a quarter-second later. Both callers await it now.
  const runGate = async (): Promise<void> => {
    let settings: AiSettingsView | undefined;
    try {
      settings = await host.invoke("ai:settings", undefined);
    } catch {
      settings = undefined;
    }
    if (!settings || !settings.enabled) {
      gated = true;
      showGatePrompt();
      input.disabled = true;
      // The chips and the two chat controls too. They sat live in front of the
      // "Connect a model" panel, and pressing one hit a guard that returns
      // silently — a control that looks live and answers with nothing.
      syncSend(); // owns send, the chips and the chat buttons
      setControlsDisabled(true);
    } else {
      const def = settings.connections.find((c) => c.id === settings!.defaultId) ?? settings.connections.find((c) => c.usable);
      connTag.textContent = def ? def.label : "";
      // Seed the controls from the saved agent config.
      permission = settings.agent.permission;
      thinkLevel = settings.agent.thinking;
      selectedModelId = settings.agent.modelId;
      thinkChip.set(thinkText(thinkLevel));
      accessChip.set(accessText(permission));
      // Propagate the provider's models into the picker.
      try {
        modelOptions = await host.invoke("ai:models", undefined);
      } catch {
        modelOptions = [];
      }
      if (!selectedModelId && modelOptions[0]) {
        selectedModelId = modelOptions[0].id;
      }
      modelChip.set(selectedModelId ? shortModel(selectedModelId) : "Model");
      // Restore the chat the user last had open in this repo (survives refresh).
      try {
        const cur = await host.invoke("ai:chatCurrent", undefined);
        if (cur) {
          currentChatId = cur.id;
          setChatTitle(cur.turns.length > 0 ? cur.title : "");
          // `restoreChat` replaces the transcript wholesale, so this used to
          // delete a ✨ turn's answer and its Stop button mid-stream. The
          // ordering is settled now — `runGoal` awaits this gate before writing
          // its first bubble — so the guard that skipped the restore is no
          // longer needed, and skipping it was its own bug: the seeded turn
          // then ran into a chat whose HISTORY was never drawn, so the answer
          // arrived with no sign of the conversation it was continuing.
          if (cur.turns.length > 0) restoreChat(cur);
        }
      } catch {
        /* no prior chat */
      }
    }
  };
  const ready = runGate();

  // Connecting a model in Settings must LIFT the gate. This view is kept alive,
  // so its gated DOM was re-attached unchanged on every later visit — the
  // Assistant stayed behind "Connect a model" for the rest of the session with
  // a working connection sitting behind it, and the only way out was to restart
  // the app.
  const onAiChanged = (): void => {
    // NOT gated on `wrap.isConnected`.
    //
    // Connecting a model means going to Settings, which PARKS this view in the
    // keep-alive cache — detached, but very much alive and about to be shown
    // again. An `isConnected` guard here therefore fired on the one path that
    // matters and, worse, unsubscribed: the gate could then never lift, which
    // is the whole defect this listener exists to fix, restored by the guard
    // added to stop it leaking.
    //
    // The leak is answered by identity instead. Each build registers itself as
    // `live`; only the newest one acts, and the older listeners fall out with
    // their closures when nothing references them.
    if (live?.el !== wrap) {
      window.removeEventListener("gs:ai-changed", onAiChanged);
      return;
    }
    // BOTH directions. This returned early when the Assistant was ungated, so
    // it only ever opened the gate and never closed it: removing the last
    // model, or the last usable key, left the composer live and the header
    // still advertising a connection that no longer exists — and the first
    // message went to a provider the app had just been told about.
    void (async () => {
      const s = await host.invoke("ai:settings", undefined).catch(() => undefined);
      if (live?.el !== wrap) return;
      const enabled = !!s?.enabled;
      if (gated === !enabled) return; // nothing changed for this view
      if (enabled) {
        gated = false;
        showEmpty();
        input.disabled = false;
        setControlsDisabled(false);
        syncSend(); // …and back on again, through the same rule
        await runGate(); // re-seed the model, permission and thinking controls
      } else {
        gated = true;
        connTag.textContent = "";
        showGatePrompt();
        input.disabled = true;
        setControlsDisabled(true);
        syncSend(); // owns send, the chips and the chat buttons
      }
    })();
  };
  window.addEventListener("gs:ai-changed", onAiChanged);

  // Publish this Assistant so a ✨ action fired while it is on screen is handed
  // to it, rather than routed to with `force` — which rebuilds the view and
  // takes a running turn down with it.
  live = {
    el: wrap,
    busy: () => running,
    run: (goal, label) => void runGoal(goal, false, label),
  };

  function restoreChat(chat: ChatView): void {
    hideEmpty();
    transcript.replaceChildren();
    for (const t of chat.turns) {
      if (t.role === "user") addBubble(transcript, "user", t.text);
      else {
        // Inside a `.assistant-turn`, exactly as the live path builds it. Only
        // the turn carries the measure (`max-width: min(760px, 94%)`), so a
        // restored answer ran the full 820px of the pane while the identical
        // message, live, had been 760 — the same text at two widths depending
        // on whether you had left the chat and come back.
        const turn = el("div", "assistant-turn");
        turn.append(markdownBlock(t.text));
        transcript.append(turn);
      }
    }
    scrollDown(transcript, true); // opening a chat lands on its latest turn
  }

  /** A chat cannot be left while a turn is streaming into it: both routes here
   *  replace the transcript, so the answer being written vanished mid-sentence
   *  and the run kept going invisibly — writing into a detached node, with the
   *  Stop button gone and no way to reach it. Stop first, then switch. */
  async function leavingLiveTurn(): Promise<boolean> {
    if (!running) return false;
    const stop = await confirmDialog({
      title: "The agent is still working",
      message:
        "Leaving this chat stops the run. Anything it has already done to your repository stays done.",
      confirmLabel: "Stop and leave",
      danger: true,
    });
    if (!stop) return true;
    cancelRun?.();
    return false;
  }

  async function newChat(): Promise<void> {
    // A gated Assistant has no chats. This replaced the "Connect a model" panel
    // with an empty-state that invites you to type into a composer that cannot
    // be typed into — the one explanation of why nothing works, deleted by a
    // menu item that was never disabled.
    if (gated) return;
    if (await leavingLiveTurn()) return;
    try {
      const chat = await host.invoke("ai:chatNew", undefined);
      currentChatId = chat?.id;
    } catch {
      currentChatId = undefined;
    }
    setChatTitle("");
    showEmpty();
  }

  async function openHistory(): Promise<void> {
    let chats: { id: string; title: string; updatedAt: number }[] = [];
    try {
      chats = await host.invoke("ai:chatList", undefined);
    } catch {
      chats = [];
    }
    const items: MenuItem[] = [{ label: "New chat", icon: "add", onClick: () => void newChat() }];
    if (chats.length) items.push({ separator: true });
    for (const c of chats) {
      items.push({
        label: c.title || "Untitled chat",
        sub: relTimeISO(new Date(c.updatedAt).toISOString()),
        current: c.id === currentChatId,
        onClick: () => void switchChat(c.id),
      });
    }
    if (currentChatId) {
      items.push({ separator: true });
      items.push({ label: "Delete this chat", icon: "trash", danger: true, onClick: () => void deleteChat() });
    }
    openMenu(histBtn, items);
  }

  /** The main process titles a chat from its first message; pick that up once
   *  a turn has landed, so the header stops reading "Assistant" alone. */
  async function refreshTitle(): Promise<void> {
    if (!currentChatId) return;
    const id = currentChatId;
    try {
      const chat = await host.invoke("ai:chatGet", { id });
      if (chat && currentChatId === id && chat.turns.length > 0) setChatTitle(chat.title);
    } catch {
      /* the header keeps what it had */
    }
  }

  async function deleteChat(): Promise<void> {
    if (!currentChatId || gated) return;
    if (await leavingLiveTurn()) return;
    const id = currentChatId;
    const ok = await confirmDialog({
      title: "Delete this chat?",
      message: "It leaves this repository's chat history. Nothing the agent did to your files is undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await host.invoke("ai:chatDelete", { id });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't delete the chat.", "error");
      return;
    }
    currentChatId = undefined;
    setChatTitle("");
    showEmpty();
  }

  async function switchChat(id: string): Promise<void> {
    if (gated) return;
    if (await leavingLiveTurn()) return;
    try {
      const chat = await host.invoke("ai:chatGet", { id });
      if (!chat) return;
      await host.invoke("ai:chatSetCurrent", { id });
      currentChatId = id;
      setChatTitle(chat.turns.length > 0 ? chat.title : "");
      if (chat.turns.length > 0) restoreChat(chat);
      else showEmpty();
    } catch {
      /* ignore */
    }
  }

  async function runGoal(goal: string, fromInput = true, display?: string): Promise<void> {
    if (running || gated || !goal.trim()) return;
    // CLAIMED BEFORE THE FIRST await. `running` is the only thing stopping a
    // second turn, and an await hands control back to the event loop: with the
    // flag set after it, two quick presses of Send both read `running === false`,
    // both suspended, and both went on to start a turn into the same chat.
    // CLAIMED BEFORE THE FIRST await. `running` is the only thing stopping a
    // second turn, and an await hands control back to the event loop: with the
    // flag set after it, two quick presses of Send both read `running === false`,
    // both suspended, and both went on to start a turn into the same chat.
    running = true;
    syncSend();
    // Settings decide the permission, the model and the thinking level this
    // turn runs with. A ✨ goal reaches here before the gate has read them.
    await ready;
    if (gated) {
      running = false;
      syncSend();
      return;
    }
    // Only the text this send is ACTUALLY sending. A quick-action chip supplies
    // its own goal, so clearing here threw away a draft the user was writing.
    if (fromInput) {
      input.value = "";
      autoGrow();
    }
    syncSend();
    hideEmpty();
    setBusy(send, true);

    // Ensure this conversation has a persisted chat (created lazily on first send).
    if (!currentChatId) {
      try {
        const chat = await host.invoke("ai:chatNew", undefined);
        currentChatId = chat?.id;
      } catch {
        currentChatId = undefined;
      }
    }
    if (!currentChatId) {
      addBubble(transcript, "user", display ?? goal);
      transcript.append(errorBlock("Couldn't start a chat — open a repository and connect a model."));
      running = false;
      // Through the one rule. A bare `setBusy(send, false)` left Send fully lit
      // over a composer this path has just emptied, so the button invited a
      // click that `runGoal`'s own empty-goal guard then swallowed in silence.
      syncSend();
      return;
    }

    const ac = new AbortController();
    cancelRun = () => ac.abort();
    try {
      await runAgentTurn(
        transcript,
        send,
        currentChatId,
        goal,
        {
          allowWrite: permission !== "read",
          allowDestructive: permission === "destructive",
          modelId: selectedModelId,
          thinking: thinkLevel,
        },
        ac.signal,
        display,
        () => void runGoal(goal, false, display),
      );
    } finally {
      running = false;
      cancelRun = undefined;
      // Through the one rule — never a bare `disabled = false`, which is what
      // let a finished run hand a gated composer a working-looking Send.
      syncSend();
      void refreshTitle();
    }
  }

  syncSend();
  send.addEventListener("click", () => void runGoal(input.value));
  // Enter sends; Shift+Enter breaks a line; ⌘/Ctrl+Enter still sends, for
  // hands that learnt it. An Enter that ends an IME composition is the
  // composition's, not ours.
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    if (e.shiftKey && !e.metaKey && !e.ctrlKey) return;
    e.preventDefault();
    void runGoal(input.value);
  });

  // A goal seeded from another view (✨ Explain / Review / …) starts running
  // the moment this surface is up.
  if (pendingGoal) {
    const goal = pendingGoal;
    const label = pendingLabel;
    pendingGoal = null;
    pendingLabel = undefined;
    // `runGoal` awaits `ready` itself, so this runs with the real permission,
    // model and thinking level rather than whatever the defaults happened to be.
    void runGoal(goal, false, label);
  }
};
