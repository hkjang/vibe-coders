#!/usr/bin/env bash
# 운영 중 SQLite 와 fallback ndjson 을 안전하게 백업한다.
# 사용법: ./scripts/backup.sh [-d data_dir] [-o out_dir] [-k keep_days]
set -euo pipefail

DATA_DIR="data"
OUT_DIR="backups"
KEEP_DAYS=14

while getopts ":d:o:k:h" opt; do
    case "$opt" in
        d) DATA_DIR="$OPTARG" ;;
        o) OUT_DIR="$OPTARG" ;;
        k) KEEP_DAYS="$OPTARG" ;;
        h) sed -n '2,5p' "$0"; exit 0 ;;
        \?) echo "알 수 없는 옵션: -$OPTARG" >&2; exit 2 ;;
    esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -d "$DATA_DIR" ]]; then
    echo "$DATA_DIR 가 존재하지 않습니다." >&2
    exit 1
fi
mkdir -p "$OUT_DIR"

STAMP="$(date +%Y%m%d-%H%M)"
WORK_DIR="$(mktemp -d -t gateway-backup-XXXXXX)"
PAYLOAD="${WORK_DIR}/data"
ARCHIVE="${OUT_DIR}/gateway-${STAMP}.tar.gz"
mkdir -p "$PAYLOAD"

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

SQLITE_SRC="${DATA_DIR}/gateway.db"
SQLITE_DST="${PAYLOAD}/gateway.db"
if [[ -f "$SQLITE_SRC" ]]; then
    if command -v sqlite3 >/dev/null 2>&1; then
        echo "[1/3] sqlite3 .backup 으로 일관 사본 생성"
        sqlite3 "$SQLITE_SRC" ".backup '${SQLITE_DST}'"
    else
        echo "sqlite3 가 없음 - 파일 복사로 대체 (락 위험)" >&2
        cp "$SQLITE_SRC" "$SQLITE_DST"
    fi
else
    echo "$SQLITE_SRC 가 없습니다 - SQLite 백업 생략" >&2
fi

for extra in fallback.ndjson audit.ndjson; do
    if [[ -f "${DATA_DIR}/${extra}" ]]; then
        cp "${DATA_DIR}/${extra}" "${PAYLOAD}/${extra}"
    fi
done

echo "[2/3] tar.gz 묶기 -> ${ARCHIVE}"
tar -czf "$ARCHIVE" -C "$WORK_DIR" data

echo "[3/3] ${KEEP_DAYS} 일 보존 정책 적용"
find "$OUT_DIR" -type f -name 'gateway-*.tar.gz' -mtime "+${KEEP_DAYS}" -print -delete

echo
echo "백업 완료: $ARCHIVE"
