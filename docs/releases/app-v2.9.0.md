# GitStudio 2.9.0

### Added
- **Open a changed file in your editor from the commit details.** Each
  changed file's row has an Open working tree file button: the file as it is
  on disk now, in your favourite editor from Settings → Editors (#146).
- **Where every comparison starts.** Settings → Code and comparisons sets the
  whitespace handling and the highlight (words or lines) of every comparison
  in the app (#146).

### Fixed
- **Push, Pull and Set upstream answer before git does.** Push with no branch
  checked out offers New branch…; Pull on a branch that tracks nothing offers
  Publish branch; Set upstream to a remote branch not fetched yet fetches it.
- Stage all, with a conflict held back, no longer fails on a file the merge
  deleted.
- Staging selected lines says what is there: no changes, already staged, or
  nothing staged.
- GitHub: a pull request or review GitHub refuses shows GitHub's reason, not
  "Validation Failed"; My Work says why it couldn't reach GitHub.
- AI: preset defaults moved off retired models (Gemini 2.5, Groq's Llama 3,
  DeepSeek chat/reasoner, Together's Llama 3.3, OpenAI's GPT-4o); the Test
  button no longer fails reasoning models.
- Crash reports no longer file the user's own situation — only failures
  GitStudio may have caused.
