#!/usr/bin/env bash
#
# Build the image the deployment runs and check that it answers.
#
# The unit tests drive the service from Node. This drives the container: same
# code, different everything else — the base image, the missing build step, the
# documents copied in, the non-root user, the SQLite file on a mount. A test
# suite cannot see any of those, and the deployment is exactly where they are
# the only thing that matters.
#
# Each check below names what it catches, because a smoke test that passes for
# the wrong reason is worse than no smoke test.
#
#   scripts/container-smoke.sh          # 1000:1000, as the deployment runs
#   HUMANS_UID=$(id -u) HUMANS_GID=$(id -g) scripts/container-smoke.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-8484}"
export HUMANS_PORT="$PORT"

# The data directory is a bind mount, so the container's user has to be able to
# write to it. The deployment runs as 1000 (the image's `node` user, which is
# what ec2-user is on the box); on a dev machine that is your own uid.
export HUMANS_UID="${HUMANS_UID:-$(id -u)}"
export HUMANS_GID="${HUMANS_GID:-$(id -g)}"
BASE="http://127.0.0.1:$PORT"
BODY=$(mktemp)
FAILED=0

cleanup() {
  docker compose down --remove-orphans >/dev/null 2>&1 || true
  rm -f "$BODY"
}
trap cleanup EXIT

say()  { printf '  %-4s %s\n' "$1" "$2"; }
pass() { say "ok" "$1"; }
fail() { say "FAIL" "$1"; FAILED=1; }

# A status code, and optionally a substring the body must contain.
check() {
  local name="$1" url="$2" want_status="$3" want_text="${4:-}"
  local status
  status=$(curl -s -o "$BODY" -w '%{http_code}' "$BASE$url" || echo 000)
  if [ "$status" != "$want_status" ]; then
    fail "$name — $url answered $status, wanted $want_status"
    return
  fi
  if [ -n "$want_text" ] && ! grep -qF -- "$want_text" "$BODY"; then
    fail "$name — $url answered $status without \"$want_text\""
    return
  fi
  pass "$name"
}

echo "building the image the deployment runs"
docker compose build --quiet

echo "starting it as the deployment starts it"
docker compose up -d --wait --wait-timeout 60 >/dev/null

# `compose up --wait` returns only when the healthcheck passes, so reaching here
# already means the container booted and the database opened. The checks below
# are about what it serves.

# The console is the product; if it 404s there is nothing here.
check "the console is served"        /           200 '<title>console</title>'
# These three come out of the filesystem: DISCLAIMER.md and docs/, copied into
# the image by hand. A missing one is a boot failure rather than a 404, so this
# is the check that the COPY statements and the mount still agree.
check "the disclaimer is served"     /disclaimer 200 'Anthropic'
check "the money page is served"     /money      200 'The money'
check "the answering page is served" /answering  200 'Answering calls'
check "health is reported"           /healthz    200 '"ok":true'
# An unknown path is a 404 and not a console page — a catch-all route would make
# every typo look like a working endpoint.
check "an unknown path is a 404"     /nope       404

# Nothing in a fresh container has a caller key, so an unauthenticated call must
# be refused rather than queued for a person to read.
status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/messages" \
  -H 'content-type: application/json' \
  -d '{"model":"anything","max_tokens":1,"messages":[{"role":"user","content":"hello"}]}')
if [ "$status" = "401" ]; then
  pass "an unauthenticated call is refused"
else
  fail "an unauthenticated call answered $status, wanted 401"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "container smoke test failed; recent logs:"
  docker compose logs --tail 30
  exit 1
fi
echo "container smoke test passed"
