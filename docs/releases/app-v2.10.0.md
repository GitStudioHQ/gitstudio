# GitStudio 2.10.0

### Added
- **Cherry-pick and revert a merge commit.** The app asks which side, as the
  extension does: for a cherry-pick, the changes that were merged in or those
  of the branch it was merged into; for a revert, which branch to keep. Every
  parent of an octopus merge is offered. It used to refuse and name the git
  command to run instead.

### Changed
- **Change a connection's models from the provider's list.** Each model
  field lists what the provider offers for that connection; a new connection
  still starts on its provider's defaults. Azure OpenAI now starts on
  OpenAI's current models instead of gpt-4o. Adding a Custom connection no
  longer says "Ready to use" before it has a model.
