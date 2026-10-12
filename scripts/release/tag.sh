#!/bin/bash
# tag.sh <sha> <tag>… — tag a main commit for release, only when it is safe to:
# main's CI on that exact commit finished green, CodeQL has analysed it, there
# are no open code-scanning or Dependabot alerts, and each tag's version
# matches the package.json it releases (ext-v* → apps/extension,
# app-v* → apps/desktop). Tag pushes publish, so nothing here is forced.
#
#   scripts/release/tag.sh "$(git rev-parse origin/main)" ext-v1.19.0 app-v2.6.0
set -u
R=GitStudioHQ/gitstudio; sha=$1; shift
[ $# -ge 1 ] || { echo "usage: tag.sh <sha> <tag>…"; exit 2; }
git fetch -q origin
git merge-base --is-ancestor "$sha" origin/main || { echo "STOP: $sha is not on origin/main"; exit 1; }
for t in "$@"; do
  case "$t" in ext-v*) app=apps/extension;; app-v*) app=apps/desktop;; *) echo "STOP: unknown tag kind $t"; exit 1;; esac
  v=$(git show "${sha}:${app}/package.json" | jq -r .version)
  [ "v$v" = "${t#*-}" ] || { echo "STOP: $t but $app/package.json says $v"; exit 1; }
done
echo "waiting for main's CI on ${sha:0:8}…"
while :; do
  js=$(gh api "repos/$R/commits/$sha/check-runs?per_page=100" --jq '[.check_runs[]|select(.name|startswith("codecov/")|not)|{n:.name,s:.status,c:(.conclusion//"")}]')
  [ "$(echo "$js" | jq length)" -ge 4 ] && [ "$(echo "$js" | jq '[.[]|select(.s!="completed")]|length')" = 0 ] && break
  sleep 60
done
echo "$js" | jq -r '.[]|.c' | grep -qiE '^(failure|cancelled|timed_out|startup_failure|action_required)$' && { echo "STOP: main is red on $sha"; echo "$js" | jq -r '.[]|.n+" "+.c'; exit 1; }
for i in $(seq 1 40); do
  n=$(gh api "repos/$R/code-scanning/analyses?ref=refs/heads/main&per_page=20" --jq "[.[]|select(.commit_sha==\"$sha\")]|length")
  [ "${n:-0}" -ge 1 ] && break; sleep 60
done
sleep 60
cs=$(gh api "repos/$R/code-scanning/alerts?state=open&per_page=100" --jq length)
db=$(gh api "repos/$R/dependabot/alerts?state=open&per_page=100" --jq length)
[ "$cs" = 0 ] && [ "$db" = 0 ] || { echo "STOP: open alerts — code-scanning $cs, Dependabot $db"; exit 1; }
for t in "$@"; do git tag -a "$t" "$sha" -m "GitStudio ${t}"; done
git push origin "$@" && echo "TAGGED $* at $sha"
