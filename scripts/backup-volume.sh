#!/usr/bin/env bash
# Back up or restore the Docker named volume used by the gateway.
# The distroless gateway image is used only as a stopped carrier container.
set -Eeuo pipefail

umask 077

DEFAULT_VOLUME="proxy-gateway-data"
MODE="${1:-}"
if [[ "$MODE" == "-h" || "$MODE" == "--help" ]]; then
    MODE=""
fi
if [[ -n "$MODE" ]]; then
    shift
fi

VOLUME="$DEFAULT_VOLUME"
IMAGE=""
ENV_FILE="/opt/proxy-gateway/gateway.env"
OUTPUT_DIR="backups"
ARCHIVE=""
CONFIRMATION=""
RESTORE_ENV=false

usage() {
    cat <<'EOF'
Usage:
  scripts/backup-volume.sh backup --image IMAGE [options]
  scripts/backup-volume.sh restore --image IMAGE --archive FILE [options]

Options:
  --volume NAME       Docker volume (default: proxy-gateway-data)
  --env-file FILE     gateway.env path (default: /opt/proxy-gateway/gateway.env)
  --output-dir DIR    backup/safety-backup directory (default: backups)
  --restore-env       restore gateway.env from the archive (restore only)
  --confirm PHRASE    non-interactive restore confirmation; must be exactly
                      "RESTORE <volume>"
  -h, --help          show this help

The gateway must be stopped before backup and its container must be removed
before restore. Archives contain gateway.env secrets and are written mode 0600.
EOF
}

if [[ -z "$MODE" && ( "${1:-}" == "-h" || "${1:-}" == "--help" ) ]]; then
    usage
    exit 0
fi

die() {
    echo "오류: $*" >&2
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --volume)
            [[ $# -ge 2 ]] || die "--volume 값이 필요합니다"
            VOLUME="$2"
            shift 2
            ;;
        --image)
            [[ $# -ge 2 ]] || die "--image 값이 필요합니다"
            IMAGE="$2"
            shift 2
            ;;
        --env-file)
            [[ $# -ge 2 ]] || die "--env-file 값이 필요합니다"
            ENV_FILE="$2"
            shift 2
            ;;
        --output-dir)
            [[ $# -ge 2 ]] || die "--output-dir 값이 필요합니다"
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --archive)
            [[ $# -ge 2 ]] || die "--archive 값이 필요합니다"
            ARCHIVE="$2"
            shift 2
            ;;
        --confirm)
            [[ $# -ge 2 ]] || die "--confirm 값이 필요합니다"
            CONFIRMATION="$2"
            shift 2
            ;;
        --restore-env)
            RESTORE_ENV=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "알 수 없는 인자: $1"
            ;;
    esac
done

[[ "$MODE" == "backup" || "$MODE" == "restore" ]] || {
    usage >&2
    exit 2
}
[[ -n "$IMAGE" ]] || die "--image에 로컬의 정확한 gateway 이미지 태그를 지정하세요"
[[ "$VOLUME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "안전하지 않은 volume 이름: $VOLUME"
[[ "$IMAGE" != *$'\n'* && "$IMAGE" != *$'\r'* ]] || die "안전하지 않은 image 이름"
image_component="${IMAGE##*/}"
[[ "$IMAGE" != "latest" && "$IMAGE" != *':latest' && \
   ( "$image_component" == *:* || "$IMAGE" == *@sha256:* ) ]] || \
    die "latest가 아닌 정확한 image tag 또는 digest가 필요합니다: $IMAGE"

for command_name in docker tar sha256sum stat head awk grep sed sort uniq mktemp date cmp install find dirname mv; do
    command -v "$command_name" >/dev/null 2>&1 || die "필수 명령을 찾을 수 없습니다: $command_name"
done

docker image inspect "$IMAGE" >/dev/null 2>&1 || die "로컬 image를 찾을 수 없습니다: $IMAGE"
image_title="$(
    docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.title"}}' "$IMAGE"
)" || die "image label을 확인할 수 없습니다: $IMAGE"
[[ "$image_title" == "vibe-coders" ]] || die "gateway image가 아닙니다 (OCI title: $image_title)"

TEMP_DIRS=()
TEMP_FILES=()
CARRIERS=()
SAFETY_ARCHIVE=""
NEW_TEMP_DIR=""
NEW_CARRIER=""
CREATED_ARCHIVE=""

cleanup() {
    local carrier temp_dir temp_file
    for carrier in "${CARRIERS[@]:-}"; do
        [[ -n "$carrier" ]] && docker rm -f "$carrier" >/dev/null 2>&1 || true
    done
    for temp_dir in "${TEMP_DIRS[@]:-}"; do
        [[ -n "$temp_dir" && "$temp_dir" == /tmp/vibe-volume-* ]] && rm -rf -- "$temp_dir"
    done
    for temp_file in "${TEMP_FILES[@]:-}"; do
        [[ -n "$temp_file" && "$temp_file" == *.restore.* ]] && rm -f -- "$temp_file"
    done
    return 0
}
trap cleanup EXIT

valid_env_file() {
    local file="$1" mode
    [[ -f "$file" && ! -L "$file" && -s "$file" ]] || return 1
    mode="$(stat -c '%a' "$file")"
    [[ "$mode" == "600" ]] || return 1
    [[ "$(grep -Ec '^ADMIN_TOKEN=' "$file")" -eq 1 ]] || return 1
    grep -Eq '^ADMIN_TOKEN=[0-9A-Fa-f]{64}$' "$file" || return 1
    [[ "$(grep -Ec '^GATEWAY_SECRET=' "$file")" -eq 1 ]] || return 1
    grep -Eq '^GATEWAY_SECRET=[0-9A-Fa-f]{64}$' "$file" || return 1
    [[ "$(grep -Ec '^UPSTREAM_API_KEY=' "$file")" -eq 1 ]] || return 1
    grep -Eq '^UPSTREAM_API_KEY=[A-Za-z0-9._~:/+=-]+$' "$file" || return 1
    grep -q '^UPSTREAM_API_KEY=replace-before-start$' "$file" && return 1
    [[ "$(grep -Ec '^GATEWAY_VERSION=' "$file")" -eq 1 ]] || return 1
    grep -Eq '^GATEWAY_VERSION=v[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$' "$file"
}

check_env_file() {
    local file="$1"
    valid_env_file "$file" || \
        die "$file 은 symlink가 아닌 0600 일반 파일이어야 하며 정확한 release와 유효한 ADMIN_TOKEN, GATEWAY_SECRET, UPSTREAM_API_KEY를 각각 하나 포함해야 합니다"
}

env_secret() {
    awk -F= '$1 == "GATEWAY_SECRET" { sub(/^[^=]*=/, ""); print; exit }' "$1"
}

inspect_volume() {
    docker volume inspect "$VOLUME" >/dev/null 2>&1 || die "Docker volume을 찾을 수 없습니다: $VOLUME"
    local actual driver options
    actual="$(docker volume inspect --format '{{.Name}}' "$VOLUME")"
    driver="$(docker volume inspect --format '{{.Driver}}' "$VOLUME")"
    options="$(docker volume inspect --format '{{json .Options}}' "$VOLUME")"
    [[ "$actual" == "$VOLUME" ]] || die "volume 이름 검증 실패: $actual"
    [[ "$driver" == "local" ]] || die "복구는 local volume만 지원합니다 (현재 $driver)"
    [[ "$options" == "null" || "$options" == "{}" ]] || die "driver option이 있는 volume은 자동 복구하지 않습니다"
}

running_volume_users() {
    docker ps -q --filter "volume=$VOLUME"
}

all_volume_users() {
    docker ps -aq --filter "volume=$VOLUME"
}

new_temp_dir() {
    NEW_TEMP_DIR="$(mktemp -d /tmp/vibe-volume-XXXXXXXX)"
    TEMP_DIRS+=("$NEW_TEMP_DIR")
}

new_carrier() {
    NEW_CARRIER="vibe-volume-carrier-$$-${RANDOM}"
    docker create --name "$NEW_CARRIER" \
        --mount "type=volume,source=$VOLUME,target=/data" \
        "$IMAGE" >/dev/null
    CARRIERS+=("$NEW_CARRIER")
}

remove_carrier() {
    local target="$1" carrier
    docker rm -f "$target" >/dev/null
    for carrier in "${!CARRIERS[@]}"; do
        if [[ "${CARRIERS[$carrier]}" == "$target" ]]; then
            CARRIERS[$carrier]=""
        fi
    done
}

valid_sqlite() {
    local database="$1" result
    [[ -s "$database" ]] || return 1
    [[ "$(head -c 15 "$database")" == "SQLite format 3" ]] || return 1
    if command -v sqlite3 >/dev/null 2>&1; then
        result="$(sqlite3 "$database" 'PRAGMA quick_check;' 2>/dev/null)" || return 1
        [[ "$result" == "ok" ]] || return 1
    fi
}

validate_payload_names() {
    local root="$1" entry relative
    while IFS= read -r -d '' entry; do
        relative="${entry#"$root"/}"
        [[ "$relative" =~ ^(data|config)(/[A-Za-z0-9._-]+)*$ ]] || \
            die "백업할 수 없는 파일 이름: $relative"
        [[ ! -L "$entry" && ( -d "$entry" || -f "$entry" ) ]] || \
            die "일반 파일/디렉터리가 아닌 항목: $relative"
    done < <(find "$root/data" "$root/config" -mindepth 0 -print0)
}

write_checksums() {
    local root="$1" entry relative
    : > "$root/SHA256SUMS"
    while IFS= read -r -d '' entry; do
        relative="${entry#"$root"/}"
        (cd "$root" && sha256sum "$relative") >> "$root/SHA256SUMS"
    done < <(find "$root/data" "$root/config" -type f -print0 | sort -z)
    [[ -s "$root/SHA256SUMS" ]] || die "checksum 대상이 없습니다"
}

create_volume_archive() {
    local prefix="$1" require_valid_database="$2" env_source="${3:-$ENV_FILE}" config_source="${4:-current_env}"
    local work carrier stamp final temp_archive digest database_valid output_mode
    new_temp_dir
    work="$NEW_TEMP_DIR"
    mkdir -p "$work/data" "$work/config"
    new_carrier
    carrier="$NEW_CARRIER"
    docker cp "$carrier:/data/." "$work/data"
    remove_carrier "$carrier"
    check_env_file "$env_source"
    install -m 0600 "$env_source" "$work/config/gateway.env"

    database_valid=false
    if valid_sqlite "$work/data/gateway.db"; then
        database_valid=true
    elif [[ "$require_valid_database" == "true" ]]; then
        die "volume의 gateway.db가 유효한 SQLite 파일이 아닙니다"
    fi

    validate_payload_names "$work"
    cat > "$work/manifest.txt" <<EOF
format=vibe-volume-backup-v1
source_volume=$VOLUME
source_image=$IMAGE
created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
database_valid=$database_valid
configuration_source=$config_source
EOF
    write_checksums "$work"

    [[ -n "$OUTPUT_DIR" && "$OUTPUT_DIR" != "/" && "$OUTPUT_DIR" != "." && "$OUTPUT_DIR" != ".." ]] || \
        die "output directory가 너무 광범위합니다: $OUTPUT_DIR"
    if [[ ! -e "$OUTPUT_DIR" ]]; then
        mkdir -p -- "$OUTPUT_DIR"
    fi
    [[ -d "$OUTPUT_DIR" && ! -L "$OUTPUT_DIR" ]] || die "output directory가 안전하지 않습니다: $OUTPUT_DIR"
    output_mode="$(stat -c '%a' "$OUTPUT_DIR")"
    [[ "$output_mode" == "700" ]] || \
        die "비밀 archive를 저장할 $OUTPUT_DIR 권한은 0700이어야 합니다 (현재 $output_mode)"
    stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
    final="${OUTPUT_DIR%/}/${prefix}-${stamp}.tar.gz"
    [[ ! -e "$final" && ! -e "$final.sha256" ]] || die "backup 파일이 이미 존재합니다: $final"
    temp_archive="$work/archive.tar.gz"
    tar --hard-dereference -czf "$temp_archive" -C "$work" manifest.txt SHA256SUMS data config
    chmod 0600 "$temp_archive"
    mv "$temp_archive" "$final"
    digest="$(sha256sum "$final" | awk '{print $1}')"
    printf '%s  %s\n' "$digest" "$(basename "$final")" > "$final.sha256"
    chmod 0600 "$final" "$final.sha256"
    CREATED_ARCHIVE="$final"
}

validate_archive_listing() {
    local archive_file="$1" member type duplicate
    tar -tzf "$archive_file" >/dev/null || die "tar.gz 형식이 유효하지 않습니다: $archive_file"
    duplicate="$(tar -tzf "$archive_file" | LC_ALL=C sort | uniq -d | head -n 1)"
    [[ -z "$duplicate" ]] || die "archive에 중복 경로가 있습니다: $duplicate"
    while IFS= read -r member; do
        [[ -n "$member" ]] || die "archive에 빈 경로가 있습니다"
        [[ "$member" != /* && "$member" != *'\\'* && "$member" != *'..'* ]] || \
            die "archive에 안전하지 않은 경로가 있습니다: $member"
        [[ "$member" =~ ^(manifest\.txt|SHA256SUMS|data/?|config/?|data(/[A-Za-z0-9._-]+)*|config/gateway\.env)$ ]] || \
            die "archive에 허용되지 않은 경로가 있습니다: $member"
    done < <(tar -tzf "$archive_file")
    while IFS= read -r type; do
        [[ "$type" == "-" || "$type" == "d" ]] || die "archive의 link/device 항목은 허용되지 않습니다"
    done < <(tar -tvzf "$archive_file" | sed -n 's/^\(.\).*$/\1/p')
}

VALIDATED_DIR=""
validate_restore_archive() {
    local archive_file="$1" sidecar expected actual work format source_volume checksum_line checksum_path manifest_line entry relative duplicate_checksum
    [[ -f "$archive_file" && ! -L "$archive_file" && -s "$archive_file" ]] || \
        die "archive가 일반 파일이 아니거나 비어 있습니다: $archive_file"
    sidecar="$archive_file.sha256"
    [[ -f "$sidecar" && ! -L "$sidecar" ]] || die "archive checksum sidecar가 없습니다: $sidecar"
    read -r expected checksum_path < "$sidecar" || die "checksum sidecar를 읽을 수 없습니다"
    [[ "$expected" =~ ^[0-9a-f]{64}$ && "$checksum_path" == "$(basename "$archive_file")" ]] || \
        die "checksum sidecar 형식/파일명이 일치하지 않습니다"
    actual="$(sha256sum "$archive_file" | awk '{print $1}')"
    [[ "$actual" == "$expected" ]] || die "archive SHA256이 일치하지 않습니다"

    validate_archive_listing "$archive_file"
    new_temp_dir
    work="$NEW_TEMP_DIR"
    tar -xzf "$archive_file" --no-same-owner --no-same-permissions -C "$work"
    [[ -f "$work/manifest.txt" && -f "$work/SHA256SUMS" ]] || die "archive manifest/checksum이 없습니다"
    [[ "$(grep -Ec '^format=' "$work/manifest.txt")" -eq 1 && \
       "$(grep -Ec '^source_volume=' "$work/manifest.txt")" -eq 1 && \
       "$(grep -Ec '^source_image=' "$work/manifest.txt")" -eq 1 && \
       "$(grep -Ec '^created_utc=' "$work/manifest.txt")" -eq 1 && \
       "$(grep -Ec '^database_valid=' "$work/manifest.txt")" -eq 1 && \
       "$(grep -Ec '^configuration_source=' "$work/manifest.txt")" -eq 1 ]] || \
        die "archive manifest 필드가 누락되었거나 중복되었습니다"
    while IFS= read -r manifest_line; do
        [[ "$manifest_line" =~ ^format=vibe-volume-backup-v1$ || \
           "$manifest_line" =~ ^source_volume=[A-Za-z0-9][A-Za-z0-9_.-]*$ || \
           "$manifest_line" =~ ^source_image=[A-Za-z0-9][A-Za-z0-9._:/@+-]*$ || \
           "$manifest_line" =~ ^created_utc=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ || \
           "$manifest_line" =~ ^database_valid=(true|false)$ || \
           "$manifest_line" =~ ^configuration_source=(current_env|restore_archive_env_current_missing_or_invalid)$ ]] || \
            die "archive manifest에 허용되지 않은 값이 있습니다"
    done < "$work/manifest.txt"
    format="$(awk -F= '$1 == "format" {print $2; exit}' "$work/manifest.txt")"
    source_volume="$(awk -F= '$1 == "source_volume" {print $2; exit}' "$work/manifest.txt")"
    [[ "$format" == "vibe-volume-backup-v1" ]] || die "지원하지 않는 archive format: $format"
    [[ "$source_volume" == "$VOLUME" ]] || die "archive volume($source_volume)이 대상($VOLUME)과 다릅니다"
    [[ -f "$work/data/gateway.db" && -f "$work/config/gateway.env" ]] || \
        die "archive에 gateway.db 또는 gateway.env가 없습니다"

    [[ -s "$work/SHA256SUMS" ]] || die "archive 내부 checksum 목록이 비어 있습니다"
    : > "$work/checksum-paths.txt"
    while IFS= read -r checksum_line; do
        [[ "$checksum_line" =~ ^[0-9a-f]{64}[[:space:]][[:space:]]((data|config)(/[A-Za-z0-9._-]+)+)$ ]] || \
            die "안전하지 않은 내부 checksum 항목: $checksum_line"
        checksum_path="${BASH_REMATCH[1]}"
        [[ "/$checksum_path/" != *'/../'* && "/$checksum_path/" != *'/./'* ]] || \
            die "checksum에 상대 경로 구성요소가 있습니다: $checksum_path"
        [[ -f "$work/$checksum_path" && ! -L "$work/$checksum_path" ]] || \
            die "checksum 대상이 일반 파일이 아닙니다: $checksum_path"
        printf '%s\n' "$checksum_path" >> "$work/checksum-paths.txt"
    done < "$work/SHA256SUMS"

    LC_ALL=C sort "$work/checksum-paths.txt" -o "$work/checksum-paths.txt"
    duplicate_checksum="$(uniq -d "$work/checksum-paths.txt" | head -n 1)"
    [[ -z "$duplicate_checksum" ]] || die "중복된 내부 checksum 경로: $duplicate_checksum"
    : > "$work/archive-files.txt"
    while IFS= read -r -d '' entry; do
        relative="${entry#"$work"/}"
        printf '%s\n' "$relative" >> "$work/archive-files.txt"
    done < <(find "$work/data" "$work/config" -type f -print0)
    LC_ALL=C sort "$work/archive-files.txt" -o "$work/archive-files.txt"
    cmp "$work/checksum-paths.txt" "$work/archive-files.txt" >/dev/null || \
        die "archive 내부 checksum이 모든 payload 파일을 정확히 한 번 포함하지 않습니다"
    (cd "$work" && sha256sum -c SHA256SUMS >/dev/null) || die "archive 내부 checksum이 일치하지 않습니다"
    valid_sqlite "$work/data/gateway.db" || die "archive gateway.db가 유효한 SQLite 파일이 아닙니다"
    check_env_file "$work/config/gateway.env"
    VALIDATED_DIR="$work"
}

inspect_volume

if [[ "$MODE" == "backup" ]]; then
    check_env_file "$ENV_FILE"
    running_users="$(running_volume_users)" || die "Docker에서 실행 중인 volume 사용자를 확인하지 못했습니다"
    [[ -z "$running_users" ]] || die "backup 전에 gateway를 중지하세요 (volume 사용 중: $VOLUME)"
    create_volume_archive gateway-volume true
    result="$CREATED_ARCHIVE"
    echo "백업 완료: $result"
    echo "체크섬: $result.sha256"
    echo "주의: archive에는 gateway.env 비밀값이 포함되어 있으므로 0600으로 보관하세요."
    exit 0
fi

[[ -n "$ARCHIVE" ]] || die "restore에는 --archive가 필요합니다"
if [[ "$RESTORE_ENV" != "true" ]]; then
    check_env_file "$ENV_FILE"
else
    env_parent="$(dirname "$ENV_FILE")"
    [[ -d "$env_parent" && ! -L "$env_parent" ]] || \
        die "restore 대상 gateway.env의 상위 디렉터리가 안전하지 않습니다: $env_parent"
    [[ ! -e "$ENV_FILE" || ( -f "$ENV_FILE" && ! -L "$ENV_FILE" ) ]] || \
        die "restore 대상 gateway.env가 일반 파일이 아닙니다: $ENV_FILE"
fi
volume_users="$(all_volume_users)" || die "Docker에서 volume 사용자를 확인하지 못했습니다"
[[ -z "$volume_users" ]] || \
    die "restore 전에 volume을 참조하는 모든 컨테이너를 제거하세요 (docker compose down; -v 금지)"
validate_restore_archive "$ARCHIVE"

if [[ "$RESTORE_ENV" != "true" ]]; then
    current_secret="$(env_secret "$ENV_FILE")"
    archived_secret="$(env_secret "$VALIDATED_DIR/config/gateway.env")"
    [[ -n "$current_secret" && "$current_secret" == "$archived_secret" ]] || \
        die "현재 gateway.env의 GATEWAY_SECRET이 archive와 다릅니다. 검토 후 --restore-env를 명시하세요"
fi

required_confirmation="RESTORE $VOLUME"
if [[ -z "$CONFIRMATION" && -t 0 ]]; then
    echo "복구는 $VOLUME을 삭제하고 검증된 archive로 다시 만듭니다." >&2
    read -r -p "계속하려면 '$required_confirmation'을 정확히 입력하세요: " CONFIRMATION
fi
[[ "$CONFIRMATION" == "$required_confirmation" ]] || die "복구 확인 문구가 일치하지 않습니다"

echo "현재 volume의 자동 안전 백업을 생성합니다..."
if valid_env_file "$ENV_FILE"; then
    safety_env_source="$ENV_FILE"
    safety_config_source=current_env
else
    safety_env_source="$VALIDATED_DIR/config/gateway.env"
    safety_config_source=restore_archive_env_current_missing_or_invalid
fi
create_volume_archive gateway-volume-prerestore false "$safety_env_source" "$safety_config_source"
SAFETY_ARCHIVE="$CREATED_ARCHIVE"
echo "안전 백업: $SAFETY_ARCHIVE"

volume_labels_output="$(
    docker volume inspect --format '{{range $key, $value := .Labels}}{{printf "%s=%s\n" $key $value}}{{end}}' "$VOLUME"
)" || die "volume label을 읽지 못했습니다"
volume_labels=()
if [[ -n "$volume_labels_output" ]]; then
    while IFS= read -r label; do
        volume_labels+=("$label")
    done <<< "$volume_labels_output"
fi
for label in "${volume_labels[@]:-}"; do
    [[ -z "$label" || "$label" =~ ^[A-Za-z0-9_.-]+=[A-Za-z0-9_.:/-]*$ ]] || \
        die "자동 복원할 수 없는 volume label: $label"
done

volume_users="$(all_volume_users)" || die "Docker에서 volume 사용자를 다시 확인하지 못했습니다"
[[ -z "$volume_users" ]] || die "검증 중 새 container가 volume을 참조했습니다. 복구를 중단합니다"
docker volume rm "$VOLUME" >/dev/null
create_args=(--driver local)
for label in "${volume_labels[@]:-}"; do
    [[ -n "$label" ]] && create_args+=(--label "$label")
done
docker volume create "${create_args[@]}" "$VOLUME" >/dev/null

new_carrier
restore_carrier="$NEW_CARRIER"
tar --format=posix --numeric-owner --owner=65532 --group=65532 \
    -cf - -C "$VALIDATED_DIR/data" . | docker cp -a - "$restore_carrier:/data"

new_temp_dir
verify_dir="$NEW_TEMP_DIR"
docker cp "$restore_carrier:/data/gateway.db" "$verify_dir/gateway.db"
cmp "$VALIDATED_DIR/data/gateway.db" "$verify_dir/gateway.db" || \
    die "복구한 gateway.db 검증 실패. 안전 백업: $SAFETY_ARCHIVE"
remove_carrier "$restore_carrier"

if [[ "$RESTORE_ENV" == "true" ]]; then
    restored_env_tmp="$(mktemp "${ENV_FILE}.restore.XXXXXXXX")"
    TEMP_FILES+=("$restored_env_tmp")
    install -m 0600 "$VALIDATED_DIR/config/gateway.env" "$restored_env_tmp"
    mv -f -- "$restored_env_tmp" "$ENV_FILE"
    restored_env_index=$(( ${#TEMP_FILES[@]} - 1 ))
    TEMP_FILES[$restored_env_index]=""
fi

echo "복구 완료: $VOLUME"
echo "복구 전 안전 백업: $SAFETY_ARCHIVE (+ .sha256)"
echo "gateway를 다시 기동한 뒤 /ready와 /admin을 확인하세요."
