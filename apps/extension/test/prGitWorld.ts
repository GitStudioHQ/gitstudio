// Real git for the pull request tests, reached by github.com URLs: git's
// `url.<path>.insteadOf` sends a clone's github.com remote to a bare repository
// on disk, so the remotes a checkout adds, and the ones a form pushes to, are
// the URLs a real clone would have.
//
// `git remote -v` prints a URL AFTER insteadOf (the path on disk); the clone's
// config says github.com, and that is what a real clone's remote list reads —
// `configuredRemotes` makes the GitContext's list read the config.

import { execFileSync } from "node:child_process";

/* eslint-disable @typescript-eslint/no-explicit-any -- a GitContext, extended in place */
export function configuredRemotes(ctx: any, cwd: string): void {
  const real = ctx.remotes;
  ctx.remotes = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
    list: async () => {
      let out = "";
      try {
        out = execFileSync("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], { cwd, encoding: "utf8" }).trim();
      } catch {
        return [];
      }
      return out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [key, url] = l.split(" ");
          const name = key.replace(/^remote\./, "").replace(/\.url$/, "");
          return { name, fetchUrl: url, pushUrl: url };
        });
    },
  });
}
