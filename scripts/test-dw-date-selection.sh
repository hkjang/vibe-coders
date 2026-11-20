#!/usr/bin/env bash
set -euo pipefail

# Fresh local-only ClickHouse: never accepts a production URL or credentials.
task_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
task_tmp=$(mktemp -d)
task_container="vibe-dw-date-test-$$"
task_started=false
cleanup() {
  if $task_started; then docker rm -f "$task_container" >/dev/null; fi
  rm -rf "$task_tmp"
}
trap cleanup EXIT
cd "$task_root"
CGO_ENABLED=0 go test -c -o "$task_tmp/proxy.test" ./internal/proxy
docker run -d --rm --network none --name "$task_container" \
  -v "$task_tmp/proxy.test:/verify.test:ro" \
  clickhouse/clickhouse-server@sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b >/dev/null
task_started=true
for task_attempt in $(seq 1 120); do
  if docker exec "$task_container" clickhouse-client --query 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [ "$task_attempt" = 120 ]; then echo 'Isolated ClickHouse readiness failed' >&2; exit 1; fi
  sleep 0.5
done
docker exec -e VIBE_TEST_DW_CLICKHOUSE_LOCAL=1 "$task_container" /verify.test \
  -test.run='^TestDWDashboardClickHouseDateSelection$' -test.v -test.timeout=2m
