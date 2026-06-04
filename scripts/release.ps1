[CmdletBinding()]
param(
    [string]$Version,
    [string]$Image = "ai-coding-proxy-gateway",
    [string]$Platform = "linux/amd64"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker is not in PATH. Please install Docker Desktop or Engine first."
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

$tag = "${Image}:${Version}"
$releaseDir = Join-Path $repoRoot "release"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

$safeVersion = $Version -replace "[^A-Za-z0-9._-]", "_"
$tarPath  = Join-Path $releaseDir "${Image}-${safeVersion}.tar"
$gzPath   = "$tarPath.gz"
$shaPath  = "$gzPath.sha256"
$readme   = Join-Path $releaseDir "README-offline-${safeVersion}.md"

Write-Host "[1/4] docker build  $tag  (platform=$Platform)" -ForegroundColor Cyan
docker build `
    --platform $Platform `
    --build-arg "VERSION=$Version" `
    -t $tag `
    -f Dockerfile `
    .
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

Write-Host "[2/4] docker save -> $tarPath" -ForegroundColor Cyan
docker save -o $tarPath $tag
if ($LASTEXITCODE -ne 0) { throw "docker save failed" }

Write-Host "[3/4] gzip compression -> $gzPath" -ForegroundColor Cyan
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
"$sha  $(Split-Path -Leaf $gzPath)" | Set-Content -Path $shaPath -Encoding ascii

Write-Host "[4/4] generating offline guide -> $readme" -ForegroundColor Cyan
$lf = "`n"
$guide = @(
    "# AI Coding Proxy Gateway - Offline Deployment Package"
    ""
    "- Version: $Version"
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
    "3. Run (SQLite file persistent in host volume)"
    ""
    "   ``````bash"
    "   docker run -d --name proxy-gateway --restart=always \"
    "       -p 8080:8080 \"
    "       -v /opt/proxy-gateway/data:/data \"
    "       -e UPSTREAM_BASE_URL=https://api.openai.com \"
    "       -e UPSTREAM_API_KEY=sk-... \"
    "       -e ADMIN_TOKEN=change-me \"
    "       -e GATEWAY_SECRET=`$(openssl rand -hex 32) \"
    "       -e MODEL_PRICING_KRW_PER_1M='{`"gpt-4.1-mini`":{`"input_krw_per_1m`":540,`"output_krw_per_1m`":2160}}' \"
    "       $tag"
    "   ``````"
    ""
    "4. Admin UI"
    ""
    "   - http://<host>:8080/admin"
    "   - Token: ADMIN_TOKEN value"
) -join $lf

Set-Content -Path $readme -Value $guide -Encoding utf8

Write-Host ""
Write-Host "Release completed" -ForegroundColor Green
Write-Host "  Image  : $tag"
Write-Host "  File   : $gzPath"
Write-Host "  SHA256 : $shaPath"
Write-Host "  Guide  : $readme"
