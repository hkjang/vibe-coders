#!/usr/bin/env bash
# 오프라인 배포용 Docker 이미지를 빌드하고 tar.gz 로 패키징한다.
#
# 사용법:
#   ./scripts/release.sh [-v VERSION] [-i IMAGE] [-p PLATFORM]
#
# 예:
#   ./scripts/release.sh -v v0.1.0
#   ./scripts/release.sh -v v0.1.0 -p linux/arm64
set -euo pipefail

IMAGE="ai-coding-proxy-gateway"
PLATFORM="linux/amd64"
VERSION=""

while getopts ":v:i:p:h" opt; do
    case "$opt" in
        v) VERSION="$OPTARG" ;;
        i) IMAGE="$OPTARG" ;;
        p) PLATFORM="$OPTARG" ;;
        h)
            sed -n '2,12p' "$0"
            exit 0
            ;;
        \?) echo "알 수 없는 옵션: -$OPTARG" >&2; exit 2 ;;
    esac
done

if ! command -v docker >/dev/null 2>&1; then
    echo "docker 가 PATH 에 없습니다." >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -z "$VERSION" ]]; then
    STAMP="$(date +%Y%m%d-%H%M)"
    if SHORT_SHA="$(git rev-parse --short HEAD 2>/dev/null)"; then
        VERSION="${STAMP}-${SHORT_SHA}"
    else
        VERSION="${STAMP}-nogit"
    fi
fi

TAG="${IMAGE}:${VERSION}"
SAFE_VERSION="$(echo "$VERSION" | sed 's/[^A-Za-z0-9._-]/_/g')"
RELEASE_DIR="${REPO_ROOT}/release"
mkdir -p "$RELEASE_DIR"

TAR_PATH="${RELEASE_DIR}/${IMAGE}-${SAFE_VERSION}.tar"
GZ_PATH="${TAR_PATH}.gz"
SHA_PATH="${GZ_PATH}.sha256"
README_PATH="${RELEASE_DIR}/README-offline-${SAFE_VERSION}.md"

echo "[1/4] docker build $TAG (platform=$PLATFORM)"
docker build \
    --platform "$PLATFORM" \
    --build-arg "VERSION=${VERSION}" \
    -t "$TAG" \
    -f Dockerfile \
    .

echo "[2/4] docker save -> $TAR_PATH"
docker save -o "$TAR_PATH" "$TAG"

echo "[3/4] gzip 압축 -> $GZ_PATH"
gzip -9 -f "$TAR_PATH"

if command -v sha256sum >/dev/null 2>&1; then
    (cd "$RELEASE_DIR" && sha256sum "$(basename "$GZ_PATH")" > "$SHA_PATH")
elif command -v shasum >/dev/null 2>&1; then
    (cd "$RELEASE_DIR" && shasum -a 256 "$(basename "$GZ_PATH")" > "$SHA_PATH")
else
    echo "sha256sum / shasum 둘 다 없음 - 체크섬 생략" >&2
fi

SHA_VALUE=""
if [[ -f "$SHA_PATH" ]]; then
    SHA_VALUE="$(awk '{print $1}' "$SHA_PATH")"
fi

echo "[4/4] 오프라인 가이드 생성 -> $README_PATH"
GZ_NAME="$(basename "$GZ_PATH")"
SHA_NAME="$(basename "$SHA_PATH")"
cat > "$README_PATH" <<EOF
# AI 코딩 프록시 게이트웨이 - 오프라인 배포 패키지

- 버전: ${VERSION}
- 이미지: ${TAG}
- 플랫폼: ${PLATFORM}
- 파일: ${GZ_NAME}
- SHA256: ${SHA_VALUE}

## 폐쇄망 적재 절차

1. 무결성 확인

   \`\`\`bash
   sha256sum -c ${SHA_NAME}
   \`\`\`

2. 이미지 적재

   \`\`\`bash
   gunzip -c ${GZ_NAME} | docker load
   \`\`\`

3. 실행 (SQLite 파일을 호스트 볼륨에 보관)

   \`\`\`bash
   docker run -d --name proxy-gateway --restart=always \\
       -p 8080:8080 \\
       -v /opt/proxy-gateway/data:/data \\
       -e UPSTREAM_BASE_URL=https://api.openai.com \\
       -e UPSTREAM_API_KEY=sk-... \\
       -e ADMIN_TOKEN=change-me \\
       -e GATEWAY_SECRET=\$(openssl rand -hex 32) \\
       -e MODEL_PRICING_KRW_PER_1M='{"gpt-4.1-mini":{"input_krw_per_1m":540,"output_krw_per_1m":2160}}' \\
       ${TAG}
   \`\`\`

4. 관리자 UI

   - http://<host>:8080/admin
   - 토큰은 ADMIN_TOKEN 값
EOF

echo
echo "릴리즈 완료"
echo "  이미지   : $TAG"
echo "  파일     : $GZ_PATH"
echo "  SHA256   : ${SHA_PATH:-생략}"
echo "  가이드   : $README_PATH"
