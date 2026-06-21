---
title: "I just wanted to publish an extension. Microsoft said my name was 'suspicious.'"
description: How a finished VS Code extension turned into a multi-day fight with publisher registration — and everything I learned getting it onto both marketplaces.
date: 2026-06-21
tags: [vscode, extensions, open-vsx, marketplace, devtools]
---

# I just wanted to publish an extension. Microsoft said my name was "suspicious."

I had a finished extension. **Merge Studio** — a JetBrains-style three-pane merge editor for VS Code and Cursor, fully built, tested, polished, with a walkthrough and screenshots. The last step was supposed to be the easy one: publish it.

It took days. Not because of the code. Because of a content filter that decided my name was a threat.

Here's the whole story, and the clean guide I wish I'd had. If you just want the steps, [skip to the guide](#the-guide) — but the story is where the *non-obvious* lessons live.

## The wall

To publish to the VS Code Marketplace you first create a **publisher** at `marketplace.visualstudio.com/manage`. I filled in the form — ID `antonarnaudov`, display name "Anton Arnaudov" — and hit create.

> **Publisher Metadata has suspicious content.**

No detail. No "which field." Just suspicious.

I assumed I'd typed something weird. I hadn't. So I did what everyone does: I varied things. Different display names — short, long, one word, two words, different casing. Different browsers, including Edge. Incognito. A VPN routed through the US. **Every single attempt: same error.**

Then I did the thing you're not supposed to have to do. I made a *brand new Microsoft account*. New email, new Azure account, new Azure DevOps org. I even entered credit-card details for "pay-as-you-go" (yes — publishing a free extension now nudges you toward handing Microsoft a card). New account, new everything.

**Same. Error.**

## Support, such as it was

I emailed. The reply:

> "After review, we are unable to approve it, as the publisher's content does not align with the VS Marketplace policy."

I asked which policy, which field, what content. The reply:

> "We are unable to provide further details, as disclosing specifics could compromise our monitoring mechanisms."

So: rejected by a black box, for reasons they won't share, that follow me across accounts. I found the GitHub issue tracker for the Marketplace and — of course — other people, with totally different plain-text names, hitting the identical wall the same week. Every report closed with the same copy-pasted "please email support."

I was ready to conclude the whole system was broken.

## The one test that cracked it

It wasn't broken. It was doing something dumb but *specific*.

The key realization: the rejection followed my **name**, not my account. Two different blocked people, me (`antonarnaudov`) and someone else (`antoniofontes`), had one thing in common — both contain the substring `anton`. A two-data-point coincidence, but cheap to test.

So I tried creating a publisher with a name that had **nothing to do with me** — `diffpane-tools`. Neutral, brand-like, no "anton" anywhere.

**It went through instantly.**

That was the whole bug. The Marketplace's content filter was choking on a *string in my name* and dressing it up as a "policy" decision. Not my account. Not my extension — which it had never even seen, because you hit this wall *before* you ever upload anything. Just... the letters of my name.

**Lesson 1: your publisher should be a brand, not your name.** Not for vanity — because the name filter is a landmine and a brand name walks around it.

## Turning a bug into a better decision

Being forced off my own name turned out to be the best thing that happened to the project.

I'd been about to publish under `antonarnaudov`. Instead I stepped back and asked what the *brand* should be. The answer: **GitStudio** — Merge Studio is just the first of a family of Git tools I want to build. So I created a `gitstudio` publisher (sailed through the filter), and Merge Studio shipped as `gitstudio.merge-studio`.

This surfaced **Lesson 2: the publisher is your brand/umbrella; the extension is the product.** They're different things. Most big suites do this — GitLens ships under an org publisher, not a "gitlens" publisher. Folding my one tool under a `gitstudio` umbrella means the next five tools have a home, and they all share one verified-publisher badge (which attaches to the *publisher*, so one domain covers everything).

I'd been about to bake a product name into a publisher slot. The filter accidentally saved me from that.

## Then: the *other* marketplace

Here's what tutorials skip. The "VS Code Marketplace" is Microsoft's. **Cursor, VSCodium, Gitpod, and Windsurf don't use it** — they use **Open VSX**, a separate registry run by the Eclipse Foundation. Different account, different token, different rules. If you only publish to Microsoft's, every Cursor user — a huge and growing slice — can't find you.

Open VSX was smoother, with one quirk: a new namespace shows a **"not a verified publisher"** warning until you claim ownership. I'd read you needed to prove a **domain** to clear it (I'd actually been asked for exactly that earlier). Turns out that's a misconception — a domain is just *one* option. Because my namespace matched a Marketplace publisher whose extension links a public repo I own, I could verify with a **commit URL**. No DNS, no domain. (The claim is a manual review, so it sits in a queue for a few days — but the extension works fine with the warning showing the whole time. Mine pulled 200+ installs *with* the warning up.)

**Lesson 3: publish to both registries, and don't believe "you need a domain" for Open VSX.**

## The papercuts, for completeness

- **shields.io retired its VS Marketplace badges.** My nice version/install badges rendered the literal text "retired badge." Every dynamic provider was down. Static badge it is.
- **CI failed on `tsx --test "test/**"`** with "could not find." The test-runner only expands `**` globs on **Node 21+**; CI was pinned to 20. One-line fix, twenty minutes of confusion.
- **I deleted my old listing — with 164 installs on it.** Open VSX has no redirect; those users are now stranded on a dead version. **Deprecate, don't delete**, once anything has installs.
- **You can't reuse a version number.** Even to fix a README typo on the live listing, you ship a new patch version.

## Where it landed

Merge Studio is live on **both** registries as `gitstudio.merge-studio`, under the GitStudio brand, with a **token-free release pipeline**: I push a `vX.Y.Z` tag and GitHub Actions publishes to both marketplaces and cuts a release. The painful part now takes one command.

The irony isn't lost on me: the single hardest part of shipping a polished extension was convincing a content filter that my own name wasn't a threat. But I came out with a better brand, a real release pipeline, and this:

## The guide

I wrote down every real step — zero to published on both registries, with the gotchas inline — as a standalone guide, and turned it into a forkable starter repo so nobody has to relearn this:

- **The guide:** `PUBLISHING.md` in [vscode-extension-starter](#)
- **The template:** fork it, rename, `git tag v0.1.0 && git push` → published on both.

If you're shipping your first extension: pick a brand name, publish to both registries, and budget an afternoon for the parts the docs don't mention. You've got this — the filter just doesn't know it yet.
