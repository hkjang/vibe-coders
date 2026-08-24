#!/usr/bin/env bash
# 릴리즈가 규약대로 나갔는지 확인한다.
#
# 릴리즈는 노트만으로 끝나지 않는다: 오프라인 배포 패키지 3종과 annotated 태그가
# 함께 있어야 한다. 이 스크립트가 없던 동안 23개 릴리즈가 자산 없이 나갔고,
# 아무도 실패하지 않았기 때문에 사용자가 지적할 때까지 드러나지 않았다.
#
# 사용법:
#   ./scripts/verify_release.sh v0.77.2     # 한 개 확인 (릴리즈 직후 pre-flight)
#   ./scripts/verify_release.sh --all       # 전체 감사
#   ./scripts/verify_release.sh --all --quiet   # 문제 있는 것만
set -uo pipefail

REPO="hkjang/vibe-coders"
IMAGE="ai-coding-proxy-gateway"
QUIET=0
ALL=0
VERSIONS=()

for arg in "$@"; do
    case "$arg" in
        --all)   ALL=1 ;;
        --quiet) QUIET=1 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) VERSIONS+=("$arg") ;;
    esac
done

if ! command -v gh >/dev/null 2>&1; then
    echo "gh CLI 가 PATH 에 없습니다." >&2
    exit 2
fi

if [[ "$ALL" == "1" ]]; then
    mapfile -t VERSIONS < <(gh release list --repo "$REPO" --limit 200 --json tagName --jq '.[].tagName')
fi

if [[ ${#VERSIONS[@]} -eq 0 ]]; then
    echo "확인할 버전이 없습니다. 예: $0 v0.77.2  또는  $0 --all" >&2
    exit 2
fi

FAILED=0
for v in "${VERSIONS[@]}"; do
    problems=()

    # 1) 자산 3종. 이름까지 확인한다 — 개수만 맞고 엉뚱한 파일이 붙는 경우를 걸러야 한다.
    assets="$(gh release view "$v" --repo "$REPO" --json assets --jq '.assets[].name' 2>/dev/null)"
    for want in "${IMAGE}-${v}.tar.gz" "${IMAGE}-${v}.tar.gz.sha256" "README-offline-${v}.md"; do
        grep -qxF "$want" <<<"$assets" || problems+=("자산 없음: $want")
    done

    # 2) annotated 태그. gh release create 는 lightweight 태그를 만들므로,
    #    git tag -a 를 먼저 하지 않으면 조용히 종류가 달라진다.
    if git rev-parse -q --verify "refs/tags/$v" >/dev/null 2>&1; then
        [[ "$(git cat-file -t "$v" 2>/dev/null)" == "tag" ]] || problems+=("태그가 lightweight (git tag -a 로 만들어야 함)")
    else
        problems+=("로컬에 태그 없음 (git fetch --tags 후 재확인)")
    fi

    if [[ ${#problems[@]} -eq 0 ]]; then
        [[ "$QUIET" == "1" ]] || printf "  OK   %s\n" "$v"
    else
        FAILED=$((FAILED+1))
        printf "  FAIL %s\n" "$v"
        for p in "${problems[@]}"; do printf "         - %s\n" "$p"; done
    fi
done

echo
if [[ "$FAILED" -gt 0 ]]; then
    echo "규약을 만족하지 못한 릴리즈: ${FAILED}개"
    exit 1
fi
echo "확인한 릴리즈 ${#VERSIONS[@]}개 모두 규약을 만족합니다."
