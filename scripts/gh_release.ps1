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

$notes = "## AI Proxy Gateway v" + $cleanVer + "`r`n`r`n"
$notes += "### 주요 변경 사항`r`n"
$notes += "- **자동화 성능 벤치마킹 모듈 탑재 (`v0.1.22`)**: TTFT, TPS, 가속지연 등의 메트릭을 자동 측정하고 관리자 페이지에 실시간 반영 및 연동`r`n"
$notes += "- **종합 환경변수 스펙 완비 (`v0.1.21`)**: 부트스트랩 계정 정보(AUTH_ADMIN_BOOTSTRAP_*) 및 DB 폴백 DSN 등 누락되었던 42종의 시스템 설정 변수 표준화 가이드 완료`r`n"
$notes += "- **지능형 라우팅 및 다중 인증 체계 (`v0.1.19~v0.1.20`)**: 서버 상태 기반 Intelligent Routing, 다중 JWT 인증, 거버넌스 룰 엔진 탑재`r`n"
$notes += "- **VCS(Git) 비동기 역추론 엔진 완성 (`v0.1.17~v0.1.18`)**: 오프라인 제약 속 LLM 대화 트래픽에서 Git 커밋/푸시 이벤트를 추적하는 타임라인 맵 구성`r`n"
$notes += "- **3계층 세션 및 RAG 지식 베이스 연동 (`v0.1.13~v0.1.14`)**: Work-Task-Request 3단계 세션 추론 모델링 및 RAG용 KB/MCP 업스트림 기능 제공`r`n"
$notes += "- **XView 분산 산점도 및 이상 비용 탐지 (`v0.1.9~v0.1.12`)**: 대화 맥락 복잡도, 실시간 트랜잭션 APM 가시성 극대화 및 지연 요인 설명(Explain) 모달 제공`r`n"
$notes += "- **데이터베이스 엔터프라이즈 마이그레이션 (`v0.1.5~v0.1.8`)**: SQLite에서 PostgreSQL로의 무결성 마이그레이션, 42803 에러 수정 및 자동 타입 변환 패치`r`n`r`n"
$notes += "### 배포 파일`r`n"
$notes += "| 파일 | 설명 |`r`n"
$notes += "|------|------|`r`n"
$notes += "| ai-coding-proxy-gateway-v" + $cleanVer + ".tar.gz | Docker 이미지 패키지 (linux/amd64) |`r`n"
$notes += "| ai-coding-proxy-gateway-v" + $cleanVer + ".tar.gz.sha256 | SHA256 체크섬 |`r`n"
$notes += "| README-offline-v" + $cleanVer + ".md | 오프라인 배포 가이드 |`r`n"
$notes += "| AI_Proxy_Gateway_Report.pdf | AI Proxy Gateway 기능·역할 및 비즈니스 가치 종합 보고서 (v0.1.22) |`r`n`r`n"
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

gh release create $Version "release\ai-coding-proxy-gateway-$Version.tar.gz" "release\ai-coding-proxy-gateway-$Version.tar.gz.sha256" "release\README-offline-$Version.md" "release\AI_Proxy_Gateway_Report.pdf" --repo hkjang/vibe-coders --title "$Version - AI Proxy Gateway" --notes-file $notesPath

Remove-Item $notesPath -ErrorAction SilentlyContinue

