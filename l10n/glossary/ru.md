# Russian (ru) glossary

Sources: git's own `po/ru.po` (git terms) and VS Code's Russian language pack
(`vscode-language-pack-ru`, incl. the `git` extension) for editor/UI terms.
Where the two disagree, the more natural/contemporary choice used by Russian
developer tooling (GitKraken, GitHub Desktop, Git Extensions RU) was picked,
and that choice is used consistently everywhere in GitStudio's Russian UI.

| English | Russian | Notes |
|---|---|---|
| commit (noun) | коммит | loanword, dominant in RU dev usage |
| commit (verb) | закоммитить / сделать коммит | |
| branch | ветка | git po: ветка (VS Code pack says "ветвь"; "ветка" is the natural choice) |
| merge (noun) | слияние | |
| merge (verb) | слить / объединить | |
| rebase | перебазировать / перебазирование | |
| stash (noun) | тайник | |
| stash (verb) | спрятать | |
| cherry-pick | cherry-pick | kept as loanword, no natural short RU term |
| revert | обратить (коммит) | distinct from "отменить" (undo) and "откатить" (reset) |
| reset | сбросить / сброс | |
| fetch | получить / получение | |
| pull | стянуть | distinct from fetch |
| push | отправить / отправка | |
| remote | удалённый репозиторий | |
| upstream | вышестоящая ветка | |
| tag | тег | |
| HEAD | HEAD | kept |
| detached HEAD | отделённый HEAD | |
| working tree | рабочее дерево | |
| worktree (git worktree) | рабочий каталог | distinct from "working tree" above |
| staged / staging | в индексе / индекс | |
| stage (verb) | добавить в индекс | |
| unstage | убрать из индекса | |
| conflict | конфликт | |
| resolve | разрешить | |
| abort | прервать | |
| continue | продолжить | |
| skip | пропустить | |
| squash | объединить (коммиты) | |
| fixup | исправление | |
| drop | отбросить | |
| amend | исправить (коммит) | |
| reword | переформулировать | |
| fast-forward | перемотка вперёд | |
| force push | принудительная отправка | |
| diff | различия | |
| blame | Blame | kept as feature name, like other RU git tools |
| history | история | |
| graph | граф | |
| repository | репозиторий | |
| clone | клонировать / клонирование | |
| pull request | pull request | kept as loanword |
| issue | issue | kept as loanword |
| review | ревью | |
| checkout / switch | переключиться (на ветку) | |
| discard | отклонить (изменения) | distinct from undo/revert/reset |
| undo | отменить | |
| yours (merge side) | ваши | |
| theirs (merge side) | их | |
| hunk | блок | блок изменений |
| line | строка | |
| file | файл | |
| folder | папка | |
| settings | настройки | |
| working directory | рабочий каталог | |
| index | индекс | |
| ahead / behind | впереди / позади | |
| submodule | подмодуль | |
| bare repository | голый репозиторий | |
| bisect | bisect | kept, specialist git term |
| log | журнал | |
| status | состояние | |
| untracked | неотслеживаемый | |
| modified | изменён | |
| deleted | удалён | |
| renamed | переименован | |
| binary file | двоичный файл | |
| line ending | конец строки | |
| whitespace | пробелы | |
| origin | origin | kept, default remote name |
| default branch | основная ветка | |
| protected branch | защищённая ветка | |
| draft (PR) | черновик | |
| approve | одобрить | |
| request changes | запросить изменения | |
| comment | комментарий | |
| label | метка | GitHub label, distinct sense from git tag |
| assignee | исполнитель | |
| notification | уведомление | |
| sync | синхронизировать | |
| track | отслеживать | |
| organization | организация | |
| collaborator | соавтор | |
| fork | форк | |
| release | релиз | |
| signed commit | подписанный коммит | |
