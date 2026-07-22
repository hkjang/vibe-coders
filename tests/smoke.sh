#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
mock_pid=""
gateway_pid=""

cleanup() {
  [[ -z "$gateway_pid" ]] || kill "$gateway_pid" 2>/dev/null || true
  [[ -z "$mock_pid" ]] || kill "$mock_pid" 2>/dev/null || true
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

cd "$repo_dir"
go run ./tests/mock_upstream.go >"$tmp_dir/mock.log" 2>&1 &
mock_pid=$!

LISTEN_ADDR=127.0.0.1:18080 \
UPSTREAM_BASE_URL=http://127.0.0.1:18081 \
UPSTREAM_API_KEY=test-only \
UPSTREAM_MODEL_PATTERNS='*' \
DB_DRIVER=sqlite \
DB_DSN="$tmp_dir/gateway.db" \
LOG_FALLBACK_PATH="$tmp_dir/fallback.ndjson" \
GATEWAY_SECRET=smoke-test-secret \
go run ./cmd/gateway >"$tmp_dir/gateway.log" 2>&1 &
gateway_pid=$!

ready=0
for _ in $(seq 1 90); do
  if curl --fail --silent http://127.0.0.1:18080/health >/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    cat "$tmp_dir/gateway.log" >&2
    exit 1
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || { cat "$tmp_dir/gateway.log" >&2; exit 1; }

curl --fail --silent http://127.0.0.1:18080/ready | grep -q 'ready'
curl --fail --silent http://127.0.0.1:18080/v1/models | grep -q 'judge-model'
curl --fail --silent http://127.0.0.1:18080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"judge-model","messages":[{"role":"user","content":"smoke"}]}' \
  | grep -q 'smoke-ok'

echo "smoke test passed"
