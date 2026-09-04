#!/usr/bin/env bash
# Fail closed when the final runtime image contains a high or critical known CVE.
set -euo pipefail

IMAGE="${1:?usage: scripts/scan-container-image.sh IMAGE}"
REQUIRED_GRYPE_VERSION="${GRYPE_REQUIRED_VERSION:-0.117.0}"

if ! command -v grype >/dev/null 2>&1; then
    echo "최종 이미지 취약점 검사에는 Grype ${REQUIRED_GRYPE_VERSION}가 필요합니다." >&2
    exit 1
fi

ACTUAL_GRYPE_VERSION="$(grype version 2>/dev/null | sed -n 's/^Version:[[:space:]]*//p' | head -n 1)"
ACTUAL_GRYPE_VERSION="${ACTUAL_GRYPE_VERSION#v}"
if [[ "$ACTUAL_GRYPE_VERSION" != "$REQUIRED_GRYPE_VERSION" ]]; then
    echo "Grype 버전이 일치하지 않습니다: ${ACTUAL_GRYPE_VERSION:-확인 불가} (필요: ${REQUIRED_GRYPE_VERSION})" >&2
    exit 1
fi

echo "최종 이미지 고위험 취약점 검사: $IMAGE (Grype ${REQUIRED_GRYPE_VERSION})"
GRYPE_CHECK_FOR_APP_UPDATE=false \
GRYPE_DB_REQUIRE_UPDATE_CHECK=true \
    grype "$IMAGE" --from docker --fail-on high --output table
