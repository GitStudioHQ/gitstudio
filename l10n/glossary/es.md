# Spanish (es) glossary

Neutral Spanish, consistent with VS Code's Spanish UI and git's own Spanish
translation (git-scm po). Git porcelain words that most Spanish-speaking dev
tools keep as loan words (commit, rebase, stash, cherry-pick, upstream,
squash, fixup, diff, blame, HEAD, fast-forward) are kept in English; this
also keeps the glossary internally consistent with the `git <cmd>` names that
must stay untouched anyway. Other words get plain, everyday Spanish.

| English | Spanish |
| --- | --- |
| commit (noun/verb) | commit |
| commit message | mensaje de commit |
| branch | rama |
| merge (verb) | fusionar |
| merge (noun) | fusión |
| rebase | rebase |
| stash | stash |
| cherry-pick | cherry-pick |
| revert | revertir |
| reset | restablecer |
| fetch | obtener |
| pull | incorporar |
| push | publicar |
| force push | push forzado |
| remote | remoto |
| origin (default remote) | origin |
| upstream | upstream |
| tag | etiqueta |
| HEAD | HEAD |
| detached HEAD | HEAD desacoplado |
| working tree | árbol de trabajo |
| worktree (git feature) | worktree |
| working directory | directorio de trabajo |
| index | índice |
| stage (verb) | preparar |
| staged / staging | preparado / en preparación |
| unstage | dejar de preparar |
| conflict | conflicto |
| resolve | resolver |
| abort | abortar |
| continue | continuar |
| skip | saltar |
| squash | squash |
| fixup | fixup |
| drop | descartar |
| amend | enmendar |
| reword | reformular |
| fast-forward | fast-forward |
| diff | diff |
| blame | blame |
| history | historial |
| graph | grafo |
| repository | repositorio |
| clone | clonar |
| pull request | pull request |
| issue | incidencia |
| review (noun) | revisión |
| review (verb) | revisar |
| checkout / switch | cambiar |
| discard | descartar |
| undo | deshacer |
| yours (merge side) | tuyo |
| theirs (merge side) | suyo |
| hunk | fragmento |
| line | línea |
| file | archivo |
| folder | carpeta |
| settings | configuración |
| changes | cambios |
| ahead / behind | por delante / por detrás |
| track / tracking | rastrear / seguimiento |
| untracked | sin seguimiento |
| default branch | rama predeterminada |
| sign in / sign out | iniciar sesión / cerrar sesión |
| notification | notificación |
| toolbar | barra de herramientas |
| sidebar | barra lateral |
| author | autor |
| timeline | línea de tiempo |
| walkthrough | guía introductoria |
| keyboard shortcut | atajo de teclado |
| pin / unpin | fijar / dejar de fijar |
| draft | borrador |
| submit | enviar |

Notes:
- Keep `git <command> --flag` names, code in backticks, product names
  (GitStudio, Merge Studio, GitHub, VS Code, Cursor, Claude, OpenAI), and
  `$(icon)` codicon tokens untouched.
- "Yours"/"theirs" are the merge-pane labels (not the git-rebase sense where
  git itself swaps the words); translate them per their on-screen pane, not
  literally per git's own (reversed) rebase terminology.
- "Checkout"/"switch" as plain UI verbs both become "cambiar (de rama)"; the
  literal `git checkout`/`git switch` command text in backticks is untouched.
