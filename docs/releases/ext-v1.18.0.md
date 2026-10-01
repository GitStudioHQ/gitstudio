# GitStudio 1.18.0 — in 14 languages

## GitStudio speaks your editor's language

Every view, message, command and setting now follows VS Code's display
language: Simplified and Traditional Chinese, Japanese, Korean, German,
French, Spanish, Italian, Portuguese (Brazil), Russian, Turkish, Polish and
Czech, besides English. There is nothing to switch on — set VS Code's display
language (**Configure Display Language**) and reload.

Simplified Chinese started as a community contribution — thank you,
[@AutumnPizazz](https://github.com/AutumnPizazz). The other translations are
machine drafts made with each language's own git and VS Code terms;
corrections from native speakers are very welcome as issues or pull requests.

## Edit Message… on a commit

Right-click a commit in the graph and choose **Edit Message…**: its whole
message opens in an editor, and GitStudio rewrites it in place, replaying the
commits after it. Branches on those commits can come along, a pushed commit
gets a warning first, and Undo puts everything back. Thanks to @glazrtom for
the idea in #75.

## What git stores stays in English

Undo's reflog entries, stash messages and the revert commit it makes are
written in English whatever language the editor shows, so the repository's
history reads the same for everyone who opens it.

## Fixed

- A reword in the interactive rebase workspace keeps the commit's
  description — it used to start from the subject line only (#75).
- Counts read as whole sentences ("Undo 3 local commits") instead of an
  English noun dropped into a translated sentence.
- On git 2.43, a stash git refuses without a word now says why.
