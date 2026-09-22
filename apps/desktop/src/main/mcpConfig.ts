// "Agent Access": everything the Settings ▸ Agent Access card needs to point an
// external agent (Claude Desktop, Cursor, VS Code/Copilot, Windsurf) at the
// bundled GitStudio MCP server. We resolve the server's entry script, build a
// ready-to-paste config snippet, detect which clients already have it, and can
// one-click merge it into a client's config — scoped to the open repo, with the
// write/destructive permission flags the user chose.

import { app } from "electron";
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpClientInfo, McpInfo, McpInstallRequest, OkResult } from "../shared/ipc";

// ── Where the server is, and what runs it ─────────────────────────────────────
//
// The server SHIPS with the app. The desktop's own esbuild bundles apps/mcp into
// one self-contained file, dist/mcp/gitstudio-mcp.js, and electron-builder
// places it outside the asar as resources/mcp/gitstudio-mcp.js — a real file,
// because an MCP client launches it with a path of its own.
//
// Before this, nothing packaged apps/mcp at all: every shipped build showed an
// Add button that could not work and told the user to "Run npm run build in
// apps/mcp", in a repository they do not have (report #16 was that message,
// filed from a shipped build).

/** The server bundle's file name, in both layouts. */
const SERVER_FILE = "gitstudio-mcp.js";

/** Everything the launch plan depends on — injectable, so both layouts are testable. */
export interface McpRuntime {
  /** `app.isPackaged`: a shipped build rather than a dev tree. */
  packaged: boolean;
  /** `process.execPath`: the app's own executable. */
  execPath: string;
  /** `process.resourcesPath`: where extraResources land in a packaged build. */
  resourcesPath: string;
  /** The directory of the main bundle (`dist/main` in both layouts). */
  mainDir: string;
  /** `app.getPath("userData")`. */
  userData: string;
  /** `$APPIMAGE`: the AppImage file a Linux AppImage build was launched from. */
  appImage?: string;
  /** `$GITSTUDIO_MCP_BIN`: an explicit server path, for development. */
  override?: string;
}

/** The running app's own runtime. */
export function currentRuntime(): McpRuntime {
  return {
    packaged: !!app?.isPackaged,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath ?? "",
    mainDir: __dirname,
    userData: app?.getPath("userData") ?? "",
    appImage: process.env.APPIMAGE || undefined,
    override: process.env.GITSTUDIO_MCP_BIN || undefined,
  };
}

/**
 * The shipped server's path for this layout — where it IS in a packaged build,
 * beside the main bundle in a dev tree — whether or not the file exists, so a
 * missing one can be named.
 */
function expectedServerPath(rt: McpRuntime): string {
  return rt.packaged
    ? join(rt.resourcesPath, "mcp", SERVER_FILE)
    : join(rt.mainDir, "..", "mcp", SERVER_FILE);
}

/** Resolve the bundled gitstudio-mcp entry across dev + packaged layouts. */
export function resolveMcpBin(rt: McpRuntime = currentRuntime()): string {
  if (rt.override && existsSync(rt.override)) {
    return rt.override;
  }
  return expectedServerPath(rt);
}

/**
 * The server path a client config should name: one that still exists after
 * this app quits.
 *
 * Everywhere but an AppImage that is the shipped file itself. An AppImage runs
 * from a per-launch mount (/tmp/.mount_*) that disappears on exit, taking the
 * resources directory with it, so the server is copied into userData — the
 * copy is refreshed whenever it differs, so an updated app updates it.
 */
function stableServerPath(rt: McpRuntime): string {
  const bin = resolveMcpBin(rt);
  if (!rt.appImage || !existsSync(bin)) {
    return bin;
  }
  const copy = join(rt.userData, "mcp", SERVER_FILE);
  try {
    const same =
      existsSync(copy) && statSync(copy).size === statSync(bin).size &&
      readFileSync(copy).equals(readFileSync(bin));
    if (!same) {
      mkdirSync(dirname(copy), { recursive: true });
      copyFileSync(bin, copy);
    }
    return copy;
  } catch {
    return bin;
  }
}

/**
 * What a client runs to start the server: the app's OWN executable as Node
 * (`ELECTRON_RUN_AS_NODE=1`), never a bare `node`.
 *
 * A desktop user need not have Node installed, and a client started from the
 * Dock — Claude Desktop is — gets a bare PATH that will not find the one they
 * do have. The runtime that ships the server is the one sure to run it. From an
 * AppImage the command is the AppImage file, for the same reason as above.
 */
export function mcpLaunch(rt: McpRuntime = currentRuntime()): {
  command: string;
  env: Record<string, string>;
} {
  return { command: rt.appImage || rt.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
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

/**
 * Reading a client's MCP config, keeping "there is no file" DISTINCT from "there
 * is a file I could not parse".
 *
 * Collapsing the two is destructive: install would fall back to `{}` and write
 * that over a config it simply failed to understand, deleting every other MCP
 * server the user had. Several of these clients accept JSONC (comments and
 * trailing commas), which `JSON.parse` rejects outright — so this is the normal
 * case, not an exotic one.
 */
type ConfigRead =
  | { kind: "missing" }
  | { kind: "parsed"; json: Record<string, unknown> }
  | { kind: "unreadable"; reason: string };

function readConfig(path: string): ConfigRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  // An empty/whitespace-only file is effectively absent, and safe to replace.
  if (text.trim().length === 0) {
    return { kind: "missing" };
  }
  try {
    const json = JSON.parse(text) as unknown;
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return { kind: "unreadable", reason: "the file is not a JSON object" };
    }
    return { kind: "parsed", json: json as Record<string, unknown> };
  } catch (err) {
    return {
      kind: "unreadable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  const r = readConfig(path);
  return r.kind === "parsed" ? r.json : undefined;
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

/**
 * Why there is no server to install, in words for whoever can act on it — or
 * undefined when there is one.
 *
 * In a dev tree the bundle is simply not built yet: a condition of the
 * checkout. In a shipped build the server is packaged with the app, so its
 * absence is a broken build — OUR defect, never "run npm run build" at a user
 * who has no repository to run it in.
 */
function missingServer(
  rt: McpRuntime,
  binPath: string,
): (OkResult & { message: string }) | undefined {
  if (binPath && existsSync(binPath)) {
    return undefined;
  }
  // Report #16 was the dev-tree sentence, filed from a shipped build — where
  // it was never a condition: the build had left the server out. So `expected`
  // belongs to the dev tree alone, and a shipped build's refusal reports.
  return rt.packaged
    ? {
        ok: false,
        message:
          "This build of GitStudio is missing its MCP server, so Agent Access can't be set up. " +
          "Reinstalling the app restores it.",
      }
    : {
        ok: false,
        expected: true,
        message: "The MCP server isn't built yet — run `node esbuild.js` in apps/desktop.",
      };
}

export function mcpInfo(repoRoot: string | undefined, rt: McpRuntime = currentRuntime()): McpInfo {
  const binPath = stableServerPath(rt);
  const { command, env } = mcpLaunch(rt);
  const args = serverArgs(binPath, repoRoot, { write: false, destructive: false });
  const snippet = JSON.stringify({ mcpServers: { gitstudio: { command, args, env } } }, null, 2);
  const clients: McpClientInfo[] = clientConfigs().map((c) => ({
    id: c.id,
    label: c.label,
    installed: isInstalled(c),
    configPath: c.path,
  }));
  const missing = missingServer(rt, binPath);
  return {
    binPath,
    command,
    args,
    env,
    configSnippet: snippet,
    clients,
    repoRoot,
    available: !missing,
    ...(missing ? { missing: missing.message } : {}),
  };
}

export function installMcp(
  repoRoot: string | undefined,
  req: McpInstallRequest,
  rt: McpRuntime = currentRuntime(),
): OkResult & { message: string } {
  const cfg = clientConfigs().find((c) => c.id === req.client);
  // An unknown client id can only come from our own list, so it stays
  // crash-reportable. A client config the user has hand-edited into something
  // that is not JSON is a state of the machine (see main/expectedError.ts).
  if (!cfg) {
    return { ok: false, message: `Unknown client: ${req.client}.` };
  }
  const binPath = stableServerPath(rt);
  const missing = missingServer(rt, binPath);
  if (missing) {
    return missing;
  }
  const { command, env } = mcpLaunch(rt);
  const entry = { command, args: serverArgs(binPath, repoRoot, req), env };
  try {
    mkdirSync(dirname(cfg.path), { recursive: true });
    const read = readConfig(cfg.path);
    if (read.kind === "unreadable") {
      // Refuse rather than overwrite. Editing by hand is a two-minute job; a
      // silently erased MCP config is not recoverable.
      return {
        ok: false,
        expected: true,
        message:
          `${cfg.label}'s config at ${cfg.path} couldn't be read as JSON ` +
          `(${read.reason}). GitStudio won't overwrite it — add the "gitstudio" ` +
          `entry under "${cfg.serversKey}" by hand, or fix the file and retry.`,
      };
    }
    const json = read.kind === "parsed" ? read.json : {};
    const servers = (json[cfg.serversKey] && typeof json[cfg.serversKey] === "object"
      ? json[cfg.serversKey]
      : {}) as Record<string, unknown>;
    servers.gitstudio = entry;
    json[cfg.serversKey] = servers;
    // Keep one backup of a file we did not create — cheap insurance against a
    // shape we round-tripped wrongly.
    if (read.kind === "parsed") {
      try {
        writeFileSync(`${cfg.path}.gitstudio-backup`, readFileSync(cfg.path, "utf8"));
      } catch {
        /* best effort — never block the install on the backup */
      }
    }
    writeFileSync(cfg.path, JSON.stringify(json, null, 2));
    const mode = req.destructive ? "read + write + destructive" : req.write ? "read + write" : "read-only";
    return { ok: true, message: `Added GitStudio (${mode}) to ${cfg.label}. Restart ${cfg.label} to pick it up.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
