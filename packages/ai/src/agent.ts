// The agent loop: a provider-agnostic, tool-calling controller that lets a model
// accomplish a multi-step git task ("draft and commit my staged work as separate
// logical commits", "write release notes since the last tag", "what changed on
// this branch vs main?"). It runs entirely on the user's OWN model connection.
//
// Safety is structural: the caller passes ONLY the tools it permits (read-only by
// default), and an optional `confirm` gate is consulted before any write/
// destructive tool actually runs — the human-in-the-loop the MCP spec and the
// product both require. The loop streams structured events so the UI can show the
// reasoning, each tool call, and each result as they happen.

import type { GitTool, GitToolHost } from "./gitTools";
import type {
  ChatMessage,
  ModelTier,
  Provider,
  ToolCall,
  ToolSpec,
} from "./types";
import { AiError } from "./types";

export type AgentEvent =
  | { type: "assistant"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; text: string; isError: boolean }
  | { type: "tool_denied"; id: string; name: string }
  | { type: "status"; text: string }
  | { type: "done"; text: string; steps: number }
  | { type: "error"; text: string };

export interface AgentOptions {
  provider: Provider;
  host: GitToolHost;
  /** The tools the agent may use this run (already filtered by permission). */
  tools: GitTool[];
  /** Extra system guidance appended to the built-in agent system prompt. */
  system?: string;
  model?: ModelTier;
  /** Hard cap on model turns (default 12). */
  maxSteps?: number;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  /**
   * Gate a write/destructive tool before it runs. Return false to deny (the model
   * is told the user declined and can adapt). Read-only tools never call this.
   */
  confirm?: (tool: GitTool, args: Record<string, unknown>) => Promise<boolean> | boolean;
}

export interface AgentResult {
  text: string;
  steps: number;
  /** A flat transcript of tool calls made (for an audit/history view). */
  toolCalls: Array<{ name: string; args: Record<string, unknown>; isError: boolean }>;
  stopped: "done" | "max_steps" | "error" | "cancelled";
}

const DEFAULT_MAX_STEPS = 12;

const AGENT_SYSTEM = [
  "You are the GitStudio Assistant, an agent embedded in the GitStudio Git client.",
  "You help the user accomplish Git and development workflow tasks in their open repository by calling the provided tools.",
  "",
  "Operating rules:",
  "- Investigate before acting: read status/diffs/log with the read tools to ground every decision in the real repository state. Never assume.",
  "- Prefer the smallest set of actions that accomplishes the goal. Make focused, logical commits.",
  "- Write commit messages in the imperative mood, matching the conventions you observe in recent history.",
  "- Treat write and destructive tools with care. The user must approve them; if an approval is declined, do not retry it — adapt or stop and explain.",
  "- Never invent file contents, SHAs, or history. If a tool fails or returns nothing, say so plainly.",
  "- When the task is complete, give a short, concrete summary of exactly what you did (or what you found).",
].join("\n");

function toSpec(tool: GitTool): ToolSpec {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** Run the agent to completion (or to the step cap / cancellation). */
export async function runAgent(goal: string, opts: AgentOptions): Promise<AgentResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const emit = (e: AgentEvent) => opts.onEvent?.(e);
  const toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
  const specs = opts.tools.map(toSpec);

  const messages: ChatMessage[] = [
    { role: "system", content: opts.system ? `${AGENT_SYSTEM}\n\n${opts.system}` : AGENT_SYSTEM },
    { role: "user", content: goal },
  ];

  const transcript: AgentResult["toolCalls"] = [];
  let finalText = "";

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) {
      emit({ type: "error", text: "Cancelled." });
      return { text: finalText, steps: step, toolCalls: transcript, stopped: "cancelled" };
    }

    let result;
    try {
      result = await opts.provider.chat(messages, {
        tools: specs,
        model: opts.model ?? "deep",
        maxTokens: 2048,
        signal: opts.signal,
        systemCacheable: true,
      });
    } catch (err) {
      const text = err instanceof AiError ? err.message : "The model request failed.";
      emit({ type: "error", text });
      return { text: finalText, steps: step, toolCalls: transcript, stopped: "error" };
    }

    if (result.text.trim()) {
      finalText = result.text.trim();
      emit({ type: "assistant", text: finalText });
    }

    if (result.toolCalls.length === 0) {
      emit({ type: "done", text: finalText, steps: step + 1 });
      return { text: finalText, steps: step + 1, toolCalls: transcript, stopped: "done" };
    }

    // Record the assistant turn (text + the tool calls it requested).
    messages.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });

    for (const call of result.toolCalls) {
      const outcome = await runOneTool(call, toolsByName, opts, emit);
      transcript.push({ name: call.name, args: call.arguments, isError: outcome.isError });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: outcome.text,
      });
    }
  }

  emit({ type: "done", text: finalText || "Reached the step limit.", steps: maxSteps });
  return {
    text: finalText || "Reached the step limit before finishing.",
    steps: maxSteps,
    toolCalls: transcript,
    stopped: "max_steps",
  };
}

async function runOneTool(
  call: ToolCall,
  toolsByName: Map<string, GitTool>,
  opts: AgentOptions,
  emit: (e: AgentEvent) => void,
): Promise<{ text: string; isError: boolean }> {
  const tool = toolsByName.get(call.name);
  if (!tool) {
    const text = `Unknown tool: ${call.name}.`;
    emit({ type: "tool_result", id: call.id, name: call.name, text, isError: true });
    return { text, isError: true };
  }

  emit({ type: "tool_call", id: call.id, name: call.name, args: call.arguments });

  // Human-in-the-loop gate for anything that mutates the repo.
  if (tool.mode !== "read" && opts.confirm) {
    let approved = false;
    try {
      approved = await opts.confirm(tool, call.arguments);
    } catch {
      approved = false;
    }
    if (!approved) {
      emit({ type: "tool_denied", id: call.id, name: call.name });
      const text = "The user declined to run this action. Do not retry it; adapt or stop and explain.";
      emit({ type: "tool_result", id: call.id, name: call.name, text, isError: true });
      return { text, isError: true };
    }
  }

  try {
    const r = await tool.run(opts.host, call.arguments);
    emit({ type: "tool_result", id: call.id, name: call.name, text: r.text, isError: r.isError === true });
    return { text: r.text, isError: r.isError === true };
  } catch (err) {
    const text = `Tool ${call.name} failed: ${err instanceof Error ? err.message : String(err)}`;
    emit({ type: "tool_result", id: call.id, name: call.name, text, isError: true });
    return { text, isError: true };
  }
}
