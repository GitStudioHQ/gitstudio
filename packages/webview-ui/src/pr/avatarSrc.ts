// An avatar's src for the Pull Requests surfaces (list, page, create): the one
// place a URL from the host's state becomes an <img src>. The state is posted
// into the webview, so everything in it — a person's avatarUrl included — is
// treated as untrusted.
//
// Checking the URL and then handing the SAME string on is not enough: the
// value that reaches src must be one this function wrote. So an allowed URL is
// REBUILT — a fixed origin (or a fixed data: header) written here, followed by
// the parsed path, query and payload, each percent-encoded again — and nothing
// the host sent can decide the scheme or the host of what loads.

/** GitHub's avatar host, the only network origin an avatar loads from. */
const AVATAR_ORIGIN = "https://avatars.githubusercontent.com/";

/** The inline image kinds an avatar may be, each with the header written here. */
const DATA_HEADERS: ReadonlyMap<string, string> = new Map([
  ["png", "data:image/png"],
  ["jpeg", "data:image/jpeg"],
  ["gif", "data:image/gif"],
  ["webp", "data:image/webp"],
  ["svg+xml", "data:image/svg+xml"],
]);

/** The parameters a data: image may carry between its type and its comma. */
const DATA_PARAMS: ReadonlyMap<string, string> = new Map([
  ["utf8", ";utf8"],
  ["charset=utf-8", ";charset=utf-8"],
  ["base64", ";base64"],
]);

/**
 * Decode, then encode again: a part that was already percent-encoded comes
 * out unchanged, and one that was not comes out encoded. Throws on a broken
 * %-sequence, which the caller treats as "not an avatar".
 */
function reencode(part: string): string {
  return encodeURIComponent(decodeURIComponent(part));
}

/** An avatar's src: GitHub's avatar host over https, or an inline image — nothing else loads. */
export function avatarSrc(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    if (url.startsWith("data:")) return dataImage(url);
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "avatars.githubusercontent.com" || u.port || u.username || u.password) return undefined;
    const path = u.pathname.slice(1).split("/").map(reencode).join("/");
    // The query rebuilt pair by pair (?u=1&v=4, ?s=40): the same words, in the
    // same order, written by encodeURIComponent.
    const query = [...u.searchParams].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    return AVATAR_ORIGIN + path + (query ? `?${query}` : "");
  } catch {
    return undefined;
  }
}

/** `data:image/<kind>[;param],<payload>` with a known kind and param, rebuilt; anything else is undefined. */
function dataImage(url: string): string | undefined {
  const comma = url.indexOf(",");
  if (comma < 0) return undefined;
  const [type, ...params] = url.slice("data:".length, comma).split(";");
  const kind = /^image\/(.+)$/.exec(type ?? "")?.[1];
  const header = kind === undefined ? undefined : DATA_HEADERS.get(kind);
  if (header === undefined || params.length > 1) return undefined;
  const param = params[0];
  let written = "";
  if (param !== undefined) {
    const known = DATA_PARAMS.get(param.toLowerCase());
    if (known === undefined) return undefined;
    written = known;
  }
  // A data: URL's payload is percent-decoded before it is read (base64
  // included), so encoding it again changes the bytes it names not at all.
  return `${header}${written},${reencode(url.slice(comma + 1))}`;
}
