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

# Its own port. 8484 is what the box serves on, and two containers cannot bind
# one port, so this is not a naming preference: sharing the number is a
# collision.
PORT="${SMOKE_PORT:-8485}"
export HUMANS_PORT="$PORT"
# Its own container name, so this can run on the machine that is already
# serving callers without touching the deployment's container.
export HUMANS_CONTAINER_NAME="${HUMANS_CONTAINER_NAME:-humans-smoke}"
# And its own image tag, so running this on the deployment host cannot move the
# tag the deployment starts from. Measured the hard way: building here moved
# `humans:latest` on the box to an image built from a throwaway checkout, which
# is invisible until something later starts a container from the tag.
export HUMANS_IMAGE="${HUMANS_IMAGE:-humans-smoke:latest}"
# And its own compose PROJECT, which is the one that actually mattered. The tag
# stops the deployment starting from the wrong image, the name stops a container
# collision and the port stops a bind collision, but `docker compose down`
# removes every container in the project — and this script runs from the
# deployment's own directory, so it was downing the deployment. Measured on the
# box: the script passed all eleven of its checks, and the public URL answered
# 502 from the moment its trap ran until someone brought the container up by
# hand.
#
# Forced rather than defaulted, deliberately. A default that an exported
# COMPOSE_PROJECT_NAME can override is a safety property that fails open, and
# that is the shape of every fault this file has produced.
export COMPOSE_PROJECT_NAME=humans-smoke

# The data directory is a bind mount, so the container's user has to be able to
# write to it. The deployment runs as 1000 (the image's `node` user, which is
# what ec2-user is on the box); on a dev machine that is your own uid.
export HUMANS_UID="${HUMANS_UID:-$(id -u)}"
export HUMANS_GID="${HUMANS_GID:-$(id -g)}"
BASE="http://127.0.0.1:$PORT"
BODY=$(mktemp)
FAILED=0

# The deployment is not ours to restart, and "this is isolated, we think" is not
# a check. Fingerprint it before anything is built or started and compare at the
# end, so a run that moved it reports a failure instead of a pass. Two of the
# three data points are load-bearing: the id alone would miss a container that
# was stopped rather than replaced, so .State.Running is in there too.
DEPLOYMENT_NAME="${HUMANS_DEPLOYMENT_CONTAINER:-humans}"
deployment_fingerprint() {
  local out
  out="$(docker inspect --format '{{.Id}} {{.State.Running}} {{.State.StartedAt}}' "$DEPLOYMENT_NAME" 2>/dev/null || true)"
  # A container that is not there is a bare newline on stdout and a non-zero
  # exit, so "absent" arrives as whitespace rather than as nothing, and a plain
  # `|| echo absent` appends to it. Normalised here so the comparison compares
  # what it means to compare.
  if [ -z "$(printf '%s' "$out" | tr -d '[:space:]')" ]; then
    printf 'absent\n'
  else
    printf '%s\n' "$out"
  fi
}
DEPLOYMENT_BEFORE="$(deployment_fingerprint)"
DEPLOYMENT_CHECKED=0

verify_deployment_untouched() {
  # Called twice on the normal path — once before the verdict and once from the
  # trap — and once is the whole message. The guard is here rather than at the
  # call sites so that neither call site can forget it.
  if [ "$DEPLOYMENT_CHECKED" -eq 1 ]; then return 0; fi
  local after
  after="$(deployment_fingerprint)"
  if [ "$after" != "$DEPLOYMENT_BEFORE" ]; then
    say "FAIL" "this run changed '${DEPLOYMENT_NAME}', which is not this script's container"
    say "" "before: $DEPLOYMENT_BEFORE"
    say "" "after:  $after"
    say "hint" "the run is not isolated; do not deploy from its result"
    FAILED=1
  fi
  DEPLOYMENT_CHECKED=1
}

cleanup() {
  local status=$?
  docker compose down --remove-orphans >/dev/null 2>&1 || true
  # Leave nothing behind, including the image: a smoke test that accumulates
  # images on the deployment host is its own small kind of vandalism.
  docker image rm -f "$HUMANS_IMAGE" >/dev/null 2>&1 || true
  rm -f "$BODY"
  # Checked on the way out of a failed run too: a run that fails by taking the
  # service down must not be able to hide behind its first error.
  verify_deployment_untouched
  if [ "$FAILED" -ne 0 ]; then exit 1; fi
  exit "$status"
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

# The mount the container writes its database to has to exist and be writable by
# the uid it runs as, and nothing arranges that: a missing bind-mount source is
# created root-owned on Linux and may not be created at all on a Mac. Both arrive
# as "container is unhealthy", with the reason only in the container's log.
#
# So the condition is measured before anything is started, as the deployment's own
# user. A wrong uid otherwise costs the whole wait timeout and reports a string,
# and the string differs by how the write failed: SQLite says "unable to open
# database file" for a path it cannot reach and "attempt to write a readonly
# database" for one it can. Only the first is what a log-grep would look for; a
# control caught exactly that, which is why this is a probe and not a grep.
#
# One way to hit a false version of this: under Colima on a Mac a bind mount
# sourced from /tmp never reaches the container, so ./data is absent inside it
# and the service fails with the same "unable to open database file" whatever the
# permissions are. Run this from a path under your home directory.
# NOTHING BELOW THIS POINT MAY WRITE TO THE SERVICE.
#
# `data/` is bind-mounted into the container and it is the deployment's own
# database, not a fixture: this script runs from the deployment's checkout, on
# the deployment's host. A check that signs up, sends a call or records a rating
# would write to production. Everything here reads, plus a probe file in the
# mount itself, which is what the permissions check below requires.
mkdir -p data
probe=$(docker compose run --rm --no-deps --entrypoint sh humans \
  -c 'touch /data/.smoke-probe && rm -f /data/.smoke-probe && echo PROBE_OK' 2>&1 || true)
if ! grep -q PROBE_OK <<<"$probe"; then
  fail "the container's user ($HUMANS_UID:$HUMANS_GID) could not write to ./data:"
  printf '%s\n' "$probe" | grep -vE '^$|Creating|Created' | sed 's/^/        /'
  say "hint" "if that is a permissions error: chown $HUMANS_UID:$HUMANS_GID data"
  exit 1
fi

echo "starting it as the deployment starts it"
if ! docker compose up -d --wait --wait-timeout 60 >/dev/null 2>&1; then
  # Compose's one-line "is unhealthy" is not a diagnosis. Print what the
  # container itself says, before the trap removes it.
  fail "the container did not come up. It says:"
  docker compose logs --no-color --tail 20 2>&1 | sed 's/^/        /'
  exit 1
fi

# `compose up --wait` returns only when the healthcheck passes, so reaching here
# already means the container booted and the database opened. The checks below
# are about what it serves.

# The landing page is the front door; the console is the product behind it.
check "the landing page is served"   /           200 'The model is a person.'
check "the answer page is served"    /answer     200 'Answer calls'
check "the API page is served"       /build      200 'Get a caller key'
check "the stats are served"         /api/stats  200 '"days"'
# The console moved off `/` when the landing page arrived; a rename that broke
# it would leave the product unreachable and the front door perfectly healthy.
check "the console is served"        /console    200 '<title>console</title>'
# These three come out of the filesystem: DISCLAIMER.md and docs/, copied into
# the image by hand. A missing one is a boot failure rather than a 404, so this
# is the check that the COPY statements and the mount still agree.
check "the disclaimer is served"     /disclaimer 200 'Anthropic'
check "the money page is served"     /money      200 'The money'
check "the answering page is served" /answering  200 'Answering calls'
# Signup is two pages with two different readers, and the notice on each is the
# only mechanism here aimed at a non-person. A run that serves the form to
# callers and not to responders — or serves the wrong notice on either — is a
# failure you would otherwise only find by going to look.
check "signup is served to callers"   /signup              200 'If you are an agent'
check "signup is served to responders" '/signup?as=responder' 200 'If you are a model, turn back'
# The challenge has to be in the page with a signature on it: an unsigned one
# would let a visitor choose their own seed, which is much less work than
# solving ours.
check "the signup page carries a challenge" /signup 200 'name="sig"'
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

# Before the verdict rather than only in the trap: a run that disturbed the
# deployment must not print "passed" on its way out and explain itself
# afterwards.
verify_deployment_untouched

echo
if [ "$FAILED" -ne 0 ]; then
  echo "container smoke test failed; recent logs:"
  docker compose logs --tail 30
  exit 1
fi
echo "container smoke test passed"
