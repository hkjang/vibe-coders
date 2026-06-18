[CmdletBinding()]
param(
    [string]$Version,
    [string]$PrevVersion = "v0.49.9"
)

$ErrorActionPreference = "Stop"

if (-not $Version) {
    throw "Version parameter is required. Example: pwsh -File scripts/gh_release.ps1 -Version v0.1.1"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$cleanVer = $Version.TrimStart('v')

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
$notes += "### 주요 변경 사항`r`n"
$notes += $targetChangelog + "`r`n`r`n"

$notes += "### 배포 파일`r`n"
$notes += "| 파일 | 설명 |`r`n"
$notes += "|------|------|`r`n"
$notes += "| ai-coding-proxy-gateway-v" + $cleanVer + ".tar.gz | Docker 이미지 패키지 (linux/amd64) |`r`n"
$notes += "| ai-coding-proxy-gateway-v" + $cleanVer + ".tar.gz.sha256 | SHA256 체크섬 |`r`n"
$notes += "| README-offline-v" + $cleanVer + ".md | 오프라인 배포 가이드 |`r`n"
$notes += "| AI_Proxy_Gateway_Report.pdf | AI Proxy Gateway 기능·역할 및 비즈니스 가치 종합 보고서 (v0.50.15) |`r`n`r`n"

$notes += "### 빠른 시작`r`n"
$notes += '```' + "bash`r`n"
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
# Ensure the release directory exists
$releaseDir = Split-Path -Parent $notesPath
if (-not (Test-Path $releaseDir)) {
    New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
}

# Set content as UTF-8
Set-Content -Path $notesPath -Value $notes -Encoding utf8

gh release create $Version "release\ai-coding-proxy-gateway-$Version.tar.gz" "release\ai-coding-proxy-gateway-$Version.tar.gz.sha256" "release\README-offline-$Version.md" "release\AI_Proxy_Gateway_Report.pdf" --repo hkjang/vibe-coders --title "$Version - AI Proxy Gateway" --notes-file $notesPath

Remove-Item $notesPath -ErrorAction SilentlyContinue
