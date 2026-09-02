[CmdletBinding()]
param(
    [string]$Version,
    [string]$Image = "ai-coding-proxy-gateway",
    [string]$Platform = "linux/amd64"
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

function Test-FormalSemVer {
    param([Parameter(Mandatory = $true)][string]$Value)
    return $Value -match '^v[0-9]+\.[0-9]+\.[0-9]+(?:[+-][0-9A-Za-z.-]+)?$'
}

function Assert-ReleaseSource {
    param([Parameter(Mandatory = $true)][string]$ReleaseVersion)

    $status = @(git status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw "git status failed" }
    if ($status.Count -gt 0) {
        throw "A formal release requires a clean source worktree.`n$($status -join "`n")"
    }
    $head = (git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $head) { throw "Unable to resolve HEAD" }
    $tagType = git cat-file -t "refs/tags/$ReleaseVersion" 2>$null
    if ($LASTEXITCODE -ne 0 -or $tagType -ne 'tag') {
        throw "$ReleaseVersion must exist locally as an annotated tag."
    }
    $tagCommit = (git rev-list -n 1 $ReleaseVersion).Trim()
    if ($LASTEXITCODE -ne 0 -or $tagCommit -ne $head) {
        throw "$ReleaseVersion does not point at current HEAD $head."
    }
    $remoteRows = @(git ls-remote --tags origin "refs/tags/$ReleaseVersion^{}")
    if ($LASTEXITCODE -ne 0 -or $remoteRows.Count -eq 0) {
        throw "Annotated tag $ReleaseVersion is not present on origin."
    }
    $remoteCommit = (($remoteRows | Select-Object -First 1) -split '\s+')[0]
    if ($remoteCommit -ne $head) {
        throw "Origin tag $ReleaseVersion resolves to $remoteCommit, not current HEAD $head."
    }
    $remoteMasterRows = @(git ls-remote --heads origin refs/heads/master)
    if ($LASTEXITCODE -ne 0 -or $remoteMasterRows.Count -eq 0) {
        throw "Unable to resolve origin/master."
    }
    $remoteMasterCommit = (($remoteMasterRows | Select-Object -First 1) -split '\s+')[0]
    if ($remoteMasterCommit -ne $head) {
        throw "A formal release must be built from origin/master HEAD ($remoteMasterCommit), not $head."
    }
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw "gh CLI is required to verify the origin/master CI result for a formal release."
    }
    $ciRunsJson = gh run list --repo hkjang/vibe-coders --workflow CI --commit $head --limit 20 --json conclusion,event,headSha,status
    if ($LASTEXITCODE -ne 0) { throw "Unable to query GitHub CI for $head." }
    $ciRuns = @($ciRunsJson | ConvertFrom-Json)
    $successfulPushRuns = @($ciRuns | Where-Object {
        $_.event -eq 'push' -and $_.headSha -eq $head -and $_.status -eq 'completed' -and $_.conclusion -eq 'success'
    })
    if ($successfulPushRuns.Count -eq 0) {
        throw "No successful push CI run exists for origin/master commit $head."
    }
    return $head
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker is not in PATH. Please install Docker Desktop or Engine first."
}
if (-not (Get-Command bash -ErrorAction SilentlyContinue)) {
    throw "bash is required to run scripts/container-smoke.sh before packaging the release image."
}
bash -c "command -v docker >/dev/null && command -v curl >/dev/null && command -v python3 >/dev/null"
if ($LASTEXITCODE -ne 0) {
    throw "docker, curl, and python3 must be available in the Bash environment used for container smoke."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $Version) {
    $stamp = (Get-Date).ToString("yyyyMMdd-HHmm")
    try {
        $shortSha = (git rev-parse --short HEAD 2>$null)
        if ($LASTEXITCODE -ne 0 -or -not $shortSha) { $shortSha = "nogit" }
    } catch {
        $shortSha = "nogit"
    }
    $Version = "$stamp-$shortSha"
}

$releaseSourceCommit = "unknown"
try {
    $candidateCommit = (git rev-parse HEAD 2>$null).Trim()
    if ($LASTEXITCODE -eq 0 -and $candidateCommit) { $releaseSourceCommit = $candidateCommit }
} catch {
    $releaseSourceCommit = "unknown"
}
if (Test-FormalSemVer $Version) {
    $releaseSourceCommit = Assert-ReleaseSource $Version
}

$tag = "${Image}:${Version}"
$releaseDir = Join-Path $repoRoot "release"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

$safeVersion = $Version -replace "[^A-Za-z0-9._-]", "_"
$requiresCompliance = Test-RequiresComplianceAssets $Version
$totalSteps = if ($requiresCompliance) { 5 } else { 4 }
$tarPath  = Join-Path $releaseDir "${Image}-${safeVersion}.tar"
$gzPath   = "$tarPath.gz"
$shaPath  = "$gzPath.sha256"
$readme   = Join-Path $releaseDir "README-offline-${safeVersion}.md"
$sbomSource = Join-Path $repoRoot "SBOM.spdx.json"
$licenseSource = Join-Path $repoRoot "THIRD_PARTY_LICENSES.md"
$sbomPath = Join-Path $releaseDir "SBOM-${safeVersion}.spdx.json"
$licensePath = Join-Path $releaseDir "THIRD_PARTY_LICENSES-${safeVersion}.md"
$initSource = Join-Path $repoRoot "scripts/init-deployment-env.sh"
$backupSource = Join-Path $repoRoot "scripts/backup-volume.sh"
$initPath = Join-Path $releaseDir "init-deployment-env-${safeVersion}.sh"
$backupPath = Join-Path $releaseDir "backup-volume-${safeVersion}.sh"

if ($requiresCompliance) {
    if (-not (Test-Path $sbomSource -PathType Leaf) -or (Get-Item $sbomSource).Length -eq 0) {
        throw "SBOM source is missing or empty: $sbomSource"
    }
    if (-not (Test-Path $licenseSource -PathType Leaf) -or (Get-Item $licenseSource).Length -eq 0) {
        throw "license source is missing or empty: $licenseSource"
    }
    if (-not (Test-Path $initSource -PathType Leaf) -or (Get-Item $initSource).Length -eq 0) {
        throw "deployment env helper is missing or empty: $initSource"
    }
    if (-not (Test-Path $backupSource -PathType Leaf) -or (Get-Item $backupSource).Length -eq 0) {
        throw "volume backup helper is missing or empty: $backupSource"
    }

    $versionInfo = $Version.TrimStart('v')
    $sbom = Get-Content -Path $sbomSource -Raw | ConvertFrom-Json
    if ($sbom.spdxVersion -ne 'SPDX-2.3') { throw "SBOM.spdx.json must use SPDX-2.3." }
    $applicationPackage = @($sbom.packages | Where-Object name -eq 'vibe-coders') | Select-Object -First 1
    if (-not $applicationPackage -or $applicationPackage.versionInfo -ne $versionInfo) {
        throw "SBOM application versionInfo must be $versionInfo. Regenerate SBOM.spdx.json first."
    }
    $packageLocators = @($sbom.packages.externalRefs.referenceLocator)
    if (-not ($packageLocators | Where-Object { $_ -like 'pkg:golang/*' }) -or
        -not ($packageLocators | Where-Object { $_ -like 'pkg:npm/*' })) {
        throw "SBOM.spdx.json must include both Go and npm package purls."
    }
    if (-not (Select-String -Path $licenseSource -Pattern '(npm|pnpm|react|frontend|프론트엔드)' -Quiet)) {
        throw "THIRD_PARTY_LICENSES.md must include the frontend license inventory."
    }
}

Write-Host "[1/$totalSteps] docker build  $tag  (platform=$Platform)" -ForegroundColor Cyan
docker build `
    --platform $Platform `
    --build-arg "VERSION=$Version" `
    --build-arg "VCS_REF=$releaseSourceCommit" `
    -t $tag `
    -f Dockerfile `
    .
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

Write-Host "[verify] embedded /app assets, deep links, and build version" -ForegroundColor Cyan
bash "scripts/container-smoke.sh" $tag $Version $releaseSourceCommit
if ($LASTEXITCODE -ne 0) { throw "container smoke failed" }

Write-Host "[2/$totalSteps] docker save -> $tarPath" -ForegroundColor Cyan
docker save -o $tarPath $tag
if ($LASTEXITCODE -ne 0) { throw "docker save failed" }

Write-Host "[3/$totalSteps] gzip compression -> $gzPath" -ForegroundColor Cyan
if (Test-Path $gzPath) { Remove-Item $gzPath -Force }

$inputStream  = [System.IO.File]::OpenRead($tarPath)
$outputStream = [System.IO.File]::Create($gzPath)
try {
    $gzip = New-Object System.IO.Compression.GzipStream($outputStream, [System.IO.Compression.CompressionLevel]::Optimal)
    try {
        $inputStream.CopyTo($gzip)
    } finally {
        $gzip.Dispose()
    }
} finally {
    $outputStream.Dispose()
    $inputStream.Dispose()
}
Remove-Item $tarPath -Force

$sha = (Get-FileHash -Path $gzPath -Algorithm SHA256).Hash.ToLower()

Write-Host "[4/$totalSteps] generating offline guide -> $readme" -ForegroundColor Cyan
$lf = "`n"
$guideLines = @(
    "# AI Coding Proxy Gateway - Offline Deployment Package"
    ""
    "- Version: $Version"
    "- Source commit: $releaseSourceCommit"
    "- Image: $tag"
    "- Platform: $Platform"
    "- File: $(Split-Path -Leaf $gzPath)"
    "- SHA256: $sha"
    ""
    "## Deployment Steps"
    ""
    "1. Integrity Verification"
    ""
    "   ``````bash"
    "   sha256sum -c $(Split-Path -Leaf $shaPath)"
    "   ``````"
    ""
    "2. Load Docker Image"
    ""
    "   ``````bash"
    "   gunzip -c $(Split-Path -Leaf $gzPath) | docker load"
    "   ``````"
    ""
    "3. Prepare persistent secrets and the data volume once"
    ""
    "   ``````bash"
    "   ENV_FILE=/opt/proxy-gateway/gateway.env"
    '   install -d -m 0700 "$(dirname "$ENV_FILE")" || exit 1'
    '   command -v openssl >/dev/null 2>&1 || { echo "openssl is required." >&2; exit 1; }'
    '   if [ ! -e "$ENV_FILE" ]; then'
    "       umask 077"
    '       ADMIN_TOKEN_VALUE="$(openssl rand -hex 32)" || exit 1'
    '       GATEWAY_SECRET_VALUE="$(openssl rand -hex 32)" || exit 1'
    '       [ "${#ADMIN_TOKEN_VALUE}" -eq 64 ] && [ "${#GATEWAY_SECRET_VALUE}" -eq 64 ] || exit 1'
    '       printf ''%s\n'' "$ADMIN_TOKEN_VALUE" | grep -Eq ''^[0-9A-Fa-f]{64}$'' &&'
    '           printf ''%s\n'' "$GATEWAY_SECRET_VALUE" | grep -Eq ''^[0-9A-Fa-f]{64}$'' || exit 1'
    '       UPSTREAM_API_KEY_VALUE="${UPSTREAM_API_KEY:-}"'
    '       if [ -z "$UPSTREAM_API_KEY_VALUE" ]; then'
    '           read -r -s -p ''Upstream API key: '' UPSTREAM_API_KEY_VALUE || exit 1'
    "           echo"
    "       fi"
    '       case "$UPSTREAM_API_KEY_VALUE" in'
    '           ''''|*[!A-Za-z0-9._~:/+=-]*) echo ''UPSTREAM_API_KEY is not env-file safe.'' >&2; exit 1 ;;'
    "       esac"
    '       ENV_TMP="$(mktemp "${ENV_FILE}.tmp.XXXXXX")" || exit 1'
    '       trap ''rm -f -- "$ENV_TMP"'' EXIT HUP INT TERM'
    "       {"
    "           echo 'UPSTREAM_BASE_URL=https://api.openai.com'"
    '           echo "UPSTREAM_API_KEY=${UPSTREAM_API_KEY_VALUE}"'
    "           echo 'GATEWAY_VERSION=$Version'"
    '           echo "ADMIN_TOKEN=${ADMIN_TOKEN_VALUE}"'
    '           echo "GATEWAY_SECRET=${GATEWAY_SECRET_VALUE}"'
    "           echo 'UI_APP_ENABLED=false'"
    '           echo ''MODEL_PRICING_KRW_PER_1M={"gpt-4.1-mini":{"input_krw_per_1m":540,"output_krw_per_1m":2160}}'''
    '       } > "$ENV_TMP" || exit 1'
    '       chmod 0600 "$ENV_TMP" && mv -f -- "$ENV_TMP" "$ENV_FILE" || exit 1'
    "       trap - EXIT HUP INT TERM"
    "   fi"
    '   chmod 0600 "$ENV_FILE" || exit 1'
    '   [ "$(grep -Ec ''^ADMIN_TOKEN='' "$ENV_FILE")" -eq 1 ] &&'
    '       grep -Eq ''^ADMIN_TOKEN=[0-9A-Fa-f]{64}$'' "$ENV_FILE" &&'
    '       [ "$(grep -Ec ''^GATEWAY_SECRET='' "$ENV_FILE")" -eq 1 ] &&'
    '       grep -Eq ''^GATEWAY_SECRET=[0-9A-Fa-f]{64}$'' "$ENV_FILE" &&'
    '       [ "$(grep -Ec ''^UPSTREAM_API_KEY='' "$ENV_FILE")" -eq 1 ] &&'
    '       grep -Eq ''^UPSTREAM_API_KEY=[A-Za-z0-9._~:/+=-]+$'' "$ENV_FILE" &&'
    '       ! grep -q ''^UPSTREAM_API_KEY=replace-before-start$'' "$ENV_FILE" &&'
    '       [ "$(grep -Ec ''^GATEWAY_VERSION='' "$ENV_FILE")" -eq 1 ] &&'
    "       grep -qxF 'GATEWAY_VERSION=$Version' `"`$ENV_FILE`" ||"
       '       { echo "gateway.env contains invalid required secrets." >&2; exit 1; }'
    "   docker volume create proxy-gateway-data >/dev/null || exit 1"
    "   docker run -d --name proxy-gateway --restart=always \"
    "       -p 8080:8080 \"
    "       --mount source=proxy-gateway-data,target=/data \"
    '       --env-file "$ENV_FILE" \'
    "       $tag"
    "   ``````"
    ""
    "   Generate ADMIN_TOKEN and GATEWAY_SECRET only once, then back up the env file and data volume together."
    "   Reuse the same env file when recreating the container so stored Provider Secrets remain decryptable."
    "   The bundled $(Split-Path -Leaf $initPath) creates or fail-closed validates the env and atomically updates only GATEWAY_VERSION."
    "   Run chmod 0700 on both bundled helper scripts before use."
    ""
    "4. Admin UI"
    ""
    "   - Legacy Stable Console: http://<host>:8080/admin"
    "   - Next Console Preview: http://<host>:8080/app/"
    "   - /app is OFF by default. Set UI_APP_ENABLED=true to enable the Preview."
    "   - Token: ADMIN_TOKEN value"
    "   - React assets are embedded in the Go binary; Node.js is not present at runtime."
    ""
    "5. UI and Deep-Link Verification"
    ""
    "   ``````bash"
    "   curl -fsSI http://<host>:8080/app"
    "   curl -fsS http://<host>:8080/app/providers >/dev/null"
    "   curl -fsS http://<host>:8080/admin >/dev/null"
    "   ``````"
    ""
    "6. Back up the named volume and env"
    ""
    "   ``````bash"
    "   sudo install -d -m 0700 /opt/proxy-gateway/backups"
    "   docker stop proxy-gateway"
    "   sudo ./$(Split-Path -Leaf $backupPath) backup \"
    "       --image $tag \"
    "       --volume proxy-gateway-data \"
    "       --env-file /opt/proxy-gateway/gateway.env \"
    "       --output-dir /opt/proxy-gateway/backups"
    "   docker start proxy-gateway"
    "   ``````"
    ""
    "   Preserve the archive and sidecar together in encrypted storage. Remove the container before restore and"
    "   follow ./$(Split-Path -Leaf $backupPath) restore --help; never bypass it with a manual volume removal."
)

if ($requiresCompliance) {
    $guideLines += @(
        ""
        "## Compliance Assets"
        ""
        "- $(Split-Path -Leaf $sbomPath) - $Version integrated Go+npm SPDX SBOM"
        "- $(Split-Path -Leaf $licensePath) - Go and Frontend third-party licenses"
        "- $(Split-Path -Leaf $initPath) - fail-closed deployment env helper"
        "- $(Split-Path -Leaf $backupPath) - named-volume and env backup/restore helper"
        ""
        "Transfer all four files into the offline network together with the image package."
    )
}

$guide = $guideLines -join $lf

Set-Content -Path $readme -Value $guide -Encoding utf8

if ($requiresCompliance) {
    Write-Host "[5/$totalSteps] staging SBOM / license / operations helper assets" -ForegroundColor Cyan
    Copy-Item -Path $sbomSource -Destination $sbomPath -Force
    Copy-Item -Path $licenseSource -Destination $licensePath -Force
    Copy-Item -Path $initSource -Destination $initPath -Force
    Copy-Item -Path $backupSource -Destination $backupPath -Force
    if ((Get-FileHash $sbomSource -Algorithm SHA256).Hash -ne (Get-FileHash $sbomPath -Algorithm SHA256).Hash) {
        throw "staged SBOM differs from canonical source"
    }
    if ((Get-FileHash $licenseSource -Algorithm SHA256).Hash -ne (Get-FileHash $licensePath -Algorithm SHA256).Hash) {
        throw "staged license inventory differs from canonical source"
    }
    if ((Get-FileHash $initSource -Algorithm SHA256).Hash -ne (Get-FileHash $initPath -Algorithm SHA256).Hash) {
        throw "staged deployment env helper differs from canonical source"
    }
    if ((Get-FileHash $backupSource -Algorithm SHA256).Hash -ne (Get-FileHash $backupPath -Algorithm SHA256).Hash) {
        throw "staged volume backup helper differs from canonical source"
    }
}

# The manifest covers every independently meaningful payload. It cannot include
# its own digest, so upload and post-release verification validate its structure.
$manifestFiles = @($gzPath, $readme)
if ($requiresCompliance) { $manifestFiles += @($sbomPath, $licensePath, $initPath, $backupPath) }
$manifestLines = @($manifestFiles | ForEach-Object {
    $digest = (Get-FileHash -Path $_ -Algorithm SHA256).Hash.ToLowerInvariant()
    "$digest  $(Split-Path -Leaf $_)"
})
$manifestText = ([string[]]$manifestLines -join "`n") + "`n"
[System.IO.File]::WriteAllText($shaPath, $manifestText, [System.Text.Encoding]::ASCII)

Write-Host ""
Write-Host "Release completed" -ForegroundColor Green
Write-Host "  Image  : $tag"
Write-Host "  File   : $gzPath"
Write-Host "  SHA256 : $shaPath"
Write-Host "  Guide  : $readme"
if ($requiresCompliance) {
    Write-Host "  SBOM   : $sbomPath"
    Write-Host "  License: $licensePath"
    Write-Host "  Env helper: $initPath"
    Write-Host "  Backup helper: $backupPath"
}
