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

## What git stores stays in English

Undo's reflog entries, stash messages and the revert commit it makes are
written in English whatever language the editor shows, so the repository's
history reads the same for everyone who opens it.

## Fixed

- Counts read as whole sentences ("Undo 3 local commits") instead of an
  English noun dropped into a translated sentence.
- On git 2.43, a stash git refuses without a word now says why.
