// Shell integration — the mechanism behind the terminal's command "blocks".
//
// We inject a small startup script into the spawned shell so it emits standard
// OSC escape sequences (FinalTerm/iTerm2 `OSC 133` + VS Code's `OSC 633`)
// around each command. The renderer parses those to know where every command
// starts/ends, its exit code, and the cwd — which is what lets it draw per-
// command status, navigation, and copy/rerun affordances. This is the same open
// contract VS Code, iTerm2, and WezTerm use; no third-party code is reused.
//
// Design goals:
//  • Never break the user's shell. We source their normal rc files first, then
//    install hooks additively. Unknown shells (fish, powershell, sh, …) and the
//    GITSTUDIO_DISABLE_SHELL_INTEGRATION escape hatch fall back to a plain spawn.
//  • No native deps and no IPC surface change: everything is computed here and
//    folded into the PTY spawn (file/args/env).

import { app } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** What the bridge needs to spawn an integrated shell. `null` ⇒ spawn plainly. */
export interface ShellSpawn {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

// NOTE: these are SHELL scripts embedded as JS strings. To keep the shell's own
// `${VAR}` expansions and `\033`/`\007` escapes intact we use plain template
// literals with shell `${` written as `\${` (so JS does not interpolate) and the
// OSC escapes written as `\\033`/`\\007` (so the file gets a literal backslash).

/** bash: loaded via `--init-file`. Sources the user's bashrc, then hooks. */
const BASH_SCRIPT = `# GitStudio shell integration (bash) — emits OSC 133/633 for command blocks.
# Loaded via 'bash --init-file'; sources the user's interactive config first.
if [ -r /etc/bash.bashrc ]; then . /etc/bash.bashrc; fi
if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi

if [[ "$-" == *i* && -z "$GITSTUDIO_SI_INSTALLED" ]]; then
  GITSTUDIO_SI_INSTALLED=1
  __gitstudio_osc() { printf '\\033]%s\\007' "$1"; }
  __gitstudio_preexec_done=""
  __gitstudio_preexec() {
    [ -n "$COMP_LINE" ] && return
    [ -n "$__gitstudio_preexec_done" ] && return
    case "$BASH_COMMAND" in __gitstudio_precmd*) return;; esac
    __gitstudio_preexec_done=1
    __gitstudio_osc "633;E;$BASH_COMMAND"
    __gitstudio_osc "133;C"
  }
  __gitstudio_precmd() {
    local code="$?"
    __gitstudio_osc "133;D;$code"
    __gitstudio_osc "133;A"
    __gitstudio_osc "633;P;Cwd=$PWD"
    __gitstudio_preexec_done=""
  }
  case ";$PROMPT_COMMAND;" in
    *";__gitstudio_precmd;"*) ;;
    *) PROMPT_COMMAND="__gitstudio_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac
  trap '__gitstudio_preexec' DEBUG
fi
`;

/** zsh `.zshrc`: source the user's zshrc, then install add-zsh-hook hooks. */
const ZSH_ZSHRC = `# GitStudio shell integration (zsh) — emits OSC 133/633 for command blocks.
if [[ -n "\${USER_ZDOTDIR:-}" && -r "\${USER_ZDOTDIR}/.zshrc" ]]; then
  GITSTUDIO_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$USER_ZDOTDIR
  . "\${USER_ZDOTDIR}/.zshrc"
  ZDOTDIR=$GITSTUDIO_ZDOTDIR
fi

if [[ -o interactive && -z "\${GITSTUDIO_SI_INSTALLED:-}" ]]; then
  GITSTUDIO_SI_INSTALLED=1
  autoload -Uz add-zsh-hook
  __gitstudio_osc() { printf '\\033]%s\\007' "$1"; }
  __gitstudio_preexec() {
    __gitstudio_osc "633;E;$1"
    __gitstudio_osc "133;C"
  }
  __gitstudio_precmd() {
    local code=$?
    __gitstudio_osc "133;D;$code"
    __gitstudio_osc "133;A"
    __gitstudio_osc "633;P;Cwd=$PWD"
  }
  add-zsh-hook preexec __gitstudio_preexec
  add-zsh-hook precmd __gitstudio_precmd
fi
`;

/** zsh dotfiles that chain to the user's config so nothing is lost. */
function zshChain(file: string): string {
  return `# GitStudio zsh integration — chain to the user's ${file}, keep our ZDOTDIR.
if [[ -n "\${USER_ZDOTDIR:-}" && -r "\${USER_ZDOTDIR}/${file}" ]]; then
  GITSTUDIO_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$USER_ZDOTDIR
  . "\${USER_ZDOTDIR}/${file}"
  ZDOTDIR=$GITSTUDIO_ZDOTDIR
fi
`;
}

let cachedDir: string | undefined;

/** Write the integration scripts once per launch; return their directory. */
function ensureScripts(): string {
  if (cachedDir) return cachedDir;
  const dir = join(app.getPath("userData"), "shell-integration");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "gitstudio-bash.sh"), BASH_SCRIPT, "utf8");
    writeFileSync(join(dir, ".zshrc"), ZSH_ZSHRC, "utf8");
    writeFileSync(join(dir, ".zshenv"), zshChain(".zshenv"), "utf8");
    writeFileSync(join(dir, ".zprofile"), zshChain(".zprofile"), "utf8");
    writeFileSync(join(dir, ".zlogin"), zshChain(".zlogin"), "utf8");
  } catch {
    return ""; // disk trouble ⇒ caller falls back to a plain spawn
  }
  cachedDir = dir;
  return dir;
}

/**
 * Build the spawn config for a shell with command-block integration enabled, or
 * `null` to spawn it plainly (unknown shell, opt-out, or script-write failure).
 */
export function buildShellSpawn(
  shell: string,
  baseEnv: NodeJS.ProcessEnv,
): ShellSpawn | null {
  if (process.env.GITSTUDIO_DISABLE_SHELL_INTEGRATION) return null;
  if (process.platform === "win32") return null; // pwsh/cmd: a later phase

  const name = basename(shell).toLowerCase();
  const dir = ensureScripts();
  if (!dir) return null;

  if (name === "zsh") {
    return {
      file: shell,
      args: ["-i"],
      env: {
        ...baseEnv,
        ZDOTDIR: dir,
        USER_ZDOTDIR: process.env.ZDOTDIR || homedir(),
        GITSTUDIO_SHELL_INTEGRATION: "1",
      },
    };
  }
  if (name === "bash") {
    return {
      file: shell,
      args: ["--init-file", join(dir, "gitstudio-bash.sh"), "-i"],
      env: { ...baseEnv, GITSTUDIO_SHELL_INTEGRATION: "1" },
    };
  }
  return null;
}
