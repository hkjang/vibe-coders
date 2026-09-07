#!/usr/bin/env bash
# Smoke-test the final distroless image from the host. The image itself intentionally
# contains neither a shell nor curl.
set -euo pipefail

IMAGE="${1:?usage: scripts/container-smoke.sh IMAGE [EXPECTED_VERSION] [EXPECTED_REVISION]}"
EXPECTED_VERSION="${2:-}"
EXPECTED_REVISION="${3:-}"
CONTAINER_NAME="vibe-appui-smoke-${RANDOM}-$$"
VOLUME_NAME="vibe-appui-smoke-data-${RANDOM}-$$"
UPGRADE_CONTAINER_NAME="vibe-upgrade-smoke-${RANDOM}-$$"
UPGRADE_VOLUME_NAME="vibe-upgrade-smoke-data-${RANDOM}-$$"
STARTED=0
VOLUME_CREATED=0
UPGRADE_VOLUME_CREATED=0

cleanup() {
    if [[ "$STARTED" == "1" ]]; then
        docker stop --time 5 "$CONTAINER_NAME" >/dev/null 2>&1 || true
    fi
    docker rm -f "$UPGRADE_CONTAINER_NAME" >/dev/null 2>&1 || true
    if [[ "$VOLUME_CREATED" == "1" ]]; then
        docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
    fi
    if [[ "$UPGRADE_VOLUME_CREATED" == "1" ]]; then
        docker volume rm "$UPGRADE_VOLUME_NAME" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT INT TERM

fail() {
    echo "smoke test failed: $*" >&2
    if [[ "$STARTED" == "1" ]]; then
        docker logs "$CONTAINER_NAME" >&2 || true
    fi
    docker logs "$UPGRADE_CONTAINER_NAME" >&2 2>/dev/null || true
    exit 1
}

expect_status() {
    local expected="$1"
    local method="$2"
    local path="$3"
    local actual
    actual="$(curl -sS -o /dev/null -w '%{http_code}' -X "$method" "${BASE_URL}${path}")" || \
        fail "$method $path could not be requested"
    [[ "$actual" == "$expected" ]] || fail "$method $path returned $actual, expected $expected"
}

IMAGE_USER="$(docker image inspect --format '{{.Config.User}}' "$IMAGE")"
case "$IMAGE_USER" in
    nonroot|nonroot:nonroot|65532|65532:65532) ;;
    *) fail "runtime image user is ${IMAGE_USER:-unset}, expected nonroot" ;;
esac

if [[ -n "$EXPECTED_VERSION" ]]; then
    IMAGE_VERSION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE")"
    [[ "$IMAGE_VERSION" == "$EXPECTED_VERSION" ]] || fail "image version label is $IMAGE_VERSION, expected $EXPECTED_VERSION"
fi
if [[ -n "$EXPECTED_REVISION" ]]; then
    IMAGE_REVISION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")"
    [[ "$IMAGE_REVISION" == "$EXPECTED_REVISION" ]] || fail "image revision label is $IMAGE_REVISION, expected $EXPECTED_REVISION"
fi

docker volume create "$VOLUME_NAME" >/dev/null
VOLUME_CREATED=1

docker run --rm --detach \
    --name "$CONTAINER_NAME" \
    --publish 127.0.0.1::8080 \
    --mount "source=${VOLUME_NAME},target=/data" \
    --env DB_DSN=/data/smoke.db \
    --env LOG_FALLBACK_PATH=/data/fallback.ndjson \
    --env UI_APP_ENABLED=true \
    "$IMAGE" >/dev/null
STARTED=1

HOST_PORT="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}' "$CONTAINER_NAME")"
[[ -n "$HOST_PORT" ]] || fail "Docker did not publish port 8080"
BASE_URL="http://127.0.0.1:${HOST_PORT}"

READY=0
for ((attempt = 1; attempt <= 45; attempt += 1)); do
    if curl -fsS "${BASE_URL}/ready" >/dev/null 2>&1; then
        READY=1
        break
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)" != "true" ]]; then
        break
    fi
    sleep 1
done
[[ "$READY" == "1" ]] || fail "gateway did not become ready within 45 seconds"

expect_status 200 GET /health
expect_status 200 GET /ready
expect_status 200 GET /admin
ADMIN_HTML="$(curl -fsS "${BASE_URL}/admin")" || fail "GET /admin body could not be read"
grep -Fq '<title>vibe-coders AI 게이트웨이</title>' <<<"$ADMIN_HTML" || \
    fail "GET /admin did not return the Legacy Stable Console"

APP_REDIRECT_HEADERS="$(curl -sS -D - -o /dev/null "${BASE_URL}/app")"
grep -Eq '^HTTP/[^ ]+ 308([[:space:]]|$)' <<<"$APP_REDIRECT_HEADERS" || fail "GET /app is not a 308 redirect"
grep -Eiq '^location:[[:space:]]*/app/[[:space:]]*$' <<<"$APP_REDIRECT_HEADERS" || fail "GET /app does not redirect to /app/"

APP_HEADERS="$(curl -sS -D - -o /dev/null "${BASE_URL}/app/")"
grep -Eq '^HTTP/[^ ]+ 200([[:space:]]|$)' <<<"$APP_HEADERS" || fail "GET /app/ did not return 200"
grep -Eiq '^content-type:[[:space:]]*text/html' <<<"$APP_HEADERS" || fail "GET /app/ is not HTML"
grep -Eiq '^cache-control:[[:space:]]*no-cache' <<<"$APP_HEADERS" || fail "GET /app/ is not revalidated"

APP_HTML="$(curl -fsS "${BASE_URL}/app/")"
grep -Fq '<div id="root"></div>' <<<"$APP_HTML" || fail "GET /app/ is not the React index"

expect_status 200 GET /app/providers
expect_status 200 GET /app/routing/decisions/123
expect_status 404 GET /app/assets/not-found.js
expect_status 405 POST /app/providers

ASSET_PATH="$(grep -oE '/app/assets/[^"[:space:]]+\.(js|css)' <<<"$APP_HTML" | sed -n '1p' || true)"
[[ -n "$ASSET_PATH" ]] || fail "React index does not reference a hashed /app/assets file"
ASSET_HEADERS="$(curl -sS -D - -o /dev/null "${BASE_URL}${ASSET_PATH}")"
grep -Eq '^HTTP/[^ ]+ 200([[:space:]]|$)' <<<"$ASSET_HEADERS" || fail "GET $ASSET_PATH did not return 200"
grep -Eiq '^cache-control:.*max-age=31536000.*immutable' <<<"$ASSET_HEADERS" || fail "$ASSET_PATH is not immutable"

if [[ -n "$EXPECTED_VERSION" ]]; then
    AUTH_ME="$(curl -fsS "${BASE_URL}/auth/me")"
    ACTUAL_VERSION="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("version", ""))' <<<"$AUTH_ME")"
    [[ "$ACTUAL_VERSION" == "$EXPECTED_VERSION" ]] || \
        fail "/auth/me version is $ACTUAL_VERSION, expected $EXPECTED_VERSION"
fi

# The failed app requests above must not affect the stable legacy console.
expect_status 200 GET /admin
ADMIN_HTML_AFTER_APP_FAILURES="$(curl -fsS "${BASE_URL}/admin")" || \
    fail "GET /admin body could not be read after app failures"
grep -Fq '<title>vibe-coders AI 게이트웨이</title>' <<<"$ADMIN_HTML_AFTER_APP_FAILURES" || \
    fail "GET /admin did not remain the Legacy Stable Console after app failures"
# Upgrade path: a /data volume that another user wrote (a bind mount created by
# root, an older volume, a Kubernetes PVC) used to make the nonroot gateway die with
# a bare "attempt to write a readonly database" and port 8080 never opened. The image
# has no shell, so the repair must work with the image alone: the failure has to name
# the fix, and `repair-data-dir` run once as root has to make the same volume usable.
docker volume create "$UPGRADE_VOLUME_NAME" >/dev/null
UPGRADE_VOLUME_CREATED=1
run_upgrade_gateway() {
    # $1 = --user value ("" keeps the image's nonroot user)
    local user_args=()
    if [[ -n "$1" ]]; then
        user_args=(--user "$1")
    fi
    docker rm -f "$UPGRADE_CONTAINER_NAME" >/dev/null 2>&1 || true
    docker run --detach \
        --name "$UPGRADE_CONTAINER_NAME" \
        --publish 127.0.0.1::8080 \
        --mount "source=${UPGRADE_VOLUME_NAME},target=/data" \
        --env DB_DSN=/data/upgrade.db \
        --env LOG_FALLBACK_PATH=/data/fallback.ndjson \
        --env GATEWAY_VERSION="${EXPECTED_VERSION:-smoke}" \
        "${user_args[@]}" \
        "$IMAGE" >/dev/null
}
wait_upgrade_gateway() {
    # Succeeds when /ready answers; fails when the container exits first or 45 s pass.
    local port url
    for ((attempt = 1; attempt <= 45; attempt += 1)); do
        if [[ "$(docker inspect --format '{{.State.Running}}' "$UPGRADE_CONTAINER_NAME" 2>/dev/null || true)" != "true" ]]; then
            return 1
        fi
        port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}' "$UPGRADE_CONTAINER_NAME" 2>/dev/null || true)"
        url="http://127.0.0.1:${port}"
        if [[ -n "$port" ]] && curl -fsS "${url}/ready" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

# 1) Seed the volume as root, the way a bind mount or an older deployment leaves it.
run_upgrade_gateway 0:0
wait_upgrade_gateway || fail "gateway did not become ready as root to seed the upgrade volume"
docker stop --time 5 "$UPGRADE_CONTAINER_NAME" >/dev/null

# 2) The nonroot image must refuse to start and say why, instead of looping on 8080.
run_upgrade_gateway ""
if wait_upgrade_gateway; then
    fail "nonroot gateway started on a root-owned database; the data directory preflight is missing"
fi
UPGRADE_LOGS="$(docker logs "$UPGRADE_CONTAINER_NAME" 2>&1 || true)"
grep -Fq '/data/upgrade.db' <<<"$UPGRADE_LOGS" || fail "startup failure does not name the unwritable database: ${UPGRADE_LOGS}"
grep -Fq 'repair-data-dir /data' <<<"$UPGRADE_LOGS" || fail "startup failure does not name the repair command: ${UPGRADE_LOGS}"
grep -Fq "ai-coding-proxy-gateway:${EXPECTED_VERSION:-smoke} repair-data-dir" <<<"$UPGRADE_LOGS" || \
    fail "repair command does not carry the GATEWAY_VERSION image tag: ${UPGRADE_LOGS}"
docker rm -f "$UPGRADE_CONTAINER_NAME" >/dev/null

# 3) check-data-dir must report the same failure with a non-zero exit for scripts.
if docker run --rm --mount "source=${UPGRADE_VOLUME_NAME},target=/data" --env DB_DSN=/data/upgrade.db "$IMAGE" check-data-dir >/dev/null 2>&1; then
    fail "check-data-dir exited 0 on a root-owned database"
fi

# 4) The documented one-shot repair, run as root with the image itself, must fix it.
REPAIR_OUTPUT="$(docker run --rm --user 0:0 --mount "source=${UPGRADE_VOLUME_NAME},target=/data" --env DB_DSN=/data/upgrade.db "$IMAGE" repair-data-dir 2>&1)" || \
    fail "repair-data-dir failed: ${REPAIR_OUTPUT}"
grep -Fq 'chown /data/upgrade.db' <<<"$REPAIR_OUTPUT" || fail "repair-data-dir did not re-own the database: ${REPAIR_OUTPUT}"
docker run --rm --mount "source=${UPGRADE_VOLUME_NAME},target=/data" --env DB_DSN=/data/upgrade.db "$IMAGE" check-data-dir >/dev/null 2>&1 || \
    fail "check-data-dir still fails after repair-data-dir"

# 5) The nonroot gateway now starts on the repaired volume with its data intact.
run_upgrade_gateway ""
wait_upgrade_gateway || fail "nonroot gateway did not start after repair-data-dir"
docker rm -f "$UPGRADE_CONTAINER_NAME" >/dev/null

echo "container smoke passed: $IMAGE (${BASE_URL})"
