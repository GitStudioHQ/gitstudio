# Simplified Chinese (zh-cn) glossary

Git porcelain verbs are translated, following git's own zh_CN translation and
the convention already used throughout `l10n/zh-cn.json`. Editor/UI chrome
follows VS Code's Simplified Chinese language pack conventions (e.g. 工具栏,
状态栏, 菜单, 粘贴, 剪切).

| English | Simplified Chinese |
| --- | --- |
| commit (noun/verb) | 提交 |
| branch | 分支 |
| merge | 合并 |
| rebase | 变基 |
| stash | 贮藏 |
| cherry-pick | 拣选 |
| revert | 还原 |
| reset | 重置 |
| fetch | 获取 |
| pull | 拉取 |
| push | 推送 |
| remote | 远程 |
| upstream | 上游 |
| tag | 标签 |
| HEAD | HEAD（不译） |
| detached HEAD | 分离的 HEAD |
| working tree | 工作树 |
| worktree | 工作树 |
| staged / staging | 已暂存 / 暂存 |
| unstage | 取消暂存 |
| conflict | 冲突 |
| resolve (a conflict) | 解决 |
| abort | 中止 |
| continue | 继续 |
| skip | 跳过 |
| squash | 压缩 |
| fixup | 修正 |
| drop | 丢弃 |
| amend | 修补 |
| reword | 改写 |
| fast-forward | 快进 |
| force push | 强制推送 |
| diff | 差异 |
| blame | 追溯 |
| history | 历史 |
| graph | 图谱 |
| repository | 仓库 |
| clone | 克隆 |
| pull request | 拉取请求 |
| issue | 议题 |
| review | 审查 |
| checkout / switch | 检出（checkout）／切换（switch to a branch） |
| discard | 丢弃 |
| undo | 撤销 |
| yours / theirs (merge sides) | 你的 / 对方的 |
| hunk | 块 |
| line | 行 |
| file | 文件 |
| folder | 文件夹 |
| settings | 设置 |

## Other recurring UI/editor terms

| English | Simplified Chinese |
| --- | --- |
| workspace | 工作区 |
| sidebar | 侧边栏 |
| panel | 面板 |
| status bar | 状态栏 |
| title bar | 标题栏 |
| toolbar | 工具栏 |
| menu | 菜单 |
| command palette | 命令面板 |
| keyboard shortcut | 键盘快捷键 |
| copy / paste / cut | 复制 / 粘贴 / 剪切 |
| mouse | 鼠标 |
| hover | 悬停 |
| click / double-click | 单击 / 双击 |
| scroll | 滚动 |
| save | 保存 |
| load | 加载 |
| cache | 缓存 |
| settings page | 设置 |
| default | 默认 |
| rename | 重命名 |
| collapse / expand | 折叠 / 展开 |
| add | 添加 |
| remove / delete | 移除 / 删除 |
| extension | 扩展 |
| provider | 提供程序 |
| sign in / sign out | 登录 / 退出登录 |
| account | 账户 |
| notification | 通知 |
| error | 错误 |
| warning | 警告 |
| submodule | 子模块 |
| draft (PR) | 草稿 |
| approve | 批准 |
| discussion / thread | 讨论 |
| release | 发行版 |

Notes:

- `git` command names, flags and code in backticks are never translated
  (e.g. `git rebase --continue`).
- Product names (GitStudio, Merge Studio, GitHub, VS Code, Cursor, Claude,
  OpenAI) stay in English.
- "HEAD" stays untranslated, matching both git's own usage and VS Code's
  Simplified Chinese pack.
- Derived from how `l10n/zh-cn.json` already renders these terms throughout
  the first-pass catalog (checked against the live data, e.g. 变基, 贮藏,
  拣选, 工作树, 检出, 分支, 合并, 冲突, 上游, 对方的/你的, 子模块, 草稿,
  批准, 已暂存/取消暂存), plus VS Code's Simplified Chinese language pack for
  editor chrome not yet present in the catalog (hunk → 块, folder → 文件夹,
  settings → 设置, sidebar → 侧边栏, etc).
