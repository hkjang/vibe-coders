[CmdletBinding()]
param(
    [string]$Version
)

$ErrorActionPreference = "Stop"

if (-not $Version) {
    throw "Version parameter is required. Example: pwsh -File scripts/gh_release.ps1 -Version v0.1.1"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$cleanVer = $Version.TrimStart('v')

$notes = "## AI Coding Proxy Gateway v" + $cleanVer + "`r`n`r`n"
$notes += "### 주요 변경 사항`r`n"
$notes += "- 데이터베이스 드라이버 감지 우선순위 개선: DSN(POSTGRES_DSN, DATABASE_URL, DB_DSN)이 postgres:// 또는 postgresql://로 시작하는 경우 Docker 환경의 DB_DRIVER=sqlite 기본값을 덮어쓰고 PostgreSQL을 자동 감지하여 기동하도록 견고화`r`n"
$notes += "- 환경변수 충돌 방지: DB_DRIVER와 DSN 설정이 혼재될 때의 오작동 및 충돌 원인 제거`r`n`r`n"
$notes += "### 배포 파일`r`n"
$notes += "| 파일 | 설명 |`r`n"
$notes += "|------|------|`r`n"
$notes += "| ai-coding-proxy-gateway-v" + $cleanVer + ".tar.gz | Docker 이미지 패키지 (linux/amd64) |`r`n"
$notes += "| ai-coding-proxy-gateway-v" + $cleanVer + ".tar.gz.sha256 | SHA256 체크섬 |`r`n"
$notes += "| README-offline-v" + $cleanVer + ".md | 오프라인 배포 가이드 |`r`n`r`n"
$notes += "### 빠른 시작`r`n"
$notes += "```bash`r`n"
$notes += "# 이미지 로드`r`n"
$notes += "gunzip -c ai-coding-proxy-gateway-" + $Version + ".tar.gz | docker load`r`n`n"
$notes += "# 실행`r`n"
$notes += "docker run -d --name proxy-gateway --restart=always \`r`n"
$notes += "  -p 8080:8080 \`r`n"
$notes += "  -v /opt/proxy-gateway/data:/data \`n"
$notes += "  -e UPSTREAM_BASE_URL=https://api.openai.com \`n"
$notes += "  -e UPSTREAM_API_KEY=sk-... \`n"
$notes += "  -e ADMIN_TOKEN=change-me \`n"
$notes += "  ai-coding-proxy-gateway:" + $Version + "`r`n"
$notes += '```'

$notesPath = Join-Path $repoRoot "release\release-notes.txt"
Set-Content -Path $notesPath -Value $notes -Encoding utf8

gh release create $Version "release\ai-coding-proxy-gateway-$Version.tar.gz" "release\ai-coding-proxy-gateway-$Version.tar.gz.sha256" "release\README-offline-$Version.md" --repo hkjang/vibe-coders --title "$Version - AI Coding Proxy Gateway" --notes-file $notesPath

Remove-Item $notesPath -ErrorAction SilentlyContinue
