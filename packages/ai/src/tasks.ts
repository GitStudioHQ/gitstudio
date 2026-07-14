// The high-level, one-shot AI tasks GitStudio surfaces inline (the ✨ buttons):
// commit messages, diff explanations, change summaries, PR descriptions, code
// review, conflict help, release notes, and branch-name suggestions. These wrap a
// Provider with carefully-built prompts; the commit/explain/summarize/PR prompts
// reuse the engine's stable, cacheable builders (shared with the VS Code
// extension) so behavior stays consistent across hosts. The rest are defined here.
//
// Every task degrades gracefully: a thrown AiError carries a user-friendly
// message, and the diff is always truncated to a safe token budget first.

import {
  buildCommitPrompt,
  buildCommitStyleSystem,
  buildExplainPrompt,
  buildPrDescriptionPrompt,
  buildSummarizePrompt,
  truncateDiff,
  type CommitStyle,
} from "@gitstudio/engine/ai/gitBrainCore";
import type { ChatMessage, ModelTier, Provider } from "./types";

export type { CommitStyle };

export interface TaskContext {
  signal?: AbortSignal;
  /** Optional streaming sink for tasks that render Markdown progressively. */
  onDelta?: (text: string) => void;
}

function userMsg(content: string): ChatMessage {
  return { role: "user", content };
}
function sysMsg(content: string): ChatMessage {
  return { role: "system", content };
}

/** Run a one-shot text task, streaming when a sink is given and the model allows. */
async function oneShot(
  provider: Provider,
  messages: ChatMessage[],
  opts: { model: ModelTier; maxTokens: number; ctx?: TaskContext; systemCacheable?: boolean },
): Promise<string | null> {
  const chatOpts = {
    model: opts.model,
    maxTokens: opts.maxTokens,
    signal: opts.ctx?.signal,
    systemCacheable: opts.systemCacheable,
  };
  if (opts.ctx?.onDelta) {
    return provider.streamText(messages, opts.ctx.onDelta, chatOpts);
  }
  const r = await provider.chat(messages, chatOpts);
  const t = r.text.trim();
  return t.length > 0 ? t : null;
}

export interface CommitMessageOptions {
  style?: CommitStyle;
  recentSubjects?: readonly string[];
  ctx?: TaskContext;
}

/** Draft a commit message from a staged diff. */
export function generateCommitMessage(
  provider: Provider,
  diff: string,
  opts: CommitMessageOptions = {},
): Promise<string | null> {
  const system = buildCommitStyleSystem(opts.recentSubjects ?? [], opts.style ?? "conventional");
  return oneShot(provider, [sysMsg(system), userMsg(buildCommitPrompt(truncateDiff(diff)))], {
    model: "fast",
    maxTokens: 512,
    ctx: opts.ctx,
    systemCacheable: true,
  });
}

/** Explain a diff for a reviewer (Markdown). */
export function explainDiff(provider: Provider, diff: string, ctx?: TaskContext): Promise<string | null> {
  return oneShot(provider, [userMsg(buildExplainPrompt(truncateDiff(diff, 8000)))], {
    model: "mid",
    maxTokens: 1024,
    ctx,
  });
}

/** Summarize a set of changes as skimmable bullets (Markdown). */
export function summarizeChanges(provider: Provider, diff: string, ctx?: TaskContext): Promise<string | null> {
  return oneShot(provider, [userMsg(buildSummarizePrompt(truncateDiff(diff, 8000)))], {
    model: "mid",
    maxTokens: 1024,
    ctx,
  });
}

/** Draft a PR title + description from the branch's commits and combined diff. */
export function generatePrDescription(
  provider: Provider,
  commits: readonly string[],
  diff: string,
  ctx?: TaskContext,
): Promise<string | null> {
  return oneShot(provider, [userMsg(buildPrDescriptionPrompt(commits, truncateDiff(diff, 8000)))], {
    model: "mid",
    maxTokens: 1200,
    ctx,
  });
}

/** Review a diff and flag bugs, risks, and concerns (Markdown). */
export function reviewDiff(provider: Provider, diff: string, ctx?: TaskContext): Promise<string | null> {
  const prompt =
    "You are a senior engineer reviewing the following diff before it merges. " +
    "Identify real correctness bugs, security issues, and risky changes. Be specific and cite the file. " +
    "Skip nitpicks and style unless they cause bugs. If the change looks safe, say so briefly. " +
    "Format as Markdown: a one-line verdict, then a short bulleted list of findings (most important first). " +
    "Each finding: the file, the concern, and a concrete suggestion.\n\n```diff\n" +
    truncateDiff(diff, 10000) +
    "\n```";
  return oneShot(provider, [userMsg(prompt)], { model: "deep", maxTokens: 1500, ctx });
}

/**
 * Explain a merge conflict and suggest a resolution. `path` names the file; the
 * three sides (base/ours/theirs) are passed verbatim so the model can reason
 * about intent rather than guess from markers.
 */
export function explainConflict(
  provider: Provider,
  conflict: { path: string; base?: string; ours: string; theirs: string },
  ctx?: TaskContext,
): Promise<string | null> {
  const cap = (s: string | undefined) => truncateDiff(s ?? "", 2500);
  const prompt =
    `A merge conflict is open in \`${conflict.path}\`. Explain what each side changed and why they conflict, ` +
    "then recommend how to resolve it (which side to take, or how to combine them). Keep it tight and practical. Use Markdown.\n\n" +
    (conflict.base ? "BASE (common ancestor):\n```\n" + cap(conflict.base) + "\n```\n\n" : "") +
    "OURS (current branch):\n```\n" + cap(conflict.ours) + "\n```\n\n" +
    "THEIRS (incoming):\n```\n" + cap(conflict.theirs) + "\n```";
  return oneShot(provider, [userMsg(prompt)], { model: "deep", maxTokens: 1200, ctx });
}

/** Generate release notes / a changelog from a list of commit subjects (Markdown). */
export function generateChangelog(
  provider: Provider,
  commits: readonly string[],
  opts: { version?: string; ctx?: TaskContext } = {},
): Promise<string | null> {
  const list = commits.map((c) => `- ${c}`).join("\n");
  const heading = opts.version ? ` for ${opts.version}` : "";
  const prompt =
    `Write user-facing release notes${heading} from these commit subjects. ` +
    "Group them under headings (Features, Fixes, Improvements, etc.), rewrite terse subjects into clear notes, " +
    "and drop purely internal noise (merge commits, version bumps). Use Markdown.\n\n" +
    `Commits:\n${list}`;
  return oneShot(provider, [userMsg(prompt)], { model: "mid", maxTokens: 1200, ctx: opts.ctx });
}

/** Suggest a few branch names for a task description (plain, one per line). */
export function suggestBranchNames(
  provider: Provider,
  description: string,
  ctx?: TaskContext,
): Promise<string | null> {
  const prompt =
    "Suggest 3 concise, kebab-case git branch names for this task. " +
    "Use a conventional prefix (feat/, fix/, chore/, docs/) when it fits. " +
    "Output ONLY the names, one per line, no numbering, no prose.\n\n" +
    `Task: ${description}`;
  return oneShot(provider, [userMsg(prompt)], { model: "fast", maxTokens: 120, ctx });
}

/**
 * A general-purpose inline assist: the caller hands a fully-formed prompt (e.g.
 * "Analyze this issue…", "Draft a reply…", with the context embedded) and gets a
 * Markdown answer. Powers the ✨ affordances that aren't diff-shaped (issue
 * analysis, comment drafting).
 */
export function assist(provider: Provider, prompt: string, ctx?: TaskContext): Promise<string | null> {
  return oneShot(provider, [userMsg(prompt)], { model: "mid", maxTokens: 1400, ctx });
}
