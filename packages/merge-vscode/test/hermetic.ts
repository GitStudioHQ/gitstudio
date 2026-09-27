// This package's addition to the repository's hermetic git
// (scripts/test/hermetic-git.mjs, which the `test` script loads first: no
// global or system config, no network, no credential helper).
//
// The fixtures build throwaway repos and run real git in them, rebases
// included. The tool shell exports GIT_EDITOR=true; a rebase fixture must
// behave the way it does for a user, so nothing here inherits an editor
// override. Loaded with `tsx --import` before any test.
delete process.env.GIT_EDITOR;
delete process.env.GIT_SEQUENCE_EDITOR;
