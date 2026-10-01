# French (fr) glossary

Conventions: git terms follow git's official French `po/fr.po` (e.g.
`commit→valider`, `branch→branche`, `stash→remisage`, `cherry-pick→picorer`,
`fetch→récupérer`, `pull→tirer`, `push→pousser`, `tag→étiquette`,
`working tree→arbre de travail`, `staged→indexé`). Editor/UI terms follow
VS Code's French language pack (`vscode-language-pack-fr`), which in
practice keeps several words as English loan words even where git's po
translates them (`Pull`, `diff`, `hunk`, `HEAD`, `Git Blame`), and
sometimes gives a translated verb with the English term in parentheses on
first use (`Tirer (pull)`). Rebase-todo keywords (`pick`, `reword`,
`edit`, `squash`, `fixup`, `drop`) are literal git syntax and stay in
English wherever they denote the actual command, per the "keep unchanged"
rule — the French column below is for when the same word is used as a UI
label/description, not as the literal keyword. Address: neutral/
imperative/infinitive style, no "tu"/"vous" address needed except in
confirmation questions, where VS Code's French pack uses "vous" (formal).
Quotes: use « » (with narrow spaces) for quoted names only where the
English already quotes something; do not add quotes the English lacks —
plain straight quotes `'…'`/`"…"` in English may be rendered as « … » if
you need a French-looking quote, but never introduce `"` itself.

| English | French |
|---|---|
| commit (noun) | commit |
| commit (verb, "to commit") | valider |
| commit message | message de commit |
| branch | branche |
| merge (noun) | fusion |
| merge (verb) | fusionner |
| merge conflict | conflit de fusion |
| rebase (noun) | rebase |
| rebase (verb) | rebaser |
| stash (noun) | stash |
| stash (verb, "to stash") | remiser |
| cherry-pick (noun/label) | cherry-pick |
| cherry-pick (verb) | picorer |
| revert | annuler (le commit) |
| reset | réinitialiser |
| fetch | récupérer |
| pull | tirer |
| push | pousser |
| force push | push forcé / forcer l'envoi (push) |
| remote | distant / dépôt distant |
| upstream | amont |
| tag | étiquette |
| HEAD | HEAD |
| detached HEAD | HEAD détachée |
| working tree | arbre de travail |
| worktree | arborescence de travail |
| staged / staging | indexé / indexation |
| stage (verb, a file) | indexer |
| unstage | désindexer |
| conflict | conflit |
| resolve (conflict) | résoudre |
| abort | abandonner |
| continue | continuer |
| skip | ignorer |
| squash (UI label) | squash |
| fixup (UI label) | fixup |
| drop (UI label, remove commit/stash) | supprimer |
| amend | modifier (le commit) |
| reword | reformuler (le message) |
| fast-forward | avance rapide |
| diff | diff |
| blame | blame |
| history | historique |
| graph | graphe |
| repository | dépôt |
| clone | cloner |
| pull request | pull request |
| issue | issue |
| review (noun) | revue |
| review (verb) | réviser |
| checkout / switch | extraire / basculer |
| discard | ignorer |
| undo | annuler |
| yours (merge side) | la vôtre / vous |
| theirs (merge side) | la leur / eux |
| hunk | hunk |
| line | ligne |
| file | fichier |
| folder | dossier |
| settings | paramètres |
| changes | modifications |
| uncommitted changes | modifications non validées |
| submodule | sous-module |
| apply | appliquer |
| patch | patch |
| ahead/behind | en avance / en retard |
| default branch | branche par défaut |
| local | local |
| track / tracking | suivre / suivi |
| annotate | annoter |
| author | auteur |
| committer | committer |
| rename | renommer |
| delete | supprimer |
| create | créer |
| open | ouvrir |
| close | fermer |
| save | enregistrer |
| search | rechercher |
| filter | filtrer |
| sort | trier |
| copy | copier |
| paste | coller |
| clipboard | presse-papiers |
| notification | notification |
| error | erreur |
| warning | avertissement |
| extension | extension |
| workspace | espace de travail |
| sign in / log in | se connecter |
