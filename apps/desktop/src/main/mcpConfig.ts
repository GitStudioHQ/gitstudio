// "Agent Access": everything the Settings ▸ Agent Access card needs to point an
// external agent (Claude Desktop, Cursor, VS Code/Copilot, Windsurf) at the
// bundled GitStudio MCP server. We resolve the server's entry script, build a
// ready-to-paste config snippet, detect which clients already have it, and can
// one-click merge it into a client's config — scoped to the open repo, with the
// write/destructive permission flags the user chose.

import { app } from "electron";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpClientInfo, McpInfo, McpInstallRequest } from "../shared/ipc";

/** Resolve the bundled gitstudio-mcp entry across dev + packaged layouts. */
export function resolveMcpBin(): string {
  const env = process.env.GITSTUDIO_MCP_BIN;
  const candidates = [
    env,
    // Dev: apps/desktop/dist/main/main.js → apps/mcp/dist/index.js
    join(__dirname, "..", "..", "..", "mcp", "dist", "index.js"),
    // Packaged (asar-unpacked or resources): resources/mcp/dist/index.js
    join(process.resourcesPath ?? "", "mcp", "dist", "index.js"),
    join(app.getAppPath(), "..", "mcp", "dist", "index.js"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }
  // Fall back to the dev path even if missing, so the UI can say "build it".
  return candidates[1] ?? "";
}

interface ClientConfig {
  id: string;
  label: string;
  /** Config file path (mac/linux/win as available). */
  path: string;
  /** The JSON key the client uses for its server map. */
  serversKey: "mcpServers" | "servers";
}

/** Per-OS client config locations. mac is fully supported; others best-effort. */
function clientConfigs(): ClientConfig[] {
  const home = homedir();
  const mac = process.platform === "darwin";
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const list: ClientConfig[] = [
    {
      id: "claude",
      label: "Claude Desktop",
      path: mac
        ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : join(appData, "Claude", "claude_desktop_config.json"),
      serversKey: "mcpServers",
    },
    {
      id: "cursor",
      label: "Cursor",
      path: join(home, ".cursor", "mcp.json"),
      serversKey: "mcpServers",
    },
    {
      id: "windsurf",
      label: "Windsurf",
      path: join(home, ".codeium", "windsurf", "mcp_config.json"),
      serversKey: "mcpServers",
    },
    {
      id: "vscode",
      label: "VS Code (Copilot)",
      path: mac
        ? join(home, "Library", "Application Support", "Code", "User", "mcp.json")
        : join(appData, "Code", "User", "mcp.json"),
      serversKey: "servers",
    },
  ];
  return list;
}

/** Build the args a client should launch the server with. */
function serverArgs(binPath: string, repoRoot: string | undefined, req: { write: boolean; destructive: boolean }): string[] {
  const args = [binPath];
  if (repoRoot) {
    args.push("--repo", repoRoot);
  }
  if (req.destructive) {
    args.push("--allow-destructive");
  } else if (req.write) {
    args.push("--write");
  }
  return args;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Is GitStudio's server already present in a client's config? */
function isInstalled(cfg: ClientConfig): boolean {
  const json = readJson(cfg.path);
  if (!json) {
    return false;
  }
  const servers = json[cfg.serversKey];
  return !!servers && typeof servers === "object" && "gitstudio" in (servers as Record<string, unknown>);
}

export function mcpInfo(repoRoot: string | undefined): McpInfo {
  const binPath = resolveMcpBin();
  const args = serverArgs(binPath, repoRoot, { write: false, destructive: false });
  const snippet = JSON.stringify(
    { mcpServers: { gitstudio: { command: "node", args } } },
    null,
    2,
  );
  const clients: McpClientInfo[] = clientConfigs().map((c) => ({
    id: c.id,
    label: c.label,
    installed: isInstalled(c),
    configPath: c.path,
  }));
  return {
    binPath,
    command: "node",
    args,
    configSnippet: snippet,
    clients,
    repoRoot,
    available: !!binPath && existsSync(binPath),
  };
}

export function installMcp(
  repoRoot: string | undefined,
  req: McpInstallRequest,
): { ok: boolean; message: string } {
  const cfg = clientConfigs().find((c) => c.id === req.client);
  if (!cfg) {
    return { ok: false, message: `Unknown client: ${req.client}.` };
  }
  const binPath = resolveMcpBin();
  if (!binPath || !existsSync(binPath)) {
    return { ok: false, message: "The MCP server isn't built yet (apps/mcp/dist/index.js)." };
  }
  const entry = { command: "node", args: serverArgs(binPath, repoRoot, req) };
  try {
    mkdirSync(dirname(cfg.path), { recursive: true });
    const json = readJson(cfg.path) ?? {};
    const servers = (json[cfg.serversKey] && typeof json[cfg.serversKey] === "object"
      ? json[cfg.serversKey]
      : {}) as Record<string, unknown>;
    servers.gitstudio = entry;
    json[cfg.serversKey] = servers;
    writeFileSync(cfg.path, JSON.stringify(json, null, 2));
    const mode = req.destructive ? "read + write + destructive" : req.write ? "read + write" : "read-only";
    return { ok: true, message: `Added GitStudio (${mode}) to ${cfg.label}. Restart ${cfg.label} to pick it up.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
