#!/usr/bin/env bash
# 릴리즈가 규약대로 나갔는지 확인한다.
#
# 릴리즈는 노트만으로 끝나지 않는다: 기존 오프라인 배포 패키지 3종과 annotated
# 태그가 함께 있어야 한다. v0.80.0부터는 SBOM·라이선스·운영 helper를 더한 7종을 요구한다.
# 이 스크립트가 없던 동안 23개 릴리즈가 자산 없이 나갔고,
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

# SemVer cutoff for the seven-asset Phase 0 contract. A prerelease of exactly
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
    release_list="$(gh release list --repo "$REPO" --limit 200 --json tagName --jq '.[].tagName')"
    release_list_status=$?
    if [[ "$release_list_status" -ne 0 ]]; then
        echo "GitHub Release 목록 조회 실패" >&2
        exit "$release_list_status"
    fi
    VERSIONS=()
    while IFS= read -r release_version; do
        release_version="${release_version%$'\r'}"
        [[ -z "$release_version" ]] || VERSIONS+=("$release_version")
    done <<<"$release_list"
fi

if [[ ${#VERSIONS[@]} -eq 0 ]]; then
    echo "확인할 버전이 없습니다. 예: $0 v0.77.2  또는  $0 --all" >&2
    exit 2
fi

FAILED=0
for v in "${VERSIONS[@]}"; do
    problems=()

    # 1) 기존 릴리즈는 3종, v0.80.0부터는 SBOM·라이선스·운영 helper를 포함한 7종이다.
    # 이름까지 확인한다 — 개수만 맞고 엉뚱한 파일이 붙는 경우를 걸러야 한다.
    if ! assets="$(gh release view "$v" --repo "$REPO" --json assets --jq '.assets[].name' 2>/dev/null)"; then
        assets=""
        problems+=("GitHub Release 조회 실패")
    fi
    if release_state="$(gh release view "$v" --repo "$REPO" --json isDraft,publishedAt --jq '[.isDraft, .publishedAt] | @tsv' 2>/dev/null)"; then
        IFS=$'\t' read -r is_draft published_at <<<"$release_state"
        [[ "$is_draft" == "false" ]] || problems+=("릴리즈가 draft 상태")
        [[ -n "$published_at" && "$published_at" != "null" ]] || problems+=("릴리즈 publishedAt 없음")
    else
        problems+=("릴리즈 게시 상태 조회 실패")
    fi
    required_assets=("${IMAGE}-${v}.tar.gz" "${IMAGE}-${v}.tar.gz.sha256" "README-offline-${v}.md")
    if requires_compliance_assets "$v"; then
        required_assets+=("SBOM-${v}.spdx.json" "THIRD_PARTY_LICENSES-${v}.md" "init-deployment-env-${v}.sh" "backup-volume-${v}.sh")
    fi
    for want in "${required_assets[@]}"; do
        grep -qxF "$want" <<<"$assets" || problems+=("자산 없음: $want")
    done
    while IFS= read -r have; do
        [[ -n "$have" ]] || continue
        expected_asset=0
        for want in "${required_assets[@]}"; do
            if [[ "$have" == "$want" ]]; then
                expected_asset=1
                break
            fi
        done
        [[ "$expected_asset" == "1" ]] || problems+=("예상 밖 미검증 자산: $have")
    done <<<"$assets"

    # 2) annotated 태그. gh release create 는 lightweight 태그를 만들므로,
    #    git tag -a 를 먼저 하지 않으면 조용히 종류가 달라진다.
    local_tag_commit=""
    if git rev-parse -q --verify "refs/tags/$v" >/dev/null 2>&1; then
        if [[ "$(git cat-file -t "$v" 2>/dev/null)" == "tag" ]]; then
            local_tag_commit="$(git rev-list -n 1 "$v" 2>/dev/null)"
            remote_tag_commit="$(git ls-remote --tags origin "refs/tags/$v^{}" 2>/dev/null | awk 'NR == 1 {print $1}')"
            if [[ -z "$remote_tag_commit" ]]; then
                problems+=("origin에 peeled annotated 태그 없음")
            elif [[ "$remote_tag_commit" != "$local_tag_commit" ]]; then
                problems+=("로컬·origin 태그 커밋 불일치: ${local_tag_commit:-missing} != $remote_tag_commit")
            fi
        else
            problems+=("태그가 lightweight (git tag -a 로 만들어야 함)")
        fi
    else
        problems+=("로컬에 태그 없음 (git fetch --tags 후 재확인)")
    fi

    # 3) 방금 낸 단일 릴리즈는 실제 업로드된 모든 자산을 다시 내려받아 checksum
    #    manifest, tagged canonical SBOM/license, 내용 계약을 검증한다. --all 감사는
    #    대용량 과거 archive를 내려받지 않고 이름·게시 상태·원격 태그만 확인한다.
    archive_name="${IMAGE}-${v}.tar.gz"
    checksum_name="${archive_name}.sha256"
    if [[ "$ALL" != "1" ]] && grep -qxF "$archive_name" <<<"$assets" && grep -qxF "$checksum_name" <<<"$assets"; then
        verify_tmp_base="${TMPDIR:-/tmp}"
        verify_tmp_base="${verify_tmp_base%/}"
        verify_tmp_dir="$(mktemp -d "${verify_tmp_base}/vibe-release-verify.XXXXXX")"
        download_args=(--pattern "$archive_name" --pattern "$checksum_name")
        expected_payloads=("$archive_name")
        if requires_compliance_assets "$v"; then
            download_args+=(--pattern "README-offline-${v}.md" --pattern "SBOM-${v}.spdx.json" --pattern "THIRD_PARTY_LICENSES-${v}.md" --pattern "init-deployment-env-${v}.sh" --pattern "backup-volume-${v}.sh")
            expected_payloads+=("README-offline-${v}.md" "SBOM-${v}.spdx.json" "THIRD_PARTY_LICENSES-${v}.md" "init-deployment-env-${v}.sh" "backup-volume-${v}.sh")
        fi
        if ! gh release download "$v" --repo "$REPO" --dir "$verify_tmp_dir" "${download_args[@]}" >/dev/null; then
            problems+=("업로드 자산 다운로드 실패")
        else
            manifest_payloads=()
            manifest_digest_values=()
            manifest_bad=0
            while read -r digest payload extra; do
                payload="${payload#\*}"
                payload="${payload%$'\r'}"
                manifest_duplicate=0
                for ((manifest_index = 0; manifest_index < ${#manifest_payloads[@]}; manifest_index += 1)); do
                    if [[ "${manifest_payloads[$manifest_index]}" == "$payload" ]]; then
                        manifest_duplicate=1
                        break
                    fi
                done
                if [[ ! "$digest" =~ ^[0-9A-Fa-f]{64}$ || -z "$payload" || -n "${extra:-}" || "$manifest_duplicate" == "1" ]]; then
                    manifest_bad=1
                    continue
                fi
                manifest_payloads+=("$payload")
                manifest_digest_values+=("$(printf '%s' "$digest" | tr '[:upper:]' '[:lower:]')")
            done < "$verify_tmp_dir/$checksum_name"
            if [[ "$manifest_bad" == "1" || "${#manifest_payloads[@]}" -ne "${#expected_payloads[@]}" ]]; then
                problems+=("업로드 체크섬 manifest 형식·항목 수 오류")
            fi

            actual_digest=""
            for payload in "${expected_payloads[@]}"; do
                manifest_digest=""
                manifest_found=0
                for ((manifest_index = 0; manifest_index < ${#manifest_payloads[@]}; manifest_index += 1)); do
                    if [[ "${manifest_payloads[$manifest_index]}" == "$payload" ]]; then
                        manifest_digest="${manifest_digest_values[$manifest_index]}"
                        manifest_found=1
                        break
                    fi
                done
                if [[ "$manifest_found" != "1" ]]; then
                    problems+=("체크섬 manifest 항목 없음: $payload")
                    continue
                fi
                if command -v sha256sum >/dev/null 2>&1; then
                    payload_digest="$(sha256sum "$verify_tmp_dir/$payload" | awk '{print tolower($1)}')"
                elif command -v shasum >/dev/null 2>&1; then
                    payload_digest="$(shasum -a 256 "$verify_tmp_dir/$payload" | awk '{print tolower($1)}')"
                else
                    payload_digest=""
                    problems+=("SHA256 계산 도구 없음")
                    break
                fi
                [[ "$manifest_digest" == "$payload_digest" ]] || problems+=("업로드 payload SHA256 불일치: $payload")
                [[ "$payload" == "$archive_name" ]] && actual_digest="$payload_digest"
            done

            if requires_compliance_assets "$v"; then
                guide_path="$verify_tmp_dir/README-offline-${v}.md"
                if [[ -n "$local_tag_commit" ]]; then
                    grep -qF "$local_tag_commit" "$guide_path" || problems+=("오프라인 가이드에 태그 커밋 없음")
                fi
                [[ -z "$actual_digest" ]] || grep -qiF "$actual_digest" "$guide_path" || problems+=("오프라인 가이드에 archive digest 없음")
                sbom_path="$verify_tmp_dir/SBOM-${v}.spdx.json"
                license_path="$verify_tmp_dir/THIRD_PARTY_LICENSES-${v}.md"
                init_path="$verify_tmp_dir/init-deployment-env-${v}.sh"
                backup_path="$verify_tmp_dir/backup-volume-${v}.sh"
                if [[ -n "$local_tag_commit" ]]; then
                    git show "$v:SBOM.spdx.json" | cmp -s - "$sbom_path" || problems+=("업로드 SBOM이 tagged canonical 파일과 다름")
                    git show "$v:THIRD_PARTY_LICENSES.md" | cmp -s - "$license_path" || problems+=("업로드 라이선스가 tagged canonical 파일과 다름")
                    git show "$v:scripts/init-deployment-env.sh" | cmp -s - "$init_path" || problems+=("업로드 env helper가 tagged canonical 파일과 다름")
                    git show "$v:scripts/backup-volume.sh" | cmp -s - "$backup_path" || problems+=("업로드 백업 helper가 tagged canonical 파일과 다름")
                fi
                bash -n "$init_path" || problems+=("업로드 env helper Bash 구문 오류")
                bash -n "$backup_path" || problems+=("업로드 백업 helper Bash 구문 오류")
                if command -v python3 >/dev/null 2>&1; then
                    if ! python3 - "$sbom_path" "${v#v}" <<'PY'
import json
import sys

path, expected_version = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    document = json.load(handle)
if document.get("spdxVersion") != "SPDX-2.3":
    raise SystemExit(1)
packages = document.get("packages", [])
application = next((item for item in packages if item.get("name") == "vibe-coders"), None)
if application is None or application.get("versionInfo") != expected_version:
    raise SystemExit(1)
locators = [
    ref.get("referenceLocator", "")
    for package in packages
    for ref in package.get("externalRefs", [])
]
if not any(value.startswith("pkg:golang/") for value in locators):
    raise SystemExit(1)
if not any(value.startswith("pkg:npm/") for value in locators):
    raise SystemExit(1)
PY
                    then
                        problems+=("업로드 SBOM SPDX·버전·Go/npm purl 계약 오류")
                    fi
                else
                    problems+=("SBOM 내용 검증용 python3 없음")
                fi
                grep -Eiq '(npm|pnpm|react|frontend|프론트엔드)' "$license_path" || problems+=("업로드 라이선스에 frontend inventory 없음")
            fi
            unset manifest_payloads manifest_digest_values
        fi
        case "$verify_tmp_dir" in
            "${verify_tmp_base}"/vibe-release-verify.*) rm -rf -- "$verify_tmp_dir" ;;
            *) problems+=("임시 검증 디렉터리 정리 거부: $verify_tmp_dir") ;;
        esac
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
