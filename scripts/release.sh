#!/usr/bin/env bash
# 오프라인 배포용 Docker 이미지를 빌드하고 tar.gz 로 패키징한다.
#
# 사용법:
#   ./scripts/release.sh [-v VERSION] [-i IMAGE] [-p PLATFORM]
#
# 예:
#   ./scripts/release.sh -v v0.83.0
#   ./scripts/release.sh -v v0.83.0 -p linux/arm64
set -euo pipefail

IMAGE="ai-coding-proxy-gateway"
PLATFORM="linux/amd64"
VERSION=""

# v0.80.0 introduced the embedded React console and the corresponding
# application SBOM/frontend-license release contract. A prerelease of exactly
# v0.80.0 remains below the cutoff; later patch prereleases are above it.
requires_compliance_assets() {
    local raw="${1#v}"
    local core prerelease="" major minor patch extra

    raw="${raw%%+*}"
    if [[ "$raw" == *-* ]]; then
        prerelease="${raw#*-}"
        core="${raw%%-*}"
    else
        core="$raw"
    fi
    IFS='.' read -r major minor patch extra <<<"$core"
    [[ -z "${extra:-}" && "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] || return 1

    local major_num=$((10#$major))
    local minor_num=$((10#$minor))
    local patch_num=$((10#$patch))
    (( major_num > 0 )) && return 0
    (( minor_num > 80 )) && return 0
    (( minor_num < 80 )) && return 1
    (( patch_num > 0 )) && return 0
    [[ -z "$prerelease" ]]
}

is_semver_release() {
    [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]
}

verify_release_source() {
    local version="$1" status head tag_commit remote_commit remote_master ci_success_count
    status="$(git status --porcelain=v1 --untracked-files=all)"
    if [[ -n "$status" ]]; then
        echo "정식 릴리즈는 깨끗한 소스 트리에서만 빌드할 수 있습니다." >&2
        printf '%s\n' "$status" >&2
        return 1
    fi
    head="$(git rev-parse HEAD)"
    if [[ "$(git cat-file -t "refs/tags/$version" 2>/dev/null || true)" != "tag" ]]; then
        echo "$version 로컬 annotated tag가 필요합니다." >&2
        return 1
    fi
    tag_commit="$(git rev-list -n 1 "$version")"
    if [[ "$tag_commit" != "$head" ]]; then
        echo "$version 태그가 현재 HEAD($head)를 가리키지 않습니다." >&2
        return 1
    fi
    remote_commit="$(git ls-remote --tags origin "refs/tags/$version^{}" | awk 'NR == 1 {print $1}')"
    if [[ -z "$remote_commit" || "$remote_commit" != "$head" ]]; then
        echo "origin의 annotated tag $version가 현재 HEAD($head)를 가리켜야 합니다." >&2
        return 1
    fi
    remote_master="$(git ls-remote --heads origin refs/heads/master | awk 'NR == 1 {print $1}')"
    if [[ -z "$remote_master" || "$remote_master" != "$head" ]]; then
        echo "정식 릴리즈 커밋은 origin/master HEAD여야 합니다 (origin/master=${remote_master:-missing}, HEAD=$head)." >&2
        return 1
    fi
    if ! command -v gh >/dev/null 2>&1; then
        echo "정식 릴리즈에는 origin/master CI 성공 확인을 위한 gh CLI가 필요합니다." >&2
        return 1
    fi
    if ! ci_success_count="$(gh run list --repo hkjang/vibe-coders --workflow CI --commit "$head" --limit 20 \
        --json conclusion,event,headSha,status \
        --jq "[.[] | select(.event == \"push\" and .headSha == \"$head\" and .status == \"completed\" and .conclusion == \"success\")] | length" \
        2>/dev/null)"; then
        echo "GitHub CI 상태를 조회하지 못했습니다." >&2
        return 1
    fi
    if [[ ! "$ci_success_count" =~ ^[0-9]+$ || "$ci_success_count" == "0" ]]; then
        echo "origin/master 커밋 $head의 성공한 push CI가 없습니다. CI 완료 후 다시 실행하십시오." >&2
        return 1
    fi
    RELEASE_SOURCE_COMMIT="$head"
}

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
for smoke_dependency in curl python3 grype; do
    if ! command -v "$smoke_dependency" >/dev/null 2>&1; then
        echo "릴리즈 검증 필수 도구가 PATH 에 없습니다: $smoke_dependency" >&2
        exit 1
    fi
done

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

RELEASE_SOURCE_COMMIT="$(git rev-parse HEAD 2>/dev/null || printf 'unknown')"
if is_semver_release "$VERSION"; then
    verify_release_source "$VERSION"
fi

TAG="${IMAGE}:${VERSION}"
SAFE_VERSION="$(echo "$VERSION" | sed 's/[^A-Za-z0-9._-]/_/g')"
RELEASE_DIR="${REPO_ROOT}/release"
mkdir -p "$RELEASE_DIR"

REQUIRES_COMPLIANCE=0
TOTAL_STEPS=4
if requires_compliance_assets "$VERSION"; then
    REQUIRES_COMPLIANCE=1
    TOTAL_STEPS=5
fi

TAR_PATH="${RELEASE_DIR}/${IMAGE}-${SAFE_VERSION}.tar"
GZ_PATH="${TAR_PATH}.gz"
SHA_PATH="${GZ_PATH}.sha256"
README_PATH="${RELEASE_DIR}/README-offline-${SAFE_VERSION}.md"
SBOM_SOURCE="${REPO_ROOT}/SBOM.spdx.json"
LICENSE_SOURCE="${REPO_ROOT}/THIRD_PARTY_LICENSES.md"
SBOM_PATH="${RELEASE_DIR}/SBOM-${SAFE_VERSION}.spdx.json"
LICENSE_PATH="${RELEASE_DIR}/THIRD_PARTY_LICENSES-${SAFE_VERSION}.md"
INIT_SOURCE="${REPO_ROOT}/scripts/init-deployment-env.sh"
BACKUP_SOURCE="${REPO_ROOT}/scripts/backup-volume.sh"
INIT_PATH="${RELEASE_DIR}/init-deployment-env-${SAFE_VERSION}.sh"
BACKUP_PATH="${RELEASE_DIR}/backup-volume-${SAFE_VERSION}.sh"

if [[ "$REQUIRES_COMPLIANCE" == "1" ]]; then
    [[ -s "$SBOM_SOURCE" ]] || { echo "SBOM source is missing or empty: $SBOM_SOURCE" >&2; exit 1; }
    [[ -s "$LICENSE_SOURCE" ]] || { echo "license source is missing or empty: $LICENSE_SOURCE" >&2; exit 1; }
    [[ -s "$INIT_SOURCE" ]] || { echo "deployment env helper is missing or empty: $INIT_SOURCE" >&2; exit 1; }
    [[ -s "$BACKUP_SOURCE" ]] || { echo "volume backup helper is missing or empty: $BACKUP_SOURCE" >&2; exit 1; }

    VERSION_INFO="${VERSION#v}"
    python3 - "$SBOM_SOURCE" "$VERSION_INFO" <<'PY'
import json
import sys

path, expected_version = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    document = json.load(handle)
if document.get("spdxVersion") != "SPDX-2.3":
    raise SystemExit("SBOM.spdx.json must use SPDX-2.3")
packages = document.get("packages", [])
application = next((item for item in packages if item.get("name") == "vibe-coders"), None)
if application is None or application.get("versionInfo") != expected_version:
    raise SystemExit(
        f"SBOM application versionInfo must be {expected_version!r}; regenerate SBOM.spdx.json"
    )
locators = [
    ref.get("referenceLocator", "")
    for package in packages
    for ref in package.get("externalRefs", [])
]
if not any(value.startswith("pkg:golang/") for value in locators):
    raise SystemExit("SBOM.spdx.json does not contain a Go package purl")
if not any(value.startswith("pkg:npm/") for value in locators):
    raise SystemExit("SBOM.spdx.json does not contain an npm package purl")
PY
    grep -Eiq '(npm|pnpm|react|frontend|프론트엔드)' "$LICENSE_SOURCE" || {
        echo "THIRD_PARTY_LICENSES.md must include the frontend license inventory." >&2
        exit 1
    }
fi

echo "[1/${TOTAL_STEPS}] docker build $TAG (platform=$PLATFORM)"
docker build \
    --platform "$PLATFORM" \
    --build-arg "VERSION=${VERSION}" \
    --build-arg "VCS_REF=${RELEASE_SOURCE_COMMIT}" \
    -t "$TAG" \
    -f Dockerfile \
    .

echo "[verify] embedded /app assets, deep links, and build version"
bash "${REPO_ROOT}/scripts/container-smoke.sh" "$TAG" "$VERSION" "$RELEASE_SOURCE_COMMIT"

echo "[verify] final image high and critical vulnerability gate"
bash "${REPO_ROOT}/scripts/scan-container-image.sh" "$TAG"

echo "[2/${TOTAL_STEPS}] docker save -> $TAR_PATH"
docker save -o "$TAR_PATH" "$TAG"

echo "[3/${TOTAL_STEPS}] gzip 압축 -> $GZ_PATH"
gzip -9 -f "$TAR_PATH"

if command -v sha256sum >/dev/null 2>&1; then
    SHA_VALUE="$(sha256sum "$GZ_PATH" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
    SHA_VALUE="$(shasum -a 256 "$GZ_PATH" | awk '{print $1}')"
else
    echo "sha256sum / shasum 둘 다 없어 필수 체크섬을 생성할 수 없습니다." >&2
    exit 1
fi

echo "[4/${TOTAL_STEPS}] 오프라인 가이드 생성 -> $README_PATH"
GZ_NAME="$(basename "$GZ_PATH")"
SHA_NAME="$(basename "$SHA_PATH")"
INIT_NAME="$(basename "$INIT_PATH")"
BACKUP_NAME="$(basename "$BACKUP_PATH")"
cat > "$README_PATH" <<EOF
# AI 코딩 프록시 게이트웨이 - 오프라인 배포 패키지

- 버전: ${VERSION}
- 소스 커밋: ${RELEASE_SOURCE_COMMIT}
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

3. 최초 1회 비밀값 파일과 데이터 볼륨 준비

   \`\`\`bash
   ENV_FILE=/opt/proxy-gateway/gateway.env
   install -d -m 0700 "\$(dirname "\$ENV_FILE")" || exit 1
   command -v openssl >/dev/null 2>&1 || { echo "openssl이 필요합니다." >&2; exit 1; }
   if [ ! -e "\$ENV_FILE" ]; then
       umask 077
       ADMIN_TOKEN_VALUE="\$(openssl rand -hex 32)" || exit 1
       GATEWAY_SECRET_VALUE="\$(openssl rand -hex 32)" || exit 1
       [ "\${#ADMIN_TOKEN_VALUE}" -eq 64 ] && [ "\${#GATEWAY_SECRET_VALUE}" -eq 64 ] || exit 1
       printf '%s\n' "\$ADMIN_TOKEN_VALUE" | grep -Eq '^[0-9A-Fa-f]{64}$' &&
           printf '%s\n' "\$GATEWAY_SECRET_VALUE" | grep -Eq '^[0-9A-Fa-f]{64}$' || exit 1
       UPSTREAM_API_KEY_VALUE="\${UPSTREAM_API_KEY:-}"
       if [ -z "\$UPSTREAM_API_KEY_VALUE" ]; then
           read -r -s -p 'Upstream API key: ' UPSTREAM_API_KEY_VALUE || exit 1
           echo
       fi
       case "\$UPSTREAM_API_KEY_VALUE" in
           ''|*[!A-Za-z0-9._~:/+=-]*) echo 'UPSTREAM_API_KEY 형식이 안전하지 않습니다.' >&2; exit 1 ;;
       esac
       ENV_TMP="\$(mktemp "\${ENV_FILE}.tmp.XXXXXX")" || exit 1
       trap 'rm -f -- "\$ENV_TMP"' EXIT HUP INT TERM
       printf '%s\n' \\
           'UPSTREAM_BASE_URL=https://api.openai.com' \\
           "UPSTREAM_API_KEY=\${UPSTREAM_API_KEY_VALUE}" \\
           "GATEWAY_VERSION=${VERSION}" \\
           "ADMIN_TOKEN=\${ADMIN_TOKEN_VALUE}" \\
           "GATEWAY_SECRET=\${GATEWAY_SECRET_VALUE}" \\
           'UI_APP_ENABLED=false' \\
           'MODEL_PRICING_KRW_PER_1M={"gpt-4.1-mini":{"input_krw_per_1m":540,"output_krw_per_1m":2160}}' \\
           > "\$ENV_TMP" || exit 1
       chmod 0600 "\$ENV_TMP" && mv -f -- "\$ENV_TMP" "\$ENV_FILE" || exit 1
       trap - EXIT HUP INT TERM
   fi
   chmod 0600 "\$ENV_FILE" || exit 1
   [ "\$(grep -Ec '^ADMIN_TOKEN=' "\$ENV_FILE")" -eq 1 ] &&
       grep -Eq '^ADMIN_TOKEN=[0-9A-Fa-f]{64}$' "\$ENV_FILE" &&
       [ "\$(grep -Ec '^GATEWAY_SECRET=' "\$ENV_FILE")" -eq 1 ] &&
       grep -Eq '^GATEWAY_SECRET=[0-9A-Fa-f]{64}$' "\$ENV_FILE" &&
       [ "\$(grep -Ec '^UPSTREAM_API_KEY=' "\$ENV_FILE")" -eq 1 ] &&
       grep -Eq '^UPSTREAM_API_KEY=[A-Za-z0-9._~:/+=-]+$' "\$ENV_FILE" &&
       ! grep -q '^UPSTREAM_API_KEY=replace-before-start$' "\$ENV_FILE" &&
       [ "\$(grep -Ec '^GATEWAY_VERSION=' "\$ENV_FILE")" -eq 1 ] &&
       grep -qxF 'GATEWAY_VERSION=${VERSION}' "\$ENV_FILE" ||
       { echo "gateway.env의 필수 비밀값이 유효하지 않습니다." >&2; exit 1; }
   docker volume create proxy-gateway-data >/dev/null || exit 1
   docker run -d --name proxy-gateway --restart=always \\
       -p 8080:8080 \\
       --mount source=proxy-gateway-data,target=/data \\
       --env-file "\$ENV_FILE" \\
       ${TAG}
   \`\`\`

   \`ADMIN_TOKEN\`과 \`GATEWAY_SECRET\`은 최초 1회만 생성하고 env 파일과 데이터 볼륨을 함께 백업하십시오.
   컨테이너를 재생성할 때도 같은 env 파일을 사용해야 저장된 Provider Secret을 복호화할 수 있습니다.
   함께 제공된 \`${INIT_NAME}\`은 신규 env를 원자 생성하거나 기존 env를 fail-closed로
   검증한 뒤 요청한 \`GATEWAY_VERSION\`만 원자 갱신합니다. secret은 회전하지 않습니다.
   사용 전 \`chmod 0700 ${INIT_NAME} ${BACKUP_NAME}\`을 실행하십시오.

4. 관리자 UI

   - Legacy Stable Console: http://<host>:8080/admin
   - Next Console Preview: http://<host>:8080/app/
   - \`/app\`은 기본 OFF입니다. Preview를 사용하려면 \`UI_APP_ENABLED=true\`로 실행합니다.
   - 토큰은 ADMIN_TOKEN 값
   - React 정적 에셋은 Go 바이너리에 포함되며 운영 컨테이너에는 Node.js가 없습니다.

5. UI와 Deep Link 확인

   \`\`\`bash
   curl -fsSI http://<host>:8080/app
   curl -fsS http://<host>:8080/app/providers >/dev/null
   curl -fsS http://<host>:8080/admin >/dev/null
   \`\`\`

6. named volume과 env 백업

   \`\`\`bash
   sudo install -d -m 0700 /opt/proxy-gateway/backups
   docker stop proxy-gateway
   sudo ./${BACKUP_NAME} backup \
       --image ${TAG} \
       --volume proxy-gateway-data \
       --env-file /opt/proxy-gateway/gateway.env \
       --output-dir /opt/proxy-gateway/backups
   docker start proxy-gateway
   \`\`\`

   archive와 sidecar를 함께 암호화 보관하십시오. 복구는 컨테이너를 제거한 뒤
   \`./${BACKUP_NAME} restore --help\`의 검증·확인 절차를 따릅니다. 수동 volume 삭제로
   이 절차를 우회하지 마십시오.
EOF

if [[ "$REQUIRES_COMPLIANCE" == "1" ]]; then
    echo "[5/${TOTAL_STEPS}] SBOM / license / 운영 helper 자산 생성"
    cp "$SBOM_SOURCE" "$SBOM_PATH"
    cp "$LICENSE_SOURCE" "$LICENSE_PATH"
    cp "$INIT_SOURCE" "$INIT_PATH"
    cp "$BACKUP_SOURCE" "$BACKUP_PATH"
    chmod 0755 "$INIT_PATH" "$BACKUP_PATH"
    cmp -s "$SBOM_SOURCE" "$SBOM_PATH" || { echo "staged SBOM differs from canonical source" >&2; exit 1; }
    cmp -s "$LICENSE_SOURCE" "$LICENSE_PATH" || { echo "staged license inventory differs from canonical source" >&2; exit 1; }
    cmp -s "$INIT_SOURCE" "$INIT_PATH" || { echo "staged deployment env helper differs from canonical source" >&2; exit 1; }
    cmp -s "$BACKUP_SOURCE" "$BACKUP_PATH" || { echo "staged volume backup helper differs from canonical source" >&2; exit 1; }
    cat >> "$README_PATH" <<EOF

## 컴플라이언스 자산

- $(basename "$SBOM_PATH") — ${VERSION} Go+npm 통합 SPDX SBOM
- $(basename "$LICENSE_PATH") — Go 및 Frontend 제3자 라이선스 목록
- $(basename "$INIT_PATH") — fail-closed 운영 env 생성·검증 helper
- $(basename "$BACKUP_PATH") — named volume과 env 무결성 백업·복구 helper

네 파일도 이미지 패키지와 함께 폐쇄망으로 전달하십시오.
EOF
fi

# The checksum asset covers every independently meaningful payload. It cannot
# include a digest of itself, so the manifest file is verified structurally.
MANIFEST_FILES=("$(basename "$GZ_PATH")" "$(basename "$README_PATH")")
if [[ "$REQUIRES_COMPLIANCE" == "1" ]]; then
    MANIFEST_FILES+=("$(basename "$SBOM_PATH")" "$(basename "$LICENSE_PATH")" "$(basename "$INIT_PATH")" "$(basename "$BACKUP_PATH")")
fi
if command -v sha256sum >/dev/null 2>&1; then
    (cd "$RELEASE_DIR" && sha256sum "${MANIFEST_FILES[@]}" > "$(basename "$SHA_PATH")")
else
    (cd "$RELEASE_DIR" && shasum -a 256 "${MANIFEST_FILES[@]}" > "$(basename "$SHA_PATH")")
fi

echo
echo "릴리즈 완료"
echo "  이미지   : $TAG"
echo "  파일     : $GZ_PATH"
echo "  SHA256   : ${SHA_PATH:-생략}"
echo "  가이드   : $README_PATH"
if [[ "$REQUIRES_COMPLIANCE" == "1" ]]; then
    echo "  SBOM     : $SBOM_PATH"
    echo "  라이선스 : $LICENSE_PATH"
    echo "  Env helper: $INIT_PATH"
    echo "  백업 helper: $BACKUP_PATH"
fi
