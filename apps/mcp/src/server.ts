// The GitStudio MCP server core — transport-agnostic so it unit-tests by feeding
// JSON-RPC messages straight to `handle()`. It exposes the SHARED git tool
// catalog (@gitstudio/ai/gitTools) plus resources and prompts. Safety is built
// in: only read tools are exposed by default; write tools require an explicit
// opt-in, and destructive tools a second one — surfaced to the agent both by
// omitting the tools and by annotating the ones it can see.

import { selectTools, type GitTool, type GitToolHost } from "@gitstudio/ai/gitTools";
import {
  ErrorCode,
  PROTOCOL_VERSION,
  RpcError,
  SUPPORTED_VERSIONS,
  failure,
  isRequest,
  success,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from "./protocol";
import { RESOURCES, RESOURCE_TEMPLATES, readResource } from "./resources";
import { PROMPTS, getPrompt } from "./prompts";

export interface McpPermissions {
  write: boolean;
  destructive: boolean;
}

export interface McpServerOptions {
  host: GitToolHost;
  version: string;
  permissions: McpPermissions;
}

export class McpServer {
  private readonly tools: GitTool[];
  private readonly toolsByName: Map<string, GitTool>;

  constructor(private readonly opts: McpServerOptions) {
    this.tools = selectTools({ write: opts.permissions.write, destructive: opts.permissions.destructive });
    this.toolsByName = new Map(this.tools.map((t) => [t.name, t]));
  }

  /**
   * Handle one JSON-RPC message. Returns a response for requests, or `null` for
   * notifications (which get no reply). Never throws — handler errors become
   * JSON-RPC error responses.
   */
  async handle(msg: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    if (!isRequest(msg)) {
      // Notification (initialized / cancelled / …) — nothing to reply.
      return null;
    }
    try {
      const result = await this.dispatch(msg.method, msg.params ?? {});
      return success(msg.id, result);
    } catch (err) {
      if (err instanceof RpcError) {
        return failure(msg.id, err.code, err.message, err.data);
      }
      return failure(msg.id, ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.tools.map((t) => toMcpTool(t)) };
      case "tools/call":
        return this.callTool(params);
      case "resources/list":
        return { resources: RESOURCES };
      case "resources/templates/list":
        return { resourceTemplates: RESOURCE_TEMPLATES };
      case "resources/read":
        return this.readResource(params);
      case "prompts/list":
        return { prompts: PROMPTS };
      case "prompts/get":
        return this.getPrompt(params);
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
  }

  private initialize(params: Record<string, unknown>): unknown {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
    const protocolVersion = requested && SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
        logging: {},
      },
      serverInfo: { name: "gitstudio-mcp", title: "GitStudio", version: this.opts.version },
      instructions: this.instructions(),
    };
  }

  private instructions(): string {
    const p = this.opts.permissions;
    const writeNote = p.destructive
      ? "Write AND destructive tools are enabled — destructive actions (discard, reset --hard, delete-branch) permanently lose work, so confirm intent with the user first."
      : p.write
        ? "Write tools are enabled (stage/commit/branch/stash); destructive tools (discard, reset --hard, delete-branch) are disabled."
        : "This server is READ-ONLY — only inspection tools are available. Ask the user to enable writes if you need to change the repository.";
    return [
      `You are connected to GitStudio's Git tools for the repository at ${this.opts.host.repoRoot()}.`,
      "Ground every statement in real tool output — never invent SHAs, file contents, or history. Start with git_status / git_log to orient.",
      writeNote,
      "Prefer focused, logical commits and messages that match the repository's existing conventions.",
    ].join(" ");
  }

  private async callTool(params: Record<string, unknown>): Promise<unknown> {
    const name = params.name;
    if (typeof name !== "string") {
      throw new RpcError(ErrorCode.InvalidParams, "tools/call requires a string `name`.");
    }
    const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;

    const tool = this.toolsByName.get(name);
    if (!tool) {
      // Gated-off (exists but not permitted) vs genuinely unknown — guide the agent.
      const gated = selectTools({ write: true, destructive: true }).some((t) => t.name === name);
      if (gated) {
        return {
          content: [
            {
              type: "text",
              text: `The tool "${name}" exists but is disabled in this session's permission mode. Ask the user to enable write${name.match(/discard|reset|delete/) ? "/destructive" : ""} access in GitStudio's Agent Access settings.`,
            },
          ],
          isError: true,
        };
      }
      throw new RpcError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }

    const r = await tool.run(this.opts.host, args);
    const result: Record<string, unknown> = {
      content: [{ type: "text", text: r.text }],
      isError: r.isError === true,
    };
    if (r.data !== undefined && r.data !== null) {
      result.structuredContent = r.data;
    }
    return result;
  }

  private async readResource(params: Record<string, unknown>): Promise<unknown> {
    const uri = params.uri;
    if (typeof uri !== "string") {
      throw new RpcError(ErrorCode.InvalidParams, "resources/read requires a string `uri`.");
    }
    const contents = await readResource(this.opts.host, uri);
    return { contents: [contents] };
  }

  private getPrompt(params: Record<string, unknown>): unknown {
    const name = params.name;
    if (typeof name !== "string") {
      throw new RpcError(ErrorCode.InvalidParams, "prompts/get requires a string `name`.");
    }
    const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, string>;
    const prompt = getPrompt(name, args);
    if (!prompt) {
      throw new RpcError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
    }
    return prompt;
  }
}

/** Map a shared GitTool to the MCP tool shape, including safety annotations. */
function toMcpTool(tool: GitTool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.parameters,
    annotations: {
      title: tool.title,
      readOnlyHint: tool.mode === "read",
      destructiveHint: tool.mode === "destructive",
      idempotentHint: tool.idempotent === true,
      openWorldHint: false,
    },
  };
}
