<#
.SYNOPSIS
오프라인 배포용 Docker 이미지를 빌드하고 tar.gz 로 패키징합니다.

.DESCRIPTION
1. docker build 로 멀티스테이지 이미지를 만든다
2. docker save 로 OCI 이미지 tar 를 추출한다
3. tar 를 gzip 으로 압축하여 release/ 폴더에 둔다
4. SHA256 체크섬과 오프라인 적재 가이드를 함께 생성한다

.PARAMETER Version
이미지 태그(=릴리즈 버전). 기본값: yyyymmdd-HHmm-<git short>.
폐쇄망 운영자가 식별할 수 있도록 의미있는 값을 권장.

.PARAMETER Image
이미지 이름. 기본값 ai-coding-proxy-gateway.

.PARAMETER Platform
빌드 대상 플랫폼. 기본값 linux/amd64. arm64 운영망이면 linux/arm64.

.EXAMPLE
pwsh -File scripts/release.ps1 -Version v0.1.0
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Image = "ai-coding-proxy-gateway",
    [string]$Platform = "linux/amd64"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker 가 PATH 에 없습니다. Docker Desktop / Engine 을 먼저 설치하세요."
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
if ($LASTEXITCODE -ne 0) { throw "docker build 실패" }

Write-Host "[2/4] docker save -> $tarPath" -ForegroundColor Cyan
docker save -o $tarPath $tag
if ($LASTEXITCODE -ne 0) { throw "docker save 실패" }

Write-Host "[3/4] gzip 압축 -> $gzPath" -ForegroundColor Cyan
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

Write-Host "[4/4] 오프라인 가이드 생성 -> $readme" -ForegroundColor Cyan
$lf = "`n"
$guide = @(
    "# AI 코딩 프록시 게이트웨이 - 오프라인 배포 패키지"
    ""
    "- 버전: $Version"
    "- 이미지: $tag"
    "- 플랫폼: $Platform"
    "- 파일: $(Split-Path -Leaf $gzPath)"
    "- SHA256: $sha"
    ""
    "## 폐쇄망 적재 절차"
    ""
    "1. 무결성 확인"
    ""
    "   ``````bash"
    "   sha256sum -c $(Split-Path -Leaf $shaPath)"
    "   ``````"
    ""
    "2. 이미지 적재"
    ""
    "   ``````bash"
    "   gunzip -c $(Split-Path -Leaf $gzPath) | docker load"
    "   ``````"
    ""
    "3. 실행 (SQLite 파일을 호스트 볼륨에 보관)"
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
    "4. 관리자 UI"
    ""
    "   - http://<host>:8080/admin"
    "   - 토큰은 ADMIN_TOKEN 값"
) -join $lf

Set-Content -Path $readme -Value $guide -Encoding utf8

Write-Host ""
Write-Host "릴리즈 완료" -ForegroundColor Green
Write-Host "  이미지   : $tag"
Write-Host "  파일     : $gzPath"
Write-Host "  SHA256   : $shaPath"
Write-Host "  가이드   : $readme"
