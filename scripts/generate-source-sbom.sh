#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: scripts/generate-source-sbom.sh VERSION}"
SYFT_BIN="${SYFT_BIN:-syft}"
GO_VERSION="${GO_VERSION:-1.26.8}"

if ! command -v "$SYFT_BIN" >/dev/null 2>&1; then
    echo "syft is required (validated with v1.51.0); set SYFT_BIN to its path" >&2
    exit 1
fi
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required to merge the source dependency inventories" >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SBOM_TMP_DIR="$(mktemp -d)"
cleanup() {
    case "$SBOM_TMP_DIR" in
        /tmp/*|/var/tmp/*) rm -rf -- "$SBOM_TMP_DIR" ;;
        *) echo "refusing to remove unexpected temp path: $SBOM_TMP_DIR" >&2 ;;
    esac
}
trap cleanup EXIT INT TERM

cd "$REPO_ROOT"
export GOTOOLCHAIN="go${GO_VERSION}"
if [[ "$(go env GOVERSION)" != "go${GO_VERSION}" ]]; then
    echo "Go ${GO_VERSION} is required for the canonical SBOM (got $(go env GOVERSION))" >&2
    exit 1
fi
# Run corepack inside web/ so its packageManager pin selects the pnpm version; from the
# repo root corepack has no package.json to consult and picks the newest release.
(cd web && CI=true corepack pnpm install --frozen-lockfile)
go build -trimpath \
    -ldflags "-X vibe-coders/internal/proxy.AppVersion=${VERSION}" \
    -o "$SBOM_TMP_DIR/gateway" \
    ./cmd/gateway

SYFT_FORMAT_PRETTY=true "$SYFT_BIN" "file:$SBOM_TMP_DIR/gateway" \
    -o "spdx-json@2.3=$SBOM_TMP_DIR/go.spdx.json" >/dev/null
SYFT_FORMAT_PRETTY=true "$SYFT_BIN" "file:$REPO_ROOT/web/pnpm-lock.yaml" \
    -o "spdx-json@2.3=$SBOM_TMP_DIR/npm.spdx.json" >/dev/null
(cd web && corepack pnpm licenses list --json) >"$SBOM_TMP_DIR/npm-licenses.json"

node scripts/merge-source-sbom.mjs \
    "$VERSION" \
    "$SBOM_TMP_DIR/go.spdx.json" \
    "$SBOM_TMP_DIR/npm.spdx.json" \
    "$SBOM_TMP_DIR/npm-licenses.json" \
    SBOM.spdx.json \
    THIRD_PARTY_LICENSES.md

node -e '
const fs = require("node:fs");
const doc = JSON.parse(fs.readFileSync("SBOM.spdx.json", "utf8"));
const refs = doc.packages.flatMap((pkg) => (pkg.externalRefs || []).map((ref) => ref.referenceLocator || ""));
if (!refs.some((ref) => ref.startsWith("pkg:golang/"))) throw new Error("missing Go purls");
if (!refs.some((ref) => ref.startsWith("pkg:npm/"))) throw new Error("missing npm purls");
if (!doc.packages.some((pkg) => pkg.name === "react")) throw new Error("missing React package");
'

echo "Generated SBOM.spdx.json and THIRD_PARTY_LICENSES.md for ${VERSION}"
