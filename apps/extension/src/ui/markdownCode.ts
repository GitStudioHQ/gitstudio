// Code spans for the MarkdownStrings our tooltips build.
//
// Inside a code span CommonMark renders backslash escapes LITERALLY: the path
// `my\-app\.worktrees` used to show every backslash in the hover. So the text
// goes in as it is, fenced by one backtick more than its longest run of them.

/** `text` as a CommonMark code span, shown exactly as written. */
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  // A span that starts or ends with a backtick needs a space against the
  // fence — and a space on both ends of the content is stripped once, so a
  // text that already has both gets one more to lose instead.
  const pad =
    text.startsWith("`") || text.endsWith("`") || (/^ .*[^ ].* $/s.test(text)) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}
