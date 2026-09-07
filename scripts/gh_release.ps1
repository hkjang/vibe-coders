[CmdletBinding()]
param(
    [string]$Version,
    [string]$PrevVersion = "v0.82.2",
    [switch]$Edit  # update an existing release's notes instead of creating it (no asset upload)
)

$ErrorActionPreference = "Stop"

function Test-RequiresComplianceAssets {
    param([Parameter(Mandatory = $true)][string]$Value)

    $normalized = $Value
    if ($normalized.StartsWith("v")) { $normalized = $normalized.Substring(1) }
    $match = [regex]::Match(
        $normalized,
        '^(?<major>[0-9]+)\.(?<minor>[0-9]+)\.(?<patch>[0-9]+)(?<prerelease>-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$'
    )
    if (-not $match.Success) { return $false }

    $major = [int64]$match.Groups['major'].Value
    $minor = [int64]$match.Groups['minor'].Value
    $patch = [int64]$match.Groups['patch'].Value
    if ($major -gt 0) { return $true }
    if ($minor -gt 80) { return $true }
    if ($minor -lt 80) { return $false }
    if ($patch -gt 0) { return $true }
    return -not $match.Groups['prerelease'].Success
}

if (-not $Version) {
    throw "Version parameter is required. Example: pwsh -File scripts/gh_release.ps1 -Version v0.83.2"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$cleanVer = $Version.TrimStart('v')
$requiresCompliance = Test-RequiresComplianceAssets $Version

$headCommit = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $headCommit) { throw "Unable to resolve HEAD" }
$tagType = (git cat-file -t "refs/tags/$Version" 2>$null)
if ($LASTEXITCODE -ne 0 -or $tagType -ne "tag") {
    throw "$Version must exist locally as an annotated tag before creating the release."
}
$tagCommit = (git rev-list -n 1 $Version).Trim()
if ($LASTEXITCODE -ne 0 -or -not $tagCommit) { throw "Unable to resolve $Version" }
if (-not $Edit) {
    # Build artifacts live under ignored release/, so any porcelain output here is source drift.
    $worktreeStatus = @(git status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw "git status failed" }
    if ($worktreeStatus.Count -gt 0) {
        throw "The source worktree is not clean. Commit or remove every source change before releasing.`n$($worktreeStatus -join "`n")"
    }
    if ($tagCommit -ne $headCommit) {
        throw "$Version does not point at current HEAD ($headCommit)."
    }
    $remoteMasterRows = @(git ls-remote --heads origin refs/heads/master)
    if ($LASTEXITCODE -ne 0 -or $remoteMasterRows.Count -eq 0) {
        throw "Unable to resolve origin/master."
    }
    $remoteMasterCommit = (($remoteMasterRows | Select-Object -First 1) -split '\s+')[0]
    if ($remoteMasterCommit -ne $headCommit) {
        throw "A new release must target origin/master HEAD ($remoteMasterCommit), not $headCommit."
    }
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw "gh CLI is required to verify the origin/master CI result."
    }
    $ciRunsJson = gh run list --repo hkjang/vibe-coders --workflow CI --commit $headCommit --limit 20 --json conclusion,event,headSha,status
    if ($LASTEXITCODE -ne 0) { throw "Unable to query GitHub CI for $headCommit." }
    $ciRuns = @($ciRunsJson | ConvertFrom-Json)
    $successfulPushRuns = @($ciRuns | Where-Object {
        $_.event -eq 'push' -and $_.headSha -eq $headCommit -and $_.status -eq 'completed' -and $_.conclusion -eq 'success'
    })
    if ($successfulPushRuns.Count -eq 0) {
        throw "No successful push CI run exists for origin/master commit $headCommit."
    }
}

$remoteTagRows = @(git ls-remote --tags origin "refs/tags/$Version" "refs/tags/$Version^{}")
if ($LASTEXITCODE -ne 0) { throw "Unable to inspect origin tag $Version" }
$remotePeeled = $remoteTagRows | Where-Object { $_ -match [regex]::Escape("refs/tags/$Version^{}") } | Select-Object -First 1
if (-not $remotePeeled) {
    throw "Annotated tag $Version is not present on origin. Push the tag before creating the release."
}
$remoteCommit = ($remotePeeled -split "\s+")[0]
if ($remoteCommit -ne $tagCommit) {
    throw "Origin tag $Version resolves to $remoteCommit, not local annotated tag commit $tagCommit."
}

# Load changelog file
$changelogPath = Join-Path $PSScriptRoot "changelog.txt"
if (-not (Test-Path $changelogPath)) {
    throw "changelog.txt file is missing at $changelogPath"
}
$utf8 = [System.Text.Encoding]::UTF8
$changelogLines = [System.IO.File]::ReadAllLines($changelogPath, $utf8)

# Verify versions exist and extract all logs between Version and PrevVersion (exclusive)
$foundStart = $false
$foundEnd = $false
$extractedLogs = @()

foreach ($line in $changelogLines) {
    if ($line -match "^$Version`:") {
        $foundStart = $true
    }
    
    if ($foundStart) {
        if ($line -match "^$PrevVersion`:") {
            $foundEnd = $true
            break
        }
        # Extract the version change note content
        # Line format: "vX.Y.Z:- Note"
        $colonIdx = $line.IndexOf(':')
        if ($colonIdx -gt 0) {
            $note = $line.Substring($colonIdx + 1).Trim()
            $extractedLogs += $note
        }
    }
}

if (-not $foundStart) {
    throw "Target version $Version is not documented in scripts/changelog.txt."
}
if (-not $foundEnd) {
    throw "Previous version $PrevVersion is not documented in scripts/changelog.txt."
}

$targetChangelog = $extractedLogs -join "`r`n"

$notes = "## AI Proxy Gateway v" + $cleanVer + "`r`n`r`n"
$notes += '- Source commit: [`' + $tagCommit + '`](https://github.com/hkjang/vibe-coders/commit/' + $tagCommit + ")`r`n"
$notes += '- Source tag: [`' + $Version + '`](https://github.com/hkjang/vibe-coders/tree/' + $Version + ")`r`n`r`n"
$notes += "### 주요 변경 사항`r`n"
$notes += $targetChangelog + "`r`n`r`n"

$notes += "### 배포 파일`r`n"
$notes += "| 파일 | 설명 |`r`n"
$notes += "|------|------|`r`n"
$notes += "| ai-coding-proxy-gateway-v" + $cleanVer + ".tar.gz | Docker 이미지 패키지 (linux/amd64) |`r`n"
$notes += "| ai-coding-proxy-gateway-v" + $cleanVer + ".tar.gz.sha256 | SHA256 체크섬 |`r`n"
$notes += "| README-offline-v" + $cleanVer + ".md | 오프라인 배포 가이드 |`r`n"
if ($requiresCompliance) {
    $notes += "| SBOM-v" + $cleanVer + ".spdx.json | Go+npm 통합 SPDX SBOM |`r`n"
    $notes += "| THIRD_PARTY_LICENSES-v" + $cleanVer + ".md | Go·Frontend 제3자 라이선스 목록 |`r`n"
    $notes += "| init-deployment-env-v" + $cleanVer + ".sh | 운영 env 원자 생성·검증 helper |`r`n"
    $notes += "| backup-volume-v" + $cleanVer + ".sh | named volume·env 백업·복구 helper |`r`n"
}
$notes += "`r`n"

$notes += "### 빠른 시작`r`n"
$notes += '```' + "bash`r`n"
$notes += "# 이미지 로드`r`n"
$notes += "gunzip -c ai-coding-proxy-gateway-" + $Version + ".tar.gz | docker load`r`n`n"
$notes += "# 최초 1회 비밀값 파일과 nonroot 호환 named volume 준비`r`n"
$notes += "ENV_FILE=/opt/proxy-gateway/gateway.env`r`n"
$notes += 'install -d -m 0700 "$(dirname "$ENV_FILE")" || exit 1' + "`r`n"
$notes += 'command -v openssl >/dev/null 2>&1 || { echo "openssl이 필요합니다." >&2; exit 1; }' + "`r`n"
$notes += 'if [ ! -e "$ENV_FILE" ]; then' + "`r`n"
$notes += "  umask 077`r`n"
$notes += '  ADMIN_TOKEN_VALUE="$(openssl rand -hex 32)" || exit 1' + "`r`n"
$notes += '  GATEWAY_SECRET_VALUE="$(openssl rand -hex 32)" || exit 1' + "`r`n"
$notes += '  [ "${#ADMIN_TOKEN_VALUE}" -eq 64 ] && [ "${#GATEWAY_SECRET_VALUE}" -eq 64 ] || exit 1' + "`r`n"
$notes += '  printf ''%s\n'' "$ADMIN_TOKEN_VALUE" | grep -Eq ''^[0-9A-Fa-f]{64}$'' && ' + "`r`n"
$notes += '    printf ''%s\n'' "$GATEWAY_SECRET_VALUE" | grep -Eq ''^[0-9A-Fa-f]{64}$'' || exit 1' + "`r`n"
$notes += '  UPSTREAM_API_KEY_VALUE="${UPSTREAM_API_KEY:-}"' + "`r`n"
$notes += '  if [ -z "$UPSTREAM_API_KEY_VALUE" ]; then' + "`r`n"
$notes += '    read -r -s -p ''Upstream API key: '' UPSTREAM_API_KEY_VALUE || exit 1' + "`r`n"
$notes += "    echo`r`n"
$notes += "  fi`r`n"
$notes += '  case "$UPSTREAM_API_KEY_VALUE" in' + "`r`n"
$notes += '    ''''|*[!A-Za-z0-9._~:/+=-]*) echo ''UPSTREAM_API_KEY 형식이 안전하지 않습니다.'' >&2; exit 1 ;;' + "`r`n"
$notes += "  esac`r`n"
$notes += '  ENV_TMP="$(mktemp "${ENV_FILE}.tmp.XXXXXX")" || exit 1' + "`r`n"
$notes += '  trap ''rm -f -- "$ENV_TMP"'' EXIT HUP INT TERM' + "`r`n"
$notes += "  {`r`n"
$notes += "    echo 'UPSTREAM_BASE_URL=https://api.openai.com'`r`n"
$notes += '    echo "UPSTREAM_API_KEY=${UPSTREAM_API_KEY_VALUE}"' + "`r`n"
$notes += "    echo 'GATEWAY_VERSION=$Version'`r`n"
$notes += '    echo "ADMIN_TOKEN=${ADMIN_TOKEN_VALUE}"' + "`r`n"
$notes += '    echo "GATEWAY_SECRET=${GATEWAY_SECRET_VALUE}"' + "`r`n"
$notes += "    echo 'UI_APP_ENABLED=false'`r`n"
$notes += '  } > "$ENV_TMP" || exit 1' + "`r`n"
$notes += '  chmod 0600 "$ENV_TMP" && mv -f -- "$ENV_TMP" "$ENV_FILE" || exit 1' + "`r`n"
$notes += "  trap - EXIT HUP INT TERM`r`n"
$notes += "fi`r`n"
$notes += 'chmod 0600 "$ENV_FILE" || exit 1' + "`r`n"
$notes += '[ "$(grep -Ec ''^ADMIN_TOKEN='' "$ENV_FILE")" -eq 1 ] && grep -Eq ''^ADMIN_TOKEN=[0-9A-Fa-f]{64}$'' "$ENV_FILE" && ' + "`r`n"
$notes += '  [ "$(grep -Ec ''^GATEWAY_SECRET='' "$ENV_FILE")" -eq 1 ] && grep -Eq ''^GATEWAY_SECRET=[0-9A-Fa-f]{64}$'' "$ENV_FILE" && ' + "`r`n"
$notes += '  [ "$(grep -Ec ''^UPSTREAM_API_KEY='' "$ENV_FILE")" -eq 1 ] && grep -Eq ''^UPSTREAM_API_KEY=[A-Za-z0-9._~:/+=-]+$'' "$ENV_FILE" && ' + "`r`n"
$notes += '  ! grep -q ''^UPSTREAM_API_KEY=replace-before-start$'' "$ENV_FILE" && ' + "`r`n"
$notes += '  [ "$(grep -Ec ''^GATEWAY_VERSION='' "$ENV_FILE")" -eq 1 ] && ' + "`r`n"
$notes += "  grep -qxF 'GATEWAY_VERSION=$Version' `"`$ENV_FILE`" || `r`n"
$notes += '  { echo "gateway.env의 필수 비밀값이 유효하지 않습니다." >&2; exit 1; }' + "`r`n"
$notes += "docker volume create proxy-gateway-data >/dev/null || exit 1`r`n`r`n"
$notes += "# 기존 볼륨·바인드 마운트 재사용 시 nonroot(65532) 소유권 복구 (새 볼륨은 변경 없음)`r`n"
$notes += "docker run --rm --user 0:0 --mount source=proxy-gateway-data,target=/data ai-coding-proxy-gateway:" + $Version + " repair-data-dir || exit 1`r`n`r`n"
$notes += "docker run -d --name proxy-gateway --restart=always \`r`n"
$notes += "  -p 8080:8080 \`r`n"
$notes += "  --mount source=proxy-gateway-data,target=/data \`r`n"
$notes += '  --env-file "$ENV_FILE" \' + "`r`n"
$notes += "  ai-coding-proxy-gateway:" + $Version + "`r`n"
$notes += '```' + "`r`n`r`n"
$notes += "- Legacy Stable Console: http://localhost:8080/admin`r`n"
$notes += "- Next Console Preview: http://localhost:8080/app/ (/app is OFF unless UI_APP_ENABLED=true)`r`n"
$notes += "- React assets are embedded in the Go binary; the runtime image does not contain Node.js.`r`n"
$notes += "- Reuse and back up the same 0600 env file; rotating GATEWAY_SECRET without migration makes stored Provider Secrets unreadable.`r`n"
$notes += "- Transfer, checksum, and chmod 0700 the bundled init-deployment-env-$Version.sh and backup-volume-$Version.sh helpers.`r`n"
$notes += "- The init helper preserves secrets and atomically updates only GATEWAY_VERSION during upgrades.`r`n"
$notes += "- If the container restarts and 8080 never opens with 'readonly database' in docker logs, /data was written by another user: run the repair-data-dir command above once, then verify with: docker run --rm --mount source=proxy-gateway-data,target=/data ai-coding-proxy-gateway:" + $Version + " check-data-dir`r`n"

$notesPath = Join-Path $repoRoot "release\release-notes.txt"
# Ensure the release directory exists
$releaseDir = Split-Path -Parent $notesPath
if (-not (Test-Path $releaseDir)) {
    New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
}

# Write as UTF-8 WITHOUT BOM via .NET so the GitHub release body has no leading BOM
# and is identical regardless of which PowerShell edition runs this script.
[System.IO.File]::WriteAllText($notesPath, $notes, (New-Object System.Text.UTF8Encoding($false)))

if ($Edit) {
    # Re-publish corrected notes for an already-created release (no asset re-upload).
    gh release edit $Version --repo hkjang/vibe-coders --notes-file $notesPath
    if ($LASTEXITCODE -ne 0) { throw "gh release edit failed" }
} else {
    $assets = @(
        "release\ai-coding-proxy-gateway-$Version.tar.gz"
        "release\ai-coding-proxy-gateway-$Version.tar.gz.sha256"
        "release\README-offline-$Version.md"
    )
    if ($requiresCompliance) {
        $assets += "release\SBOM-$Version.spdx.json"
        $assets += "release\THIRD_PARTY_LICENSES-$Version.md"
        $assets += "release\init-deployment-env-$Version.sh"
        $assets += "release\backup-volume-$Version.sh"
    }
    foreach ($asset in $assets) {
        if (-not (Test-Path $asset -PathType Leaf)) { throw "Release asset is missing: $asset" }
    }
    # Bind every release payload to the checksum manifest and canonical tagged source.
    $archivePath = "release\ai-coding-proxy-gateway-$Version.tar.gz"
    $checksumPath = "$archivePath.sha256"
    $guidePath = "release\README-offline-$Version.md"
    $payloadPaths = @($archivePath, $guidePath)
    if ($requiresCompliance) {
        $payloadPaths += "release\SBOM-$Version.spdx.json"
        $payloadPaths += "release\THIRD_PARTY_LICENSES-$Version.md"
        $payloadPaths += "release\init-deployment-env-$Version.sh"
        $payloadPaths += "release\backup-volume-$Version.sh"
    }

    $manifest = @{}
    foreach ($line in Get-Content -Path $checksumPath) {
        $match = [regex]::Match($line, '^(?<digest>[0-9A-Fa-f]{64})\s+\*?(?<name>[^/\\]+)$')
        if (-not $match.Success) { throw "Malformed checksum manifest row: $line" }
        $name = $match.Groups['name'].Value
        if ($manifest.ContainsKey($name)) { throw "Duplicate checksum manifest entry: $name" }
        $manifest[$name] = $match.Groups['digest'].Value.ToLowerInvariant()
    }
    if ($manifest.Count -ne $payloadPaths.Count) {
        throw "Checksum manifest must contain exactly $($payloadPaths.Count) payload entries."
    }
    foreach ($payloadPath in $payloadPaths) {
        $name = Split-Path -Leaf $payloadPath
        $actual = (Get-FileHash -Path $payloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if (-not $manifest.ContainsKey($name) -or $manifest[$name] -ne $actual) {
            throw "Release payload digest does not match ${checksumPath}: $name"
        }
    }

    $actualDigest = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $guideText = Get-Content -Path $guidePath -Raw
    if (-not $guideText.Contains($tagCommit) -or -not $guideText.Contains($actualDigest)) {
        throw "Offline guide does not attest source commit $tagCommit and archive digest $actualDigest. Rebuild the release package."
    }

    if ($requiresCompliance) {
        $stagedSBOM = "release\SBOM-$Version.spdx.json"
        $stagedLicenses = "release\THIRD_PARTY_LICENSES-$Version.md"
        $stagedInit = "release\init-deployment-env-$Version.sh"
        $stagedBackup = "release\backup-volume-$Version.sh"
        $canonicalSBOM = Join-Path $repoRoot "SBOM.spdx.json"
        $canonicalLicenses = Join-Path $repoRoot "THIRD_PARTY_LICENSES.md"
        $canonicalInit = Join-Path $repoRoot "scripts/init-deployment-env.sh"
        $canonicalBackup = Join-Path $repoRoot "scripts/backup-volume.sh"
        if ((Get-FileHash $stagedSBOM -Algorithm SHA256).Hash -ne (Get-FileHash $canonicalSBOM -Algorithm SHA256).Hash) {
            throw "Release SBOM differs from the canonical tagged SBOM.spdx.json."
        }
        if ((Get-FileHash $stagedLicenses -Algorithm SHA256).Hash -ne (Get-FileHash $canonicalLicenses -Algorithm SHA256).Hash) {
            throw "Release license inventory differs from the canonical tagged THIRD_PARTY_LICENSES.md."
        }
        if ((Get-FileHash $stagedInit -Algorithm SHA256).Hash -ne (Get-FileHash $canonicalInit -Algorithm SHA256).Hash) {
            throw "Release deployment env helper differs from the canonical tagged helper."
        }
        if ((Get-FileHash $stagedBackup -Algorithm SHA256).Hash -ne (Get-FileHash $canonicalBackup -Algorithm SHA256).Hash) {
            throw "Release volume backup helper differs from the canonical tagged helper."
        }
        $stagedDocument = Get-Content -Path $stagedSBOM -Raw | ConvertFrom-Json
        if ($stagedDocument.spdxVersion -ne 'SPDX-2.3') { throw "Release SBOM must use SPDX-2.3." }
        $applicationPackage = @($stagedDocument.packages | Where-Object name -eq 'vibe-coders') | Select-Object -First 1
        if (-not $applicationPackage -or $applicationPackage.versionInfo -ne $cleanVer) {
            throw "Release SBOM application versionInfo must be $cleanVer."
        }
        $packageLocators = @($stagedDocument.packages.externalRefs.referenceLocator)
        if (-not ($packageLocators | Where-Object { $_ -like 'pkg:golang/*' }) -or
            -not ($packageLocators | Where-Object { $_ -like 'pkg:npm/*' })) {
            throw "Release SBOM must include both Go and npm package purls."
        }
        if (-not (Select-String -Path $stagedLicenses -Pattern '(npm|pnpm|react|frontend|프론트엔드)' -Quiet)) {
            throw "Release license inventory does not contain the frontend inventory."
        }
    }
    gh release create $Version @assets --repo hkjang/vibe-coders --verify-tag --title "$Version - AI Proxy Gateway" --notes-file $notesPath
    if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
}

Remove-Item $notesPath -ErrorAction SilentlyContinue
