#!/bin/bash
# land.sh <pr> [owner/repo] — merge a pull request only when it is really ready:
# every check on its CURRENT head finished and passed (Codecov is information,
# not a gate), and CodeQL found nothing new in it. Squash by default
# (MERGE_METHOD=merge for merge-studio's export PRs).
#
# It reads check-run states, never `gh pr checks` exit codes (8 while pending:
# a loop on that merged early three times), and it re-reads the head on every
# pass, so a push while it waits restarts the wait on the new commit.
set -u
N=$1; R=${2:-GitStudioHQ/gitstudio}
sleep "${LAND_DELAY:-30}"   # a job started right after a push can still read the OLD head
while :; do
  head=$(gh pr view "$N" --repo "$R" --json headRefOid,state -q '.state+" "+.headRefOid')
  case "$head" in MERGED*|CLOSED*) echo "#$N already ${head%% *}"; exit 0;; esac
  sha=${head#* }
  js=$(gh api "repos/$R/commits/$sha/check-runs?per_page=100" --jq '[.check_runs[]|select(.name|startswith("codecov/")|not)|{n:.name,s:.status,c:(.conclusion//"")}]')
  total=$(echo "$js" | jq length); open=$(echo "$js" | jq '[.[]|select(.s!="completed")]|length')
  [ "$total" -ge 4 ] && [ "$open" = 0 ] && break
  sleep 60
done
echo "$js" | jq -r '.[]|.c' | sort | uniq -c | sed "s/^/#$N /"
if echo "$js" | jq -r '.[]|.c' | grep -qiE '^(failure|cancelled|timed_out|startup_failure|action_required)$'; then
  echo "STOP: #$N has failed checks on ${sha:0:8}"
  gh api "repos/$R/commits/$sha/check-runs?per_page=100" --jq '.check_runs[]|select(.conclusion=="failure")|"  failed: \(.name) \(.html_url)"'
  exit 1
fi
# New CodeQL alerts in this PR — open in its analysis and not open on main.
# (The repo rule only blocks errors; warnings stopped two releases after merge.)
pr=$(gh api "repos/$R/code-scanning/alerts?pr=$N&state=open&per_page=100" --jq '[.[].number]' 2>/dev/null || echo '[]')
main=$(gh api "repos/$R/code-scanning/alerts?ref=refs/heads/main&state=open&per_page=100" --jq '[.[].number]' 2>/dev/null || echo '[]')
new=$(jq -n --argjson p "$pr" --argjson m "$main" '$p - $m | length')
if [ "$new" != 0 ]; then
  echo "STOP: #$N adds $new CodeQL alert(s):"
  gh api "repos/$R/code-scanning/alerts?pr=$N&state=open&per_page=100" --jq ".[]|select(.number as \$x | $main | index(\$x) | not)|\"  \(.rule.id) \(.most_recent_instance.location.path):\(.most_recent_instance.location.start_line)\""
  exit 1
fi
gh pr merge "$N" --repo "$R" --"${MERGE_METHOD:-squash}" --admin 2>&1 | tail -1
gh pr view "$N" --repo "$R" --json state -q "\"#$N \"+.state"
