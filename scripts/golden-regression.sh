#!/usr/bin/env bash
# Golden Prompt regression gate for CI.
#
# Runs every golden prompt registered in the gateway against the given model(s)
# and fails (exit 1) when the pass rate drops below the threshold — so model or
# prompt changes can't merge if they regress known-good behaviour.
#
# Usage:
#   GATEWAY_URL=http://localhost:8080 ADMIN_TOKEN=... \
#   scripts/golden-regression.sh "gpt-4.1-mini,gpt-4.1" [min_pass_rate] [tag]
#
# Defaults: models from $GOLDEN_MODELS, min_pass_rate=1.0, no tag filter.
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:8080}"
MODELS="${1:-${GOLDEN_MODELS:-}}"
MIN_PASS_RATE="${2:-1.0}"
TAG="${3:-}"

if [[ -z "$MODELS" ]]; then
  echo "error: no models given (arg 1 or \$GOLDEN_MODELS)" >&2
  exit 2
fi

# Build a JSON array from the comma-separated model list.
models_json=$(printf '%s' "$MODELS" | awk -v RS=',' 'NF{gsub(/^[ \t]+|[ \t]+$/,"");printf "%s\"%s\"",sep,$0;sep=","}')
payload="{\"models\":[${models_json}],\"min_pass_rate\":${MIN_PASS_RATE}"
if [[ -n "$TAG" ]]; then payload="${payload},\"tag\":\"${TAG}\""; fi
payload="${payload}}"

auth=()
if [[ -n "${ADMIN_TOKEN:-}" ]]; then auth=(-H "Authorization: Bearer ${ADMIN_TOKEN}"); fi

echo "Running golden regression against: ${MODELS} (min_pass_rate=${MIN_PASS_RATE}${TAG:+, tag=$TAG})"
http_code=$(curl -sS -o /tmp/golden_result.json -w '%{http_code}' \
  -X POST "${GATEWAY_URL}/admin/golden-prompts/run?fail_on_regression=1" \
  -H "Content-Type: application/json" "${auth[@]}" \
  -d "$payload")

cat /tmp/golden_result.json
echo

if [[ "$http_code" == "422" ]]; then
  echo "::error::Golden prompt regression detected (pass rate below ${MIN_PASS_RATE})." >&2
  exit 1
fi
if [[ "$http_code" != "200" ]]; then
  echo "error: gateway returned HTTP ${http_code}" >&2
  exit 1
fi
echo "Golden regression gate passed."
