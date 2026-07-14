// MCP prompts: reusable, parameterized workflows an agent (or a user via a
// slash-command in their client) can invoke. Each expands to a user message that
// tells the model exactly which GitStudio tools to use and in what order — so a
// connected agent does the right, grounded thing instead of improvising.

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDescriptor {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgument[];
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

interface PromptDef extends PromptDescriptor {
  build(args: Record<string, string>): PromptMessage[];
}

function user(text: string): PromptMessage {
  return { role: "user", content: { type: "text", text } };
}

const PROMPT_DEFS: readonly PromptDef[] = [
  {
    name: "commit_staged",
    title: "Commit staged changes",
    description: "Inspect the staged diff and create a well-formed commit.",
    arguments: [
      { name: "style", description: "Message style: conventional | concise | descriptive.", required: false },
    ],
    build(args) {
      const style = args.style?.trim() || "conventional";
      return [
        user(
          `Create a Git commit for the currently staged changes in this repository.\n\n` +
            `1. Call git_status to confirm what is staged.\n` +
            `2. Call git_diff with {"staged": true} to read the staged diff.\n` +
            `3. Call git_log to learn the repository's commit-message conventions.\n` +
            `4. Write a ${style} commit message (imperative mood) and call git_commit with it.\n\n` +
            `If nothing is staged, say so and stop. Do not stage files unless I ask you to.`,
        ),
      ];
    },
  },
  {
    name: "review_changes",
    title: "Review changes",
    description: "Review the working-tree or a branch's changes for bugs and risks.",
    arguments: [
      { name: "base", description: "Compare against this base ref (e.g. main) instead of the working tree.", required: false },
    ],
    build(args) {
      const base = args.base?.trim();
      const how = base
        ? `Call git_compare with {"base": "${base}"} to see what this branch adds, then git_diff with {"base": "${base}", "head": "HEAD"} to read the diff.`
        : `Call git_status, then git_diff (no args) to read the unstaged changes.`;
      return [
        user(
          `Review the changes in this repository as a senior engineer.\n\n` +
            `${how}\n\n` +
            `Report real correctness bugs, security issues, and risky changes — specific, with file references. ` +
            `Skip style nitpicks. End with a short verdict (safe to merge / needs work).`,
        ),
      ];
    },
  },
  {
    name: "release_notes",
    title: "Draft release notes",
    description: "Summarize commits since a ref into user-facing release notes.",
    arguments: [
      { name: "since", description: "The previous tag/ref to start from (e.g. v1.2.0).", required: false },
    ],
    build(args) {
      const since = args.since?.trim();
      const range = since
        ? `Call git_log with {"ref": "${since}..HEAD", "limit": 200} to list commits since ${since}.`
        : `Call git_log with {"limit": 50} to list the recent commits.`;
      return [
        user(
          `Draft user-facing release notes for this repository.\n\n` +
            `${range}\n\n` +
            `Group the commits under headings (Features, Fixes, Improvements), rewrite terse subjects into clear notes, ` +
            `and drop internal noise (merge commits, version bumps). Output Markdown.`,
        ),
      ];
    },
  },
  {
    name: "explain_branch",
    title: "Explain this branch",
    description: "Explain what the current branch changes versus a base branch.",
    arguments: [{ name: "base", description: "Base branch (default main).", required: false }],
    build(args) {
      const base = args.base?.trim() || "main";
      return [
        user(
          `Explain what the current branch changes compared to ${base}.\n\n` +
            `Call git_compare with {"base": "${base}"} for the commit + file overview, ` +
            `read key diffs with git_diff {"base": "${base}", "head": "HEAD", "path": "…"} as needed, ` +
            `then give a concise narrative a reviewer could skim before opening the PR.`,
        ),
      ];
    },
  },
];

export const PROMPTS: readonly PromptDescriptor[] = PROMPT_DEFS.map(({ name, title, description, arguments: a }) => ({
  name,
  title,
  description,
  arguments: a,
}));

export function getPrompt(name: string, args: Record<string, string>): { description: string; messages: PromptMessage[] } | undefined {
  const def = PROMPT_DEFS.find((p) => p.name === name);
  if (!def) return undefined;
  return { description: def.description, messages: def.build(args) };
}
