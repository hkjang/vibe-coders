#!/usr/bin/env bash
# Smoke-test the final distroless image from the host. The image itself intentionally
# contains neither a shell nor curl.
set -euo pipefail

IMAGE="${1:?usage: scripts/container-smoke.sh IMAGE [EXPECTED_VERSION] [EXPECTED_REVISION]}"
EXPECTED_VERSION="${2:-}"
EXPECTED_REVISION="${3:-}"
CONTAINER_NAME="vibe-appui-smoke-${RANDOM}-$$"
VOLUME_NAME="vibe-appui-smoke-data-${RANDOM}-$$"
STARTED=0
VOLUME_CREATED=0

cleanup() {
    if [[ "$STARTED" == "1" ]]; then
        docker stop --time 5 "$CONTAINER_NAME" >/dev/null 2>&1 || true
    fi
    if [[ "$VOLUME_CREATED" == "1" ]]; then
        docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT INT TERM

fail() {
    echo "smoke test failed: $*" >&2
    if [[ "$STARTED" == "1" ]]; then
        docker logs "$CONTAINER_NAME" >&2 || true
    fi
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
echo "container smoke passed: $IMAGE (${BASE_URL})"
