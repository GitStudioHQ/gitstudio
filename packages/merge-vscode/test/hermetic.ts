// Hermetic git for this package's tests (the same recipe as git-service's).
//
// The fixtures build throwaway repos and run real git in them. Against the
// developer's global or system config they would inherit hooks, LFS filters,
// an editor, autocrlf and trace2 listeners, and a test would then describe the
// machine instead of the code. Loaded with `tsx --import` before any test.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfg = join(mkdtempSync(join(tmpdir(), "merge-vscode-test-cfg-")), "config");
writeFileSync(cfg, "");

process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";
delete process.env.GIT_TRACE2;
delete process.env.GIT_TRACE2_EVENT;
delete process.env.GIT_TRACE2_PERF;
// The tool shell exports GIT_EDITOR=true; a rebase fixture must behave the way
// it does for a user, so nothing here inherits an editor override.
delete process.env.GIT_EDITOR;
delete process.env.GIT_SEQUENCE_EDITOR;
