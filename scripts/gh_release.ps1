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
$notes += "- **Text2SQL 게이트웨이 및 로드맵 Part 2 완료 (`v0.3.0`)**: 사용자 계약 변경 없이(`/v1/chat/completions` 유지) `vibe/text2sql-*` 가상 모델을 통해 자연어→읽기전용 SQL을 생성하는 Text2SQL 파이프라인 신규 탑재 — 내부에서 실제 업스트림 모델 선택·SQL 검증(SELECT 전용·자동 LIMIT·테이블 권한)·EXPLAIN 비용 가드·결과 PII 마스킹·few-shot 골든쿼리·모델별 SQL 품질 메트릭·DB 스키마 카탈로그/런타임 프로필. 더불어 정책 시뮬레이터(차단 예상 미리보기), 모델 가격표 버전 이력+자동 시드, Mattermost 알림 연계, 팀별 예산 소진 예측, 프롬프트 템플릿 마켓 추가`r`n"
$notes += "- **로드맵 Part 1 완료 및 엔터프라이즈 거버넌스 대대적 확장 (`v0.2.0`)**: Explicit PipelineStep 리팩토링, Ops Health 대시보드 및 주간 AI 리포트 생성, 다차원 비용 할당(Repo/Branch/Project/Service/Cost-Center), CI용 골든 프롬프트 회귀 테스트 게이트, 프롬프트 인젝션 탐지 및 MCP 도구 위험등급 분류, 프로바이더 SLO 모니터링, 월말 비용 예측 및 Operational Risk Score 산출, 폐루프 자동 라우팅 강화 학습, DW 롤업 스태이징 탑재`r`n"
$notes += "- **영속적 세션 추론 및 위임 거버넌스 (`v0.1.26~v0.1.27`)**: 재기동에 안전한 세션 영속 추론 테이블 `inferred_sessions` 추가 및 자동 GC 탑재, team_admin 소속팀 API Key 한정 필터링 조회, 권한 상승(Privilege Escalation) 방지를 위한 계층형 롤/스코프 위임 거버넌스 구현 및 종합 기술 보고서 갱신`r`n"
$notes += "- **사용자 팀 매핑 및 API Key 영구 폐기 관리 (`v0.1.25`)**: 관리자 목록 내 소속 팀 정보 연동 및 패치를 통한 소속 팀 수정·탈퇴 지원, API Key의 개별 세부 권한을 어드민 UI에서 팝업으로 조절 가능한 스코프 편집기 연동, super_admin 한정 키 영구 삭제(?hard=1) 정책 도입`r`n"
$notes += "- **지능형 라우팅 및 기본 권한 보강 (`v0.1.24`)**: 클라이언트 고정(Pinned) 환경에서의 auto/auto-reasoning 모델명 rewrite 지원, PROXY_API_KEYS 및 신규 API Key 생성 시 scopes 미지정인 경우 기본 역할별 권한 자동 상속, /v1/models 익명 조회 허용`r`n"
$notes += "- **API Key 호환성 해결 (`v0.1.23`)**: AUTH_ENABLED 활성화 환경에서 기존에 스코프가 부여되지 않은 채 생성되었던 API Key들의 차단 현상(scope_denied)을 해결하고, 자동 스코프 채움 마이그레이션 적용`r`n"
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
$notes += "| AI_Proxy_Gateway_Report.pdf | AI Proxy Gateway 기능·역할 및 비즈니스 가치 종합 보고서 (v0.3.0) |`r`n`r`n"
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

