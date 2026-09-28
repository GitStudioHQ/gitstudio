// Support GitStudio… — the one question behind the command, asked in
// GitStudio's own pick dialog (never VS Code's quick input), and the two
// addresses its answers open.
//
// Where it is offered, and nowhere else: the command palette, the bottom of
// the Changes view's "…" menu, and one line at the end of the walkthrough.
// Nothing opens it by itself — no toast, no timer, no count.
//
// vscode-free (the dialog types are type-only), so the words, the addresses
// and what an answer opens are unit-tested.

import type { DialogChoice } from "./dialogs";

/** GitHub Sponsors: recurring support. The manifest's `sponsor` field is the same page. */
export const SPONSOR_URL = "https://github.com/sponsors/antonarnaudov";

/** Buy me a coffee: a one-off tip, through Revolut. */
export const COFFEE_URL = "https://checkout.revolut.com/pay/7a6070ab-99ba-4170-a125-c5911b1a5c1d";

/** What promptPick is asked. */
export interface SupportPickSpec {
  title: string;
  message: string;
  choices: DialogChoice[];
  filter: false;
}

/** The question: the two ways, in the README's words, with the codicons the dialog draws. */
export function supportPickSpec(): SupportPickSpec {
  return {
    title: "Support GitStudio",
    message: "GitStudio is free and open source. If it saves you time, you can support it.",
    choices: [
      { id: "sponsor", label: "Sponsor on GitHub", icon: "heart", description: "Recurring support" },
      { id: "coffee", label: "Buy me a coffee", icon: "coffee", description: "A one-off tip" },
    ],
    // Two rows: a filter box would only be in the way.
    filter: false,
  };
}

/** The page an answer opens; undefined when the dialog was dismissed. */
export function supportUrl(answer: string | undefined): string | undefined {
  if (answer === "sponsor") return SPONSOR_URL;
  if (answer === "coffee") return COFFEE_URL;
  return undefined;
}

/** Ask which way, then open that page in the browser. A dismissed dialog opens nothing. */
export async function askAndOpenSupport(
  pick: (spec: SupportPickSpec) => PromiseLike<string | undefined>,
  /** vscode.env.openExternal, in the extension (a Thenable). */
  open: (url: string) => unknown,
): Promise<void> {
  const url = supportUrl(await pick(supportPickSpec()));
  if (url) {
    await open(url);
  }
}
