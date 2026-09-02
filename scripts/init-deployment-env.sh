#!/usr/bin/env bash
# Create or validate the persistent Docker env file used by production examples.
set -eu

ENV_FILE="${1:-/opt/proxy-gateway/gateway.env}"

fail() {
    echo "deployment env error: $*" >&2
    exit 1
}

validate_env() {
    file="$1"
    expected_version="${2:-}"
    [[ -f "$file" && ! -L "$file" && -s "$file" ]] || fail "$file must be a non-empty regular file"
    [[ "$(grep -Ec '^ADMIN_TOKEN=' "$file")" -eq 1 ]] || fail "ADMIN_TOKEN must occur exactly once"
    grep -Eq '^ADMIN_TOKEN=[0-9A-Fa-f]{64}$' "$file" || fail "ADMIN_TOKEN must be 64 hex characters"
    [[ "$(grep -Ec '^GATEWAY_SECRET=' "$file")" -eq 1 ]] || fail "GATEWAY_SECRET must occur exactly once"
    grep -Eq '^GATEWAY_SECRET=[0-9A-Fa-f]{64}$' "$file" || fail "GATEWAY_SECRET must be 64 hex characters"
    [[ "$(grep -Ec '^UPSTREAM_API_KEY=' "$file")" -eq 1 ]] || fail "UPSTREAM_API_KEY must occur exactly once"
    grep -Eq '^UPSTREAM_API_KEY=[A-Za-z0-9._~:/+=-]+$' "$file" || fail "UPSTREAM_API_KEY contains characters unsafe for a Docker env file"
    grep -q '^UPSTREAM_API_KEY=replace-before-start$' "$file" && fail "UPSTREAM_API_KEY is still a placeholder"
    [[ "$(grep -Ec '^GATEWAY_VERSION=' "$file")" -eq 1 ]] || fail "GATEWAY_VERSION must occur exactly once"
    grep -Eq '^GATEWAY_VERSION=v[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$' "$file" || fail "GATEWAY_VERSION must be an exact v-prefixed release"
    if [[ -n "$expected_version" ]]; then
        grep -qxF "GATEWAY_VERSION=$expected_version" "$file" || fail "GATEWAY_VERSION does not match requested release $expected_version"
    fi
    ui_app_count="$(grep -Ec '^UI_APP_ENABLED=' "$file" || true)"
    [[ "$ui_app_count" -le 1 ]] || fail "UI_APP_ENABLED must occur at most once"
    if [[ "$ui_app_count" -eq 1 ]]; then
        grep -Eq '^UI_APP_ENABLED=(true|false)$' "$file" || fail "UI_APP_ENABLED must be true or false"
    fi
}

ENV_DIR="$(dirname "$ENV_FILE")"
install -d -m 0700 "$ENV_DIR" || fail "cannot create $ENV_DIR"
[[ -d "$ENV_DIR" && ! -L "$ENV_DIR" ]] || fail "$ENV_DIR must be a real directory, not a symbolic link"
[[ ! -L "$ENV_FILE" ]] || fail "$ENV_FILE must not be a symbolic link"
gateway_version="${GATEWAY_VERSION:-v0.81.0}"
[[ "$gateway_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] || fail "GATEWAY_VERSION must be an exact v-prefixed release"
ui_app_enabled="${UI_APP_ENABLED:-false}"
case "$ui_app_enabled" in
    true|false) ;;
    *) fail "UI_APP_ENABLED must be true or false" ;;
esac

if [[ ! -e "$ENV_FILE" ]]; then
    openssl_bin="${OPENSSL_BIN:-openssl}"
    command -v "$openssl_bin" >/dev/null 2>&1 || fail "openssl is required"
    admin_token="$("$openssl_bin" rand -hex 32)" || fail "ADMIN_TOKEN generation failed"
    gateway_secret="$("$openssl_bin" rand -hex 32)" || fail "GATEWAY_SECRET generation failed"
    [[ "${#admin_token}" -eq 64 && "${#gateway_secret}" -eq 64 ]] || fail "generated secrets have an invalid length"
    [[ "$admin_token" =~ ^[0-9A-Fa-f]{64}$ && "$gateway_secret" =~ ^[0-9A-Fa-f]{64}$ ]] || fail "generated secrets are not hexadecimal"

    upstream_key="${UPSTREAM_API_KEY:-}"
    if [[ -z "$upstream_key" && -t 0 ]]; then
        read -r -s -p "Upstream API key: " upstream_key
        echo
    fi
    [[ -n "$upstream_key" ]] || fail "set UPSTREAM_API_KEY or run interactively"
    case "$upstream_key" in
        *[!A-Za-z0-9._~:/+=-]*) fail "UPSTREAM_API_KEY contains characters unsafe for a Docker env file" ;;
    esac
    umask 077
    env_tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")" || fail "cannot create a temporary env file"
    trap 'rm -f -- "$env_tmp"' EXIT HUP INT TERM
    {
        echo 'UPSTREAM_BASE_URL=https://api.openai.com'
        printf 'UPSTREAM_API_KEY=%s\n' "$upstream_key"
        printf 'GATEWAY_VERSION=%s\n' "$gateway_version"
        printf 'ADMIN_TOKEN=%s\n' "$admin_token"
        printf 'GATEWAY_SECRET=%s\n' "$gateway_secret"
        printf 'UI_APP_ENABLED=%s\n' "$ui_app_enabled"
        echo 'MODEL_PRICING_KRW_PER_1M={"gpt-4.1-mini":{"input_krw_per_1m":540,"output_krw_per_1m":2160}}'
    } > "$env_tmp" || fail "cannot write the temporary env file"
    chmod 0600 "$env_tmp" || fail "cannot protect the temporary env file"
    mv -f -- "$env_tmp" "$ENV_FILE" || fail "cannot install $ENV_FILE"
    trap - EXIT HUP INT TERM
fi

chmod 0600 "$ENV_FILE" || fail "cannot protect $ENV_FILE"
validate_env "$ENV_FILE"
current_version="$(awk -F= '$1 == "GATEWAY_VERSION" { print $2; exit }' "$ENV_FILE")"
if [[ "$current_version" != "$gateway_version" ]]; then
    umask 077
    env_tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")" || fail "cannot create a temporary env file"
    trap 'rm -f -- "$env_tmp"' EXIT HUP INT TERM
    awk -v requested_version="$gateway_version" '
        /^GATEWAY_VERSION=/ { print "GATEWAY_VERSION=" requested_version; next }
        { print }
    ' "$ENV_FILE" > "$env_tmp" || fail "cannot stage the release version update"
    chmod 0600 "$env_tmp" || fail "cannot protect the temporary env file"
    validate_env "$env_tmp" "$gateway_version"
    mv -f -- "$env_tmp" "$ENV_FILE" || fail "cannot atomically update $ENV_FILE"
    trap - EXIT HUP INT TERM
fi
validate_env "$ENV_FILE" "$gateway_version"
echo "deployment env is valid: $ENV_FILE"
