/**
 * PII scrubbing for anonymous crash reports — shared by the VS Code extension
 * and the desktop app so this security-critical logic can never drift between
 * them. Pure and environment-neutral (no `node:*` imports), so it belongs in
 * this host-agnostic package and is exercised directly in test/scrub.test.ts.
 *
 * This is the last line of defense before anything leaves a user's machine.
 *
 * KNOWN RESIDUALS — shapes it does not recognise, on purpose or for now (two
 * review rounds, Nov 2026). Each would need a rule that also eats ordinary
 * words or the diagnosis:
 *   - a host with no dot and nothing around it that says it is one ("cannot
 *     reach gitbox", "GitLab at gitbox is in maintenance");
 *   - a stack frame's function name (dotted like a host); a report keeps
 *     only that and the file's own name (reportShape.ts's stackFrames);
 *   - Azure DevOps' "TF401019 … with name or identifier X";
 *   - Go / git-lfs, SOCKS and undici error wordings beyond the generic
 *     host:port shapes ("(host:port)", "reach host:port", "host:port returned");
 *   - unquoted branch names inside TRANSLATED git prose (the English forms are
 *     in scrubGitMessage), in a message of ours that wraps it.
 *
 * Less is sent for these to miss since Nov 2026: a report carries git's
 * verdict lines rather than all its output, a git command's options rather
 * than its arguments (built from facts, not the translated message), and
 * call frames without folders — reportShape.ts.
 */

/**
 * Remove anything that could identify a user or their work: private keys, home
 * dirs, absolute paths (POSIX, Windows, and UNC — with or without spaces in
 * them) INCLUDING the file/project names in the tail, remote URLs (creds AND
 * org/repo), SSH remotes, emails, IPv4 and IPv6 addresses, host names other
 * than a public service's (see PUBLIC_HOSTS), JWTs, cloud/access tokens, and
 * SHAs.
 *
 * Order matters — each step assumes the earlier ones already ran:
 *   - private-key blocks are nuked whole, before anything can partially match;
 *   - URL/remote redaction runs before the email pass (so an embedded token or
 *     an `org/repo` path is stripped before `user@host` collapses to `<email>`);
 *   - path redaction preserves a trailing `:line:col` (it stops at the first
 *     `:`) so crash stacks stay locatable without leaking file names;
 *   - JWT/AWS/SHA passes run before the generic long-token pass so they get a
 *     precise label instead of a blanket `<token>`.
 */
export function scrub(input: string): string {
  if (!input) {
    return "";
  }
  let s = clipForScrub(input, MAX_SCRUB_INPUT);
  const home = safeHome();
  if (home) {
    s = s.split(home).join("~");
  }
  s = s
    // whole private-key blocks (before any base64 body gets partially matched)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "<private-key>")
    // userinfo (https://user:token@host -> https://host), for every network
    // scheme: ssh://alice@host names a person as surely as an email does.
    .replace(NET_USERINFO, "$1")
    // path (keep scheme+host, drop org/repo/query which can identify)
    .replace(NET_PATH, "$1/<path>")
    // scp-style git remote (git@host:org/repo -> git@host:<path>), before email.
    // Each of these starts only where a run of its characters starts (the
    // lookbehind): a `\b` start let a 64k "a.a.a…" be tried from every one of
    // its positions, quadratic, seconds of a blocked extension host.
    .replace(/(?<![\w.+-])([\w.+-]+@[\w.-]+):[\w./~+-]+/g, "$1:<path>")
    // emails
    .replace(/(?<![\w.+-])[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    // …and a user@host whose host has no dot ("bob@gitbox:" — an ssh alias or
    // a machine on the LAN), or the address git makes up when none is set
    // ("bob@HAL9000.(none)"): the user is a person all the same.
    .replace(/(?<![\w.+-])[\w.+-]+@[\p{L}\p{N}_-]+(?:\.\(none\))?(?=$|[\s:'"),;\]>])/gmu, "<email>")
    // POSIX home/user paths: anonymize the user AND redact the tail (file and
    // project names), keeping any :line:col suffix (the tail stops at ':').
    //
    // The tail accepts a BACKSLASH too. `safeHome()` collapses the user's home
    // to `~` before this runs, and on Windows that home is followed by `\`, not
    // `/` — so a forward-slash-only tail left every Windows crash stack
    // reporting `~\Projects\acme-secret\src\billing.ts`: the project and file
    // names this function's contract says it removes.
    .replace(
      /(~|\/Users\/[^/\s"':]+|\/home\/[^/\s"':]+)([/\\][^\s"':]*)?/g,
      (_m, prefix: string, tail: string | undefined) => {
        const p = prefix.startsWith("/Users/")
          ? "/Users/<user>"
          : prefix.startsWith("/home/")
            ? "/home/<user>"
            : "~";
        return tail ? `${p}/<path>` : p;
      },
    )
    // A full ref names the branch, tag or remote branch: a thrown git error
    // ("git push … exited with code 1: … refs/heads/acme-billing") reaches
    // scrub() alone, not scrubGitMessage.
    .replace(/(?<![\w./-])refs\/(?:heads|remotes|tags)\/[^\s'"`),;:]+/g, "<ref>")
    // Windows drive paths and UNC paths -> redact whole (keeps :line:col),
    // spelled with either slash: git for Windows prints "D:/Work/acme/widgets"
    // and "//fileserver/share/repo".
    .replace(/\b[A-Za-z]:\\[^\s"':]+/g, "<path>")
    .replace(/\b[A-Za-z]:\/(?!\/)[^\s"':]*/g, "<path>")
    .replace(/\\\\[^\s"':]+/g, "<path>")
    .replace(/(?<![:\w/>])\/\/[^\s"'/:]+\/[^\s"':]*/g, "<path>")
    // Absolute paths outside a home that name a person's or a team's work: a
    // mounted volume, a server's checkout folder. (Not /usr, /Applications or
    // an app's own bundle: those name the program, and a stack trace needs
    // them to say which file.)
    .replace(
      /(?:(?<![\w.:/~<>-])|(?<=file:\/\/))\/(?:Volumes|mnt|media|opt|srv|data|root|workspaces?|projects|repos|code|work|src|var\/www|var\/lib|var\/opt)\/[^\s"':]*/g,
      "<path>",
    )
    // A remote with no user in front of it — "git.acme.example:team/widgets.git",
    // an ssh alias "work-gh:acme/widgets.git" — names its org and repository
    // as plainly as the scp form above does. Only where something path-shaped
    // follows the colon (a slash, or .git): "host:443" is a port, "fatal: x" a
    // sentence, "node:internal/…" and "HEAD:refs/…" are not remotes.
    .replace(HOST_PATH, (m: string, host: string) =>
      NOT_A_REMOTE.test(host) ? m : `${hostOr(host)}:<path>`,
    )
    // Env-var-rooted Windows paths (%USERPROFILE%\Projects\x) — the variable
    // name is not identifying, everything after it is.
    .replace(/(%[A-Za-z_][A-Za-z0-9_]*%)[/\\][^\s"':]*/g, "$1\\<path>")
    // A path can contain SPACES — "C:\\Users\\John Smith\\…", "\\\\FS01\\Team Share\\…",
    // "/Users/John Smith/…" — and every pattern above stops at the first one,
    // leaving the surname and the whole project path in the report. Redact what
    // trails a marker ONLY when it still contains a separator, so a genuine
    // sentence ("/Users/bob is not a repository") keeps its words.
    //
    // A run trailing a `<path>` is the REST of that path, so it folds into it
    // rather than growing a second "/<path>": "~/a b/c" became "~/<path>/<path>",
    // which the home rule then scrubbed again to "~/<path>" — not a fixed point,
    // so one crash reported by two hosts had two fingerprints.
    .replace(SPACE_RUN, spaceRun)
    // A QUOTED identifier containing a slash: 'owner/repo', "src/billing.ts",
    // 'feature/acme-migration'.
    //
    // Every rule above redacts org and repo inside a URL, which is where they
    // normally appear — and left them alone when an API simply NAMES the thing
    // it could not find. GitHub's does: "Could not resolve to a Repository with
    // the name 'acme-private/billing-pipeline'." Crash reports #14 and #17 carried a
    // private org's repo name into the maintainer tracker that way. PRIVACY.md
    // promises the org and the repo never leave the machine; until now that
    // promise only held for the URL spelling of them.
    //
    // The opening quote must not follow a word character, or the apostrophe in
    // "couldn't" opens a span that eats the rest of the sentence — the same
    // trap scrubGitMessage documents. Requiring a slash INSIDE keeps ordinary
    // quoted words ("Field 'nope' doesn't exist") readable.
    //
    // It also swallows an innocent quoted "application/json", and that is the
    // right direction to err in a function whose job is to be the last line of
    // defense: a report that loses a media type is still diagnosable, and one
    // that carries a private repository's name is not retractable.
    .replace(/(^|[\s(:=[])(['"])[^'"\s/]*\/[^'"\s]*\2/g, "$1$2<path>$2")
    .replace(/«[^»\s/]*\/[^»\s]*»/g, "«<path>»")
    .replace(/「[^」\s/]*\/[^」\s]*」/g, "「<path>」")
    .replace(/“[^”\s/]*\/[^”\s]*”/g, "“<path>”")

    // IPv4 addresses
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>")
    // Node prints a refused IPv6 connection as address and port, unbracketed
    // ("connect ECONNREFUSED fd00::1:8443"): the last group is the port.
    .replace(/(\bconnect E[A-Z_]+\b[ \t]{1,4})([0-9a-f]{0,4}(?::[0-9a-f]{0,4}){1,7}):(\d{1,5})(?![\w:])/gi, (m: string, lead: string, addr: string, port: string) =>
      addr.includes("::") ? `${lead}<ip>:${port}` : m,
    )
    // IPv6 — the full eight-group form, and the compressed form which must
    // actually contain `::`.
    //
    // Deliberately NOT "two or more colon-separated hex groups": that redacts
    // every 01:23:45 timestamp in a log, and — worse here — the `:42:5` line
    // and column this function goes out of its way to preserve so a crash stack
    // stays locatable. The compressed rule therefore requires a literal `::`
    // ahead of it, and refuses to start immediately after a word character, so
    // `billing.ts:42:5` is never a candidate in the first place.
    .replace(/\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi, "<ip>")
    .replace(
      // (Nor against a tag: "<host>::8080" is a host with a stray colon.)
      /(?<![\w:>])(?=[0-9a-f:]{0,45}::)[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:<])/gi,
      "<ip>",
    )
    // JWTs (always start with the base64 of `{"` -> eyJ)
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "<jwt>")
    // AWS access key ids
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<token>")
    // full commit shas -> short (before the generic token pass below)
    .replace(/\b[0-9a-f]{40}\b/gi, (m) => m.slice(0, 7))
    // an account's SID (before the token pass, which would take a long one)
    .replace(/\bS-1-5-21(?:-\d+){2,}\b/g, "<sid>")
    // access tokens / long hex-ish secrets
    .replace(/\b(gh[posur]_[A-Za-z0-9]{20,}|[A-Za-z0-9_-]{40,})\b/g, "<token>")
    // Who a forge names in its refusals: the account ("Permission to <path>
    // denied to bob-smith."), the organization (SAML SSO's "The `acme-org'
    // organization …"), and the file a size limit refused ("File
    // acme-q3-report.zip is 120.00 MB").
    .replace(/\b(Permission to )\S+( denied\b)/g, "$1<path>$2")
    // …and the account GitHub's API, Gitea and Azure DevOps name in theirs —
    // "<account>", not "<user>": a "<user>" followed by words is a home
    // folder with spaces to quotedPaths, which would eat the sentence.
    .replace(/\b(with the login of )[^\s.,;]+/g, "$1<account>")
    .replace(/\b(User )[\w.-]+( does not have\b)/g, "$1<account>$2")
    .replace(/\b(with name or identifier )\S+( does not exist\b)/g, "$1<repo>$2")
    .replace(/\b(denied to )[\w.-]+?(?=\.?(?:\s|$))/gm, "$1<user>")
    .replace(/\b(The [`'"])(?!<[a-z]+>)[^`'"\s]+(['"] organization\b)/g, "$1<org>$2")
    // git's "dubious ownership" names the Windows accounts, DOMAIN\user, and
    // an account's SID is as unique as its name (the well-known S-1-5-32-…
    // groups are not).
    .replace(/((?:is owned by|current user is):[ \t]*\r?\n[ \t]*)(?![ \t]|<[a-z]+>)[^\n(]*?(?= \(|[ \t]*\r?$)/gm, "$1<user>")
    .replace(/\b(File )\S+( is \d+(?:\.\d+)? [KMG]B\b)/g, "$1<file>$2");
  // Host names last: by now an address is <ip>, a user@host is <email>, and a
  // JWT's dotted segments are <jwt> — none of them can be mistaken for one.
  return quotedPaths(scrubHosts(s));
}

// ── host names ───────────────────────────────────────────────────────────────
//
// A server's name says who the user works for. Crash report #105 carried a
// company's internal proxy ("Could not resolve proxy: proxy.<office>.<company>
// .corp"), and every URL rule above kept the host on purpose — for github.com
// that is diagnosis, for git.acme.example it is the employer.
//
// So a host name is kept only when it is a PUBLIC service's: the forges and
// the few hosts git, ssh and our own features name in their errors. Every
// other one becomes <host>, which keeps the sentence (and so the dedup
// signature) the same for every user behind every proxy.
//
// Found three ways, from surest to loosest:
//   1. the authority of a URL in any network scheme;
//   2. the place a network error names one — "Could not resolve proxy: X",
//      "unable to look up X (port 9418)", "connect to host X port 22", "No
//      ED25519 host key is known for X", "in connection to X:443", … — taken
//      WHOLE, whatever it is spelled with (a single label, an underscore,
//      Unicode): a host is whatever stands where one stands;
//   3. anything else shaped like a host (dotted labels, any script) under a
//      top-level domain, outside a stack frame's function names and the
//      places a JavaScript name stands ("logger.info is not a function").
//      A TLD that is also a word or a file extension (.ai, .me, .sh, .app,
//      .local …) counts only with two dots or a hyphen: "Cursor.app" and
//      "README.md" are not hosts, "git.acme.ai" and "acme-nas.local" are.

/** Hosts that name a public service, never a person or an organisation. Exact
 *  names only: a SUBDOMAIN of one is often the organisation itself
 *  (acme.visualstudio.com, acme.ghe.com, acme.github.io). */
const PUBLIC_HOSTS = new Set([
  // forges
  "github.com", "www.github.com", "api.github.com", "ssh.github.com", "gist.github.com",
  "codeload.github.com", "uploads.github.com", "raw.githubusercontent.com",
  "objects.githubusercontent.com", "docs.github.com", "git-lfs.github.com", "lfs.github.com", "git-lfs.com",
  "release-assets.githubusercontent.com", "objects-origin.githubusercontent.com", "avatars.githubusercontent.com",
  "support.github.com", "gh.io", "www.gravatar.com", "ollama.com",
  "gitlab.com", "www.gitlab.com", "altssh.gitlab.com", "registry.gitlab.com",
  "bitbucket.org", "api.bitbucket.org", "altssh.bitbucket.org",
  "gitee.com", "codeberg.org", "gitea.com", "git.sr.ht", "sr.ht",
  "sourceforge.net", "git.code.sf.net", "huggingface.co",
  "dev.azure.com", "ssh.dev.azure.com", "vs-ssh.visualstudio.com",
  // named in git's and ssh's own messages
  "git-scm.com", "openssh.com", "www.openssh.com", "aka.ms",
  // AI providers the apps connect to
  "api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com",
  "api.groq.com", "api.deepseek.com", "api.mistral.ai", "api.x.ai", "api.together.xyz", "openrouter.ai",
  // our own
  "gitstudio.dev", "localhost",
]);

/** Top-level domains that make even ONE dot a host: the common public ones,
 *  and the private ones companies name internal hosts under. */
const HOST_TLDS = new Set([
  "com", "net", "org", "edu", "gov", "mil", "io", "co", "dev", "cloud", "tech", "biz", "xyz", "online",
  "site", "systems", "company", "office", "vpn", "network", "eu", "uk", "de", "fr", "nl", "ch", "se",
  "dk", "fi", "ie", "es", "pt", "cz", "sk", "hu", "ro", "bg", "gr", "tr", "il", "ru", "ua", "cn", "hk",
  "tw", "jp", "kr", "sg", "th", "vn", "ph", "au", "nz", "ca", "mx", "br", "ar", "cl", "za", "ae", "sa",
  "corp", "lan", "internal", "intranet", "intra", "private", "localdomain", "example", "invalid", "arpa",
  "local", "home",
]);

/** TLDs that are also words or file extensions ("Cursor.app", "logger.info",
 *  "README.md", "build.sh"): a host only with two dots or a hyphen. Every other
 *  two-letter TLD (a country's) counts with two dots too. */
const WORDISH_TLDS = new Set([
  "ai", "me", "us", "in", "it", "is", "to", "so", "no", "at", "be", "by", "do", "my", "id", "pl", "sh", "gg",
  "ly", "md", "py", "rs", "cc", "ps", "mk", "am", "as", "ad", "app", "info", "test", "int",
  "group", "global", "services", "solutions", "zone", "host", "team", "works", "studio", "digital",
]);
/** …of which these are file extensions too: a hyphen alone never makes one a
 *  host ("release-notes.md", "run-checks.sh", "libssl-3.so", "Android-Studio.app"). */
const EXT_LIKE_TLDS = new Set(["md", "sh", "py", "rs", "so", "pl", "cc", "ps", "mk", "am", "as", "app", "ad"]);
/** Reverse-DNS identifiers start with a TLD ("com.jetbrains.intellij.ce"). */
const REVERSE_DNS_ROOTS = new Set(["com", "org", "net", "io", "dev", "app", "co", "me", "edu", "gov"]);

/** File extensions: never a host, however many dots ("index.d.ts", "vue.config.js"). */
const FILE_EXTS = new Set([
  "js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx", "json", "map", "node", "lock", "yml", "yaml", "toml",
  "ini", "cfg", "conf", "log", "exe", "dll", "dylib", "asar", "bat", "cmd", "java", "kt", "swift", "cpp",
  "hpp", "php", "lua", "vue", "svelte", "xml", "svg", "png", "jpg", "jpeg", "gif", "ico", "icns", "zip",
  "gz", "tgz", "tar", "dmg", "pkg", "msi", "deb", "rpm", "wasm", "bin", "dat", "db", "sqlite", "patch",
  "diff", "orig", "rej", "bak", "tmp", "pem", "crt", "key", "pub", "gpg", "asc", "sig", "plist", "pyc",
  "class", "jar", "war", "whl", "gem", "crate", "vsix", "csv", "tsv", "pdf", "doc", "docx", "xls", "xlsx",
  "ppt", "pptx", "rtf", "mp3", "mp4", "mov", "webm", "wav", "ttf", "otf", "woff", "woff2", "txt", "html",
  "htm", "css", "scss", "less", "env", "rb", "go", "cs",
]);

/** The first name of a JavaScript expression, never a host's first label. */
const JS_ROOTS = new Set([
  "this", "self", "globalthis", "window", "document", "process", "module", "exports", "require", "console",
  "navigator", "json", "math", "object", "array", "promise", "reflect", "symbol", "intl", "electron", "vscode",
]);

/** The network schemes whose URLs name a host (never file:, vscode-…:). */
const NET_SCHEMES = String.raw`(?:https?|ssh|git|git\+ssh|ssh\+git|ftps?|wss?|socks[45]?[ah]?|smb|afp|nfs|file)`;
// Not after a word, "-", "+" or ".": "vscode-file://vscode-app/…:1:2" is not a
// file: URL, and its frame's line and column must stay.
const SCHEME_START = String.raw`(?<![\w+.-])`;
const NET_USERINFO = new RegExp(String.raw`(${SCHEME_START}${NET_SCHEMES}:\/\/)[^/\s@"']*@`, "gi");
const NET_PATH = new RegExp(String.raw`(${SCHEME_START}${NET_SCHEMES}:\/\/[^/\s"']+)\/[^\s"')]*`, "gi");
const NET_HOST = new RegExp(String.raw`(${SCHEME_START}${NET_SCHEMES}:\/\/)([\p{L}\p{N}_][^/\s"'<>@:\[\]?#]*)`, "giu");

/** A remote spelled host:path (see scrub). The path holds a slash, or ends
 *  .git — or is already a tag: "github-acme:<path>" as an older client left it. */
const HOST_PATH =
  /(?<![\p{L}\p{N}_.@/\\:<>~-])([\p{L}\p{N}_][\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_-]+)*):(?!\/\/)((?:[\p{L}\p{N}_.~+-][^\s'"`),;:/]*)?\/[^\s'"`),;]*|[^\s'"`),;:/]*\.git\b|<(?:path|ref)>)/gu;
/** Not remotes: a drive letter, an all-capitals ref (HEAD:refs/…), a scheme. */
const NOT_A_REMOTE = /^(?:[A-Za-z]|[A-Z_]+|node|file|data|blob|about|chrome|electron|vscode(?:-[a-z]+)?|webpack|internal|https?|ssh|git|mailto|refs)$/;

/** A host as an error names it: a tag a rule above left (<ip>, <email>),
 *  optionally with what follows its colon, or the whole run of characters a
 *  host could be spelled with. Split into host and rest by hostToken. */
const TOK = String.raw`(<[a-z]+>(?::[^\s'"\`(),;<>\[\]（）：]+)?|[^\s'"\`(),;<>\[\]（）：]+)`;

/** Where a network error names a host, the host following directly. */
const HOST_IN_CONTEXT = new RegExp(
  String.raw`((?:\b(?:Could not resolve (?:hostname\b|host:?|proxy:?)|unable to look up|unable to connect to|getaddrinfo E[A-Z_]+\b|connect E[A-Z_]+\b|[Hh]ost key for|host key is known for|authenticity of host '|Permanently added '|host ?name ['(]|subject name ['(]|in connection to|connect failed:|No such host is known\.?[ \t]*\(|DNS:|Host:)|无法查找|无法连接到)[ \t]*\[?)` +
    TOK,
  "g",
);
/** Where ssh and curl name a host before its port ("connect to host X port
 *  22", "Unable to negotiate with X port 22", "Disconnected from X port 22"),
 *  or before ssh's own words about it. */
const HOST_BEFORE = new RegExp(
  // (A bounded run of blanks: a lookbehind is tried at every position, and an
  // unbounded one walked back over a 16k run of spaces from each — quadratic.)
  String.raw`(?<=(?:\b(?:to|by|from|with|host|for|Connection to|Timeout, server)|<user>)[ \t]{1,8}\[?)` +
    TOK +
    String.raw`(?=\]?(?:[ \t]+port[ \t]+\d|[ \t]+closed\b|[ \t]+not responding\b|[ \t]*[（(](?:port|Port|端口)[ \t]*\d))`,
  "g",
);
/** A host:port after the words that introduce an address ("Ollama at
 *  llm-box:11434", "using proxy gitproxy:3128", "Failed connect to X:443"). */
// A lookbehind, not a group: "server at llmbox:11434" and "host gitbox:22
// via proxy gitproxy:3128" have two lead words in a row, and a consumed lead
// used up the word that introduced the next host.
const HOST_PORT_AFTER = new RegExp(
  String.raw`(?<=\b(?:to|at|via|proxy|server|host|from|by|with|on|reach)[ \t]{1,8}\[?)` + TOK,
  "g",
);
/** A dotless host:port wherever it stands as one: "(llmbox:11434)", "llmbox:1234
 *  returned 404", "Stream from llmbox:1234 failed" — the shapes the AI
 *  providers' errors take with the user's own endpoint in them. */
const BARE_HOST_PORT =
  /(?<![\p{L}\p{N}_.@/\\:<>-])([\p{L}_][\p{L}\p{N}_-]*):(\d{2,5})(?![\p{L}\p{N}_.:/-])/gu;
/** Words that stand before ":<number>" and are not hosts. */
const NOT_HOST_WORDS = new Set([
  "line", "col", "column", "row", "port", "page", "id", "code", "status", "step", "attempt", "pid", "uid",
  "gid", "errno", "exit", "signal", "offset", "index", "length", "size", "count", "version", "v", "ver",
  "build", "http", "https", "ssh", "git", "file", "node", "localhost", "error", "warning", "fatal", "hint",
  "remote", "debug", "info", "trace", "at", "in", "of", "to", "chunk", "part", "level", "depth", "timeout",
]);
/** The AI providers' sentences that START with the endpoint ("llmbox request
 *  failed (HTTP 500).", "acme.ai returned 404 — …") or name it in "Stream from
 *  X failed" (packages/ai's openaiCompat). */
const AI_HOST_FIRST =
  /^([^\s'"`(),;<>[\]]+)(?= (?:request failed \(HTTP \d|returned \d{3}\b|rejected the API key|rate limit hit|refused the request))/gm;
const AI_STREAM_FROM = /(?<=\bStream from )([^\s'"`(),;<>[\]]+)(?= failed\b)/g;
/** "Couldn't reach llmbox (ENOTFOUND)": a lowercase name — a product's is capitalised. */
const REACH_HOST = /(?<=\b(?:Couldn't|could not|Could not) reach[ \t]{1,8})(\p{Ll}[\p{L}\p{N}_-]*)(?=[ \t]+\(E[A-Z_]+\))/gu;
/** Translated git:// lookups that put the host first: "Konnte X nicht nachschlagen". */
const HOST_THEN = new RegExp(String.raw`(\bKonnte[ \t]+)` + TOK + String.raw`(?=[ \t]+nicht nachschlagen)`, "g");
/** git://'s second line, the host first: "gitbox[0: <ip>]: errno=Connection refused". */
const HOST_LINE_START = /^([^\s'"`(),;<>[\]]+)(?=\[\d+: )/gm;
/** ssh's "… user bob gitbox port 22": the user before the host. */
const USER_BEFORE_HOST = /\b(user[ \t]+)[^\s<]+(?=[ \t]+\S+[ \t]+port[ \t]+\d)/g;

/** Rule 3: dotted labels in any script ending in a letters-only TLD. */
const DOTTED_HOST =
  /(?<![\p{L}\p{N}_.@/\\-])(?:[\p{L}\p{N}_](?:[\p{L}\p{N}_-]*[\p{L}\p{N}_])?\.)+(\p{L}{2,24})(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])(\/[^\s'"`),;]*)?/gu;

const isTag = (t: string): boolean => /^<[a-z]+>$/.test(t);

/** `host` as it may leave the machine: itself when public (or already a tag), else <host>. */
function hostOr(host: string): string {
  if (!host || isTag(host)) return host;
  return PUBLIC_HOSTS.has(host.toLowerCase().replace(/\.$/, "")) ? host : "<host>";
}

/** A port is kept; anything else after the host is part of an address. */
const restOr = (rest: string): string =>
  !rest || /^:\d+$/.test(rest) || !/[\p{L}\p{N}]/u.test(rest) ? rest : ":<path>";

/** A whole token where a host stands: the host, then a port or the rest of an
 *  address, then the sentence's own trailing "." or ":" (ssh's "X: …"). */
function hostToken(token: string): string {
  let end = token.length;
  while (end > 0 && (token[end - 1] === "." || token[end - 1] === ":")) end--;
  const core = token.slice(0, end);
  // An IPv6 literal, as Node prints one with its port ("::1:11434",
  // "fd00::1:8443"): the last group is the port when what is left still
  // reads as an address. Never ":<path>".
  if (/^[0-9a-f]*::?[0-9a-f:]*$/i.test(core) && core.includes(":") && /::/.test(core)) {
    const m = /^(.*::.*?[0-9a-f]?):(\d{1,5})$/i.exec(core);
    const port = m && !m[1].endsWith(":") ? `:${m[2]}` : "";
    return "<ip>" + port + token.slice(end);
  }
  const colon = core.indexOf(":");
  const host = colon < 0 ? core : core.slice(0, colon);
  return hostOr(host) + restOr(colon < 0 ? "" : core.slice(colon)) + token.slice(end);
}

/** Is this dotted match a host, given what stands around it? */
function dottedIsHost(match: string, tld: string, after: string): boolean {
  const t = tld.toLowerCase();
  if (FILE_EXTS.has(t)) return false;
  // Where a JavaScript name stands: "x.y is not a function", "x.y(", "this.x".
  if (/^\(|^[ \t]+is[ \t]+(?:not|undefined|null)\b/.test(after)) return false;
  const first = match.slice(0, match.indexOf(".")).toLowerCase();
  if (JS_ROOTS.has(first)) return false;
  const dots = match.split(".").length - 1;
  if (dots >= 2 && REVERSE_DNS_ROOTS.has(first)) return false;
  if (dots >= 2) {
    // camelCase is never a TLD ("e.repo.getFoo"); every listed TLD and every
    // country's two letters are.
    if (!/^(?:\p{Ll}+|\p{Lu}+|\p{Lu}\p{Ll}+)$/u.test(tld)) return false;
    return HOST_TLDS.has(t) || WORDISH_TLDS.has(t) || t.length === 2;
  }
  if (HOST_TLDS.has(t)) return true;
  return WORDISH_TLDS.has(t) && !EXT_LIKE_TLDS.has(t) && match.includes("-");
}

function scrubHosts(input: string): string {
  return input
    .replace(NET_HOST, (_m, scheme: string, host: string) => scheme + hostOr(host))
    .replace(USER_BEFORE_HOST, "$1<user>")
    .replace(HOST_IN_CONTEXT, (_m, lead: string, token: string) => lead + hostToken(token))
    .replace(HOST_BEFORE, (_m, token: string) => hostToken(token))
    .replace(HOST_THEN, (_m, lead: string, token: string) => lead + hostToken(token))
    .replace(HOST_PORT_AFTER, (m: string, token: string) => {
      const host = token.slice(0, token.indexOf(":")).toLowerCase();
      // "failed at lib.ts:44" is a file and its line, not a host and its port.
      const file = host.includes(".") && FILE_EXTS.has(host.slice(host.lastIndexOf(".") + 1));
      return /^[^:]+\]?:\d{2,5}[.:]?$/.test(token) && !NOT_HOST_WORDS.has(host) && !file ? hostToken(token) : m;
    })
    .replace(REACH_HOST, (h: string) => hostOr(h))
    .replace(AI_HOST_FIRST, (_m, token: string) => hostToken(token))
    .replace(AI_STREAM_FROM, (_m, token: string) => hostToken(token))
    .replace(HOST_LINE_START, (_m, token: string) => hostToken(token))
    .replace(/^.*$/gm, (line) =>
      // A stack frame's function names are dotted too ("at s.init (…)"); its
      // file is a path, which the path rules have already taken.
      /^\s*at\s/.test(line)
        ? line
        : line
          .replace(BARE_HOST_PORT, (m: string, host: string, port: string) =>
            NOT_HOST_WORDS.has(host.toLowerCase()) ? m : `${hostOr(host)}:${port}`,
          )
          .replace(DOTTED_HOST, (m: string, tld: string, path: string | undefined, offset: number) => {
            // A host with a path after it ("gitlab.acme.example/team/widgets"):
            // the path is the org and repository, as in a URL.
            const h = path ? m.slice(0, m.length - path.length) : m;
            if (!dottedIsHost(h, tld, line.slice(offset + h.length, offset + h.length + 16))) return m;
            return hostOr(h) + (path && path !== "/" ? "/<path>" : (path ?? ""));
          }),
    );
}

/**
 * A quoted path with a space in it keeps the words after the space
 * ("'/Users/<user>/<path> Billing'"): the whole quoted span is the path. Run
 * last, over what every rule has made, so a second pass finds nothing new.
 */
function quotedPaths(s: string): string {
  return s
    // The host rules make <path>s of their own ("<host>:<path>"), after the
    // space rule ran: it runs again, so a second pass has nothing to fold.
    .replace(SPACE_RUN, spaceRun)
    .replace(/(^|[\s(:=[])(['"])[^'"\n]{0,200}?(?:<path>[ \t]|[/\\]<user>)[^'"\n]{0,200}?\2/g, "$1$2<path>$2");
}

/** What trails a path marker after a space, while it still has a separator in it. */
const SPACE_RUN = /(<user>|<path>|~)((?: [^\s"':]+)+)/g;
const spaceRun = (_m: string, tag: string, rest: string): string =>
  /[/\\]/.test(rest) ? (tag === "<path>" ? tag : `${tag}/<path>`) : `${tag}${rest}`;

/** Longest text scrubbed: the regexes above are linear, but a report keeps at
 *  most a few hundred characters of what they produce. */
export const MAX_SCRUB_INPUT = 16_000;

/**
 * The first `max` characters of `s`, cut at a whitespace when there is one in
 * the last half — so the cut never leaves half a token, half a path or half a
 * host behind, where no rule would recognise it.
 */
export function clipForScrub(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const cut = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"), head.lastIndexOf("\t"));
  return cut > max / 2 ? head.slice(0, cut) : head;
}

/**
 * The current user's home directory, read from the environment so this stays
 * `node:*`-free (works in the extension host, Electron main, and under tsx).
 */
/**
 * Scrub a GIT ERROR MESSAGE down to its error CLASS.
 *
 * `scrub()` handles absolute paths, emails, URLs, tokens and SHAs, but git
 * stderr routinely names the things PRIVACY.md promises never to send:
 *   "error: Your local changes to the following files would be overwritten by
 *    merge:\n\tsrc/billing/secret-project.ts"
 *   "fatal: a branch named 'feature/acme-migration' already exists"
 * Both the file list and the quoted ref are repo-relative, so nothing above
 * touches them. This keeps the diagnostic sentence and redacts the identifiers.
 */
export function scrubGitMessage(input: string): string {
  if (!input) {
    return "";
  }
  const named = refStatusLines(scrub(input))
      // A rebase todo line git quotes back ("error: invalid line 3: pick
      // 1a2b3c4 Add billing for Acme") carries the commit's subject, and an
      // `exec` line the user's own command; neither is git's words.
      .replace(/(\binvalid line \d+: )[^\n]*/gi, "$1<todo line>")
      .replace(/^((?:pick|reword|edit|squash|fixup|drop|p|r|e|s|f|d) [0-9a-f]{4,40})\b[^\n]*/gim, "$1 <subject>")
      .replace(/^(Executing: |warning: execution failed: |Could not execute the todo command)[^\n]*/gim, "$1<command>")
      // Names git prints bare in a few more of its refusals.
      .replace(/\b(remote )[^\s'"]+( already exists)/g, "$1<remote>$2")
      .replace(/\b(Not a valid object name:? )(?!['"<])[^\s'"]+/g, "$1<ref>")
      .replace(/\b(no such branch:? )(?!['"<])[^\s'"]+/gi, "$1<ref>")
      .replace(/\b(bad revision:? )(?!['"<])[^\s'"]+/g, "$1<ref>")
      .replace(/\b(tag )(?!['"<])[^\s'"]+( already exists)/g, "$1<ref>$2")
      .replace(/\b(No such remote:? )(?!['"<])[^\s'"]+/gi, "$1<remote>")
      .replace(/\b(key does not contain a section:? )(?!['"<])[^\s'"]+/g, "$1<key>")
      .replace(/\b(pathspec )(?!['"<])\S+( did not match\b)/g, "$1<path>$2")
      // A commit's SUBJECT, which git prints after the abbreviated sha when a
      // rebase, cherry-pick or revert stops ("could not apply 1a2b3c4... Add
      // billing for Acme", "Stopped at 1a2b3c4...  Add billing for Acme"),
      // and for each patch `git am` applies ("Applying: Add billing for
      // Acme") and the one it stops at ("Patch failed at 0001 Add billing for
      // Acme"). Commit messages are on PRIVACY.md's list of what never leaves
      // the machine, and these lines carried them through every rule below:
      // the subject is plain unquoted words. The rest of the line goes,
      // whatever it says.
      .replace(/(\b(?:could not (?:apply|revert|pick)|Stopped at) [0-9a-f]{4,40}\.\.\.)[^\n]*/gi, "$1 <subject>")
      .replace(/(\bPatch failed at \d+)[^\n]*/gi, "$1 <subject>")
      .replace(/^(Applying:)[^\n]*/gim, "$1 <subject>")
      // …and in any language: an abbreviated sha with git's "..." after it is
      // followed by that commit's subject ("Konnte 1a2b3c4... (Add Acme
      // billing) nicht anwenden", "无法应用 1a2b3c4... Add Acme billing").
      .replace(/(\b[0-9a-f]{7,40}\.\.\.)(?![0-9a-f.])[^\n]*/gi, "$1 <subject>")
      // A thrown "git <args> exited with code N" names the branches in its
      // argument list, unquoted.
      .replace(/^((?:Error: )?git [\w-]+)(?: [^\n]{0,2000}?)?( exited with code \d+| failed)(?=:|$)/gm, "$1 <args>$2")
      // The files and branches git names on its conflict and patch lines,
      // whatever they are called — "Merge conflict in AcmeBilling" has no
      // extension to be recognised by. The conflict's kind stays.
      .replace(/(\bMerge conflict in )[^\n]+/g, "$1<path>")
      .replace(/^(CONFLICT \([\w/ -]{1,40}\): )(?!Merge conflict in <path>$)[^\n]+/gm, "$1<path>")
      .replace(/^(Auto-merging |Removing |Adding as |error: unable to create file |error: patch failed: )[^\n:]+/gm, "$1<path>")
      .replace(/^(error: )[^\n:]+(: (?:does not exist in index|patch does not apply|already exists in (?:index|working directory)|does not match index))/gm, "$1<path>$2")
      // A branch or ref name git prints WITHOUT quotes, in the failures that
      // get reported most: pulling a branch the remote doesn't have, pushing
      // one with no commits or no upstream, naming one that doesn't exist, and
      // the "On branch" line of git's status. A name with a slash in it was
      // caught as a path below; "acme-billing" was not.
      .replace(/(\bcouldn't find remote ref )[^\s'"]+/gi, "$1<ref>")
      .replace(/(\bsrc refspec )[^\s'"]+/gi, "$1<ref>")
      .replace(/(\bThe current branch )[^\s'"]+(?= has no upstream)/gi, "$1<ref>")
      .replace(/(\binvalid reference: )[^\s'"]+/gi, "$1<ref>")
      .replace(/^(On branch )[^\s'"]+/gim, "$1<ref>");
  return (
    quotedValues(named)
      // Indented file lists under "the following files would be…".
      .replace(/^[ \t]+\S.*$/gm, "\t<path>")
      // Any surviving repo-relative path (a/b.ts, src/x/y).
      // (Started only where a run starts — see scrub's scp rule — so a long
      // run is tried once, not from each of its characters.)
      // "/" is in the lookbehind too, so "./././…" is not tried again after
      // every slash (quadratic). A conflict's kind ("(modify/delete)") is not
      // a path.
      .replace(/(?<![\w./-])\/?[\w.-]+(?:\/[\w.-]+)+\b/g, (m: string, offset: number, all: string) =>
        all[offset - 1] === "(" && CONFLICT_KINDS.has(m) ? m : "<path>",
      )
      // A bare filename with a known extension.
      .replace(FILE_NAME, "<file>")
      // The rules above made <path>s after scrub's space rule ran (see quotedPaths).
      .replace(SPACE_RUN, spaceRun)
      // Collapse the runs of <path> a file list turns into.
      .replace(/(?:<path>[\s,]*){2,}/g, "<path> ")
      .trim()
  );
}

/**
 * Every quoted value, in the quotes git and its translations use (and ours:
 * de, cs and pl say „…“), but git's own words (gitsOwnWords). git quotes
 * refs, branches and pathspecs; a message of ours quotes a stash's message, a
 * commit's subject, a branch. The opening ' must NOT follow a letter, or the
 * apostrophe in "couldn't" opens a bogus span and eats the rest of the
 * sentence. "ambiguous argument 'HEAD'" was the whole diagnosis of report
 * #97, and "'<ref>'" would have hidden it.
 */
export function quotedValues(s: string): string {
  const keep = (m: string, open: string, inner: string, close: string): string =>
    gitsOwnWords(inner) ? m : `${open}<ref>${close}`;
  return s
    .replace(/(^|[\s(:=[])'([^']{1,200})'/g, (m: string, pre: string, inner: string) =>
      gitsOwnWords(inner) ? m : `${pre}'<ref>'`,
    )
    .replace(/"([^"]{1,200})"/g, (m: string, inner: string) => keep(m, '"', inner, '"'))
    .replace(/«([^»\n]{1,200})»/g, (m: string, inner: string) => keep(m, "«", inner, "»"))
    .replace(/‹([^›\n]{1,200})›/g, (m: string, inner: string) => keep(m, "‹", inner, "›"))
    .replace(/「([^」\n]{1,200})」/g, (m: string, inner: string) => keep(m, "「", inner, "」"))
    .replace(/“([^”\n]{1,200})”/g, (m: string, inner: string) => keep(m, "“", inner, "”"))
    .replace(/„([^“”\n]{1,200})[“”]/g, (m: string, inner: string) => keep(m, "„", inner, "“"))
    .replace(/‚([^‘’\n]{1,200})[‘’]/g, (m: string, inner: string) => keep(m, "‚", inner, "‘"))
    .replace(/(^|[\s(:=[])‘([^’\n]{1,200})’/g, (m: string, pre: string, inner: string) =>
      gitsOwnWords(inner) ? m : `${pre}‘<ref>’`,
    );
}

/** Revisions git itself names, never a user's: HEAD, ORIG_HEAD, @{u}, HEAD~1. */
export const GIT_REVISION =
  /^(?=.)(?:HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD|AUTO_MERGE|@(?!\{))?(?:@\{(?:u|upstream|push|-?\d{1,4})\})?(?:[~^]\d{0,3}){0,4}$/;

/**
 * What git quotes that is its own, not the user's: one of its revisions, the
 * conventional remote names, an option, or a command it suggests ("use 'git
 * cherry-pick --skip'") with nothing but options after it. Kept, because
 * they are the diagnosis and name nobody.
 */
function gitsOwnWords(inner: string): boolean {
  return (
    GIT_REVISION.test(inner) ||
    inner === "origin" ||
    inner === "upstream" ||
    /^--?[a-z][a-z-]{0,30}$/.test(inner) ||
    /^git(?:-lfs)? [a-z][a-z-]{0,30}(?: --?[a-z][a-z-]{0,30}(?:=[a-z]{1,20})?){0,6}$/.test(inner)
  );
}

/** The kinds git names a conflict by: "CONFLICT (modify/delete): …". */
const CONFLICT_KINDS = new Set([
  "modify/delete", "rename/delete", "rename/rename", "rename/add", "add/add", "file/directory", "directory/file",
  "distinct/types",
]);

/** File extensions git output names files by (FILE_EXTS and the source and
 *  script ones that are also TLDs or words). */
const FILE_NAME = new RegExp(
  String.raw`(?<![\w.-])[\w.-]+\.(?:` +
    [
      ...FILE_EXTS,
      "md", "sh", "py", "rs", "c", "h", "cc", "m", "mm", "r", "pl", "pm", "sql", "scala", "clj", "ex", "exs",
      "erl", "hs", "ml", "elm", "dart", "groovy", "gradle", "tf", "hcl", "proto", "graphql", "gql", "sass",
      "styl", "ejs", "hbs", "erb", "rst", "adoc", "tex", "ipynb", "ps1", "psm1", "zsh", "bash", "fish", "so",
      "a", "o", "lib", "obj", "csproj", "sln", "pbxproj", "xcodeproj", "storyboard", "xib", "nib", "ics", "eml",
    ].join("|") +
    String.raw`)\b`,
  "gi",
);

/**
 * git's per-ref status lines, as push and fetch print them, and the banner
 * that names the remote above them:
 *
 *   To https://github.com/acme/widget.git
 *    ! [rejected]        main -> main (stale info)
 *   error: failed to push some refs to 'https://github.com/acme/widget.git'
 *
 * The " ! " line is the one that says WHY, and it is indented — so the file-list
 * rule below turned it into "\t<path>", and the <path> collapse then folded it
 * into the URL's: crash report #104 arrived as "To https://github.com/<path>
 * error: failed to push some refs to '<ref>'", the refusal gone. It is kept as
 * "! [rejected] <ref> -> <ref> (stale info)": the refs go, git's reason stays
 * when it is one of git's or a forge's fixed words (KNOWN_REF_REASONS) and is
 * "<reason>" otherwise, since a server may put a branch name in its own.
 *
 * Every other status line (" * branch main -> FETCH_HEAD", " = [up to
 * date]", "   1a2b..3c4d  main -> main") reports something that went RIGHT,
 * and the banner names only the remote; both go, so the failure is the
 * report's first line, which is what the collector groups reports by.
 */
function refStatusLines(input: string): string {
  return input
    .replace(/^(?:To|From) \S+[ \t]*(?:\r?\n|$)/gm, "")
    .replace(/^ [*+=\-tx ] (?:\[[^\]\n]+\]|[0-9a-f]{4,}\.{2,3}[0-9a-f]{4,}|branch|tag)[ \t]+\S[^\n]*(?:\n|$)/gm, "")
    .replace(/^ ! (\[[^\]\n]+\])[ \t]+([^\n]*)$/gm, (_m, summary: string, rest: string) => {
      // git's own summaries only: a hook printing " ! [ACME-123] …" names a ticket.
      const what = KNOWN_REF_SUMMARIES.has(summary) ? summary : "[<summary>]";
      const at = reasonStart(rest);
      const refs = (at < 0 ? rest : rest.slice(0, at)).includes("->") ? "<ref> -> <ref>" : "<ref>";
      if (at < 0) return `! ${what} ${refs}`;
      const why = rest.slice(at + 1, rest.trimEnd().length - 1).trim();
      // "n/a (unpacker error)" is said as its reason: "n/a" would read as a path below.
      const said = why === "n/a (unpacker error)" ? "unpacker error" : why;
      return `! ${what} ${refs} (${KNOWN_REF_REASONS.has(said) ? said : "<reason>"})`;
    });
}

/**
 * Where the reason of a status line opens: the "(" that matches its closing
 * ")", found from the end — so a ref named "feat(x)" and a reason with its own
 * parentheses ("n/a (unpacker error)") are both read right. -1 for none.
 * One pass, never a backtracking regex: the line can be anything a hook printed.
 */
function reasonStart(rest: string): number {
  const end = rest.trimEnd().length;
  if (end === 0 || rest[end - 1] !== ")") return -1;
  let depth = 0;
  for (let i = end - 1; i >= 0; i--) {
    if (rest[i] === ")") depth++;
    else if (rest[i] === "(" && --depth === 0) return i > 0 && rest[i - 1] === " " ? i : -1;
  }
  return -1;
}

/** The summaries git prints between the brackets. */
const KNOWN_REF_SUMMARIES = new Set([
  "[rejected]", "[remote rejected]", "[remote failure]", "[no match]", "[up to date]", "[new branch]",
  "[new tag]", "[new reference]", "[deleted]", "[tag update]",
]);

/** The reasons git, and the forges' hooks, give on a ref status line. */
const KNOWN_REF_REASONS = new Set([
  // git push, from the local side
  "fetch first", "non-fast-forward", "stale info", "already exists", "needs force",
  "atomic push failed", "remote ref updated since checkout", "new shallow roots not allowed",
  "remote failed to report status", "remote does not support deleting refs",
  // the receiving side (git's receive-pack, and the forges' hooks)
  "pre-receive hook declined", "update hook declined", "hook declined", "protected branch hook declined",
  "push declined due to repository rule violations", "deny updating a hidden ref", "funny refname",
  "missing necessary objects", "shallow update not allowed", "failed to update ref", "failed to lock",
  "unpacker error", "n/a (unpacker error)", "atomic push failure", "branch is currently checked out",
  "deletion of the current branch prohibited", "deletion prohibited",
  // git fetch
  "would clobber existing tag", "can't fetch into checked-out branch", "unable to update local ref",
]);

/**
 * Redact CREDENTIALS only, keeping everything else readable.
 *
 * `scrub()` is for crash reports and is deliberately merciless — it removes
 * paths, repo names and hosts, which is right when the text is leaving the
 * machine and wrong when it is the app's own git-command log. That log is a
 * surface the user is invited to read, copy and paste into a bug report, and
 * `git remote add origin https://user:ghp_…@github.com/org/repo` puts a token
 * straight into it.
 *
 * So this keeps the command legible and takes out only the secret: the
 * password half of a URL's userinfo, and any bare GitHub token.
 */
export function redactCredentials(input: string): string {
  if (!input) {
    return "";
  }
  return (
    input
      // scheme://user:secret@host -> scheme://user:***@host. The user half
      // stays: it is usually "oauth2" or "x-access-token" and knowing which
      // is the point of reading the log at all.
      .replace(
        /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@"']+):([^/\s@"']+)@/gi,
        (_m, scheme: string, user: string) => `${scheme}${user}:***@`,
      )
      // scheme://secret@host — userinfo with no colon is itself the token.
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@"']+)@/gi, "$1***@")
      // Bare GitHub tokens, wherever they appear (argv, stderr, a header echo).
      .replace(/\bgh[posur]_[A-Za-z0-9]{16,}/g, "<token>")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<token>")
  );
}

export function safeHome(): string {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.HOME || proc?.env?.USERPROFILE || "";
}

export function scrubExtra(extra?: Record<string, string>): Record<string, string> {
  if (!extra) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) {
    out[safeShort(k, 40)] = scrub(String(v)).slice(0, 200);
  }
  return out;
}

export function safeShort(s: string, n: number): string {
  return (s || "").replace(/[\r\n]+/g, " ").slice(0, n);
}

export function randomId(): string {
  // A random, non-identifying install id (rotatable by clearing local state).
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
