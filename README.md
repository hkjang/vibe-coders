# AI 코딩 프록시 게이트웨이

Roo Code / Cursor / Continue 등 OpenAI 호환 API 를 호출하는 VS Code 확장 및 AI 코딩 도구를 중간에서 초저지연으로 중계하면서 사용량·프롬프트·토큰·언어·호출 IP·비용(KRW) 을 추적하는 SSE 프록시 게이트웨이입니다. 폐쇄망 운영을 위한 오프라인 도커 이미지 릴리즈 패키지를 제공합니다.

## 문서

- **[운영 가이드](docs/OPERATIONS.md)** — 기동/종료, 헬스체크, 백업·복구, 장애 대응 런북
- **[사용자 가이드](docs/USER_GUIDE.md)** — Roo Code / Cline / Cursor / OpenAI SDK 연결, 본인 사용량 확인
- **[관리자 가이드](docs/ADMIN_GUIDE.md)** — 어드민 UI 탭 사용법, 일상/주간/월간 운영 체크리스트
- **[안전 및 보안 거버넌스 가이드](docs/SAFETY_GUIDE.md)** — 정책 엔진, Secret Firewall, 승인 워크플로우 운영
- **[릴리즈 가이드](docs/RELEASE_GUIDE.md)** — 빌드·태깅·GitHub 릴리즈·오프라인 패키지 산출·롤백 절차

## 추적 항목

- 클라이언트 IP, X-Forwarded-For, User-Agent, 호스트명
- 호출 endpoint, 모델, provider, stream 여부, 상태/첫 청크 지연/전체 지연/오류
- prompt/tool 로그 (기본은 원문 미저장 + 마스킹 텍스트/해시)
- LLM session_id, prompt name/version/variables hash, tool count, managed/external evaluation 결과
- usage 기반 prompt/completion/total 토큰, usage 없을 때는 텍스트 기반 추정
- 모델별 KRW 가격표를 통한 비용 산정
- 코드블록·파일명·키워드 기반 개발 언어 추론
- 관리자 변경 이력 (provider, key 발급/비활성화)

## 현재 구현 범위

- `/v1/chat/completions`, `/v1/models`, `/v1/embeddings` 프록시
- **MCP Gateway**: 여러 업스트림 MCP 서버를 단일 `/mcp` (JSON-RPC 2.0) 엔드포인트로 집약 — 도구 네임스페이스(`<업스트림>__<도구>`)·라우팅, 기존 MCP 정책(allowlist/차단)·사용자 귀속·관측에 통합
- `stream=true` SSE 응답 즉시 중계 및 flush
- SQLite 기본 저장, PostgreSQL DSN 지원
- 비동기 감사 로그 + fallback NDJSON
- DB 장애 시 fallback NDJSON 로 빠진 로그의 관리자 재처리 `/admin/fallback`
- DB 기반 Provider 설정과 `X-Proxy-Provider` 요청별 라우팅
- 관리자 API/UI 기반 Proxy API Key 발급·비활성화 (해시 저장)
- Provider upstream key AES-GCM 암호화 저장
- 사용자(Proxy 키) / IP / 모델 / 언어 별 사용량과 비용(KRW) 집계, 사용자별 24h·오류율·P95 지연·상태 분포·시간대 히트맵
- 호출 단건 상세 + 첫 청크/전체 지연 + 프롬프트 전문(마스킹) + 응답 메타 조회
- API 키 / 팀 / IP / 전체 단위 일별·월별 쿼터 (토큰·KRW). 한도 초과 시 429 + Retry-After + X-Quota-*
- 보존 정책 (RETENTION_REQUEST_DAYS / RETENTION_PROMPT_DAYS / RETENTION_RESPONSE_DAYS) 기반 백그라운드 cleanup
- 한국어 어드민 UI 다중 탭 (대시보드 / LLM 관측 / 호출 이력 / 프롬프트 검색 / 사용자 / IP / 사용 한도 / 안전 / 설정), 비용 KRW 표기
- Datadog LLM Observability 대응 기능: Trace/Span Explorer, Session Explorer, Prompt Tracking, Patterns, Insights, trend timeseries, human feedback(label/prompt/alignment summary), managed evaluation, external evaluation submit API
- 사용자 상세 화면에 API 키별 LLM 요청/eval failure/feedback/alignment trend drill-down 제공
- prompt name/version 비교 API와 UI 모달로 버전별 지연·비용·오류율·평가 실패율 비교 제공
- prompt compare도 현재 `api_key_id`, `team` 스코프를 그대로 따라가도록 지원
- prompt compare baseline 자동 선택 개선: 가까운 이전 버전 우선, 없으면 최근성 기준 fallback
- prompt compare 모달에 baseline 자동 선택 근거 표시
- prompt compare 응답과 모달에 추천 baseline 후보 목록 추가
- 추천 baseline 후보를 버튼으로 바로 눌러 재비교 가능
- 추천 baseline 후보에 호출량, 평균 지연, 오류율, 평가 실패율, 최근 시각 메타데이터 노출
- compare 모달에 추천 후보 정렬 기준 설명 추가
- prompt compare 추천 baseline 후보 개수를 3/5/10개로 조절 가능
- 팀 탭과 `/admin/teams`, `/admin/teams/{team}` API로 팀별 사용량/LLM 관측 drill-down 제공
- LLM 관측 탭에 `api_key_id`, `team` 스코프 필터 추가, sessions/patterns/insights 까지 같은 스코프로 조회
- LLM 관측 drill-down 스코프에 `model`, `session_id`, `prompt_name`, `prompt_version` 포함
- insight drill-down 이 `evaluation_name`까지 전달되어 관련 evaluation/trace만 바로 추적 가능
- prompt 계열 insight 에서 바로 Prompt Compare 모달을 열 수 있는 액션 추가
- session 계열 insight 에서 최근 trace bundle 모달을 바로 여는 액션 추가
- session bundle 모달에서 JSON/CSV 즉시 다운로드 지원
- 사용자/팀 상세 화면에서 필터가 채워진 `LLM 관측` deep link 제공
- 강화된 PII 마스킹 (한국 주민번호·휴대전화·일반전화·사업자등록번호, 카드번호, 이메일, IPv4, JWT, PEM private key, AWS/GitHub/Slack/Anthropic/OpenAI 키)
- OpenAI `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens` 추적 + cached 단가 분리 KRW 비용 계산
- Intelligent Routing Engine: `auto` / `vibe/auto` / `vibe-coders/auto` 모델 별칭을 complexity·risk·provider health 기반으로 자동 모델/프로바이더 선택
- 요청별 routing decision 저장: selected model/provider, complexity score, risk score, health score, fallback path, decision reason
- 인증 확장: email/password admin login, JWT access/refresh rotation, role/scope 기반 Admin API, API key 만료·폐기·IP·scope·모델/provider 정책 검사
- Governance Layer: 정책 rule 기반 allow/block/approval, 팀 ID/팀명 조건, Secret Firewall detect/mask/block, 승인 workflow, MCP tool risk profile, policy decision audit, anomaly event 조회, replay/golden prompt/context registry API
- 모델 패턴(`claude-*`, `anthropic/*` 등) 기반 provider 자동 라우팅. 클라이언트가 `X-Proxy-Provider` 를 지정하지 않아도 모델명만으로 라우팅
- **Text2SQL 게이트웨이** (`v0.3.0`): `vibe/text2sql-*` 가상 모델로 자연어→읽기전용 SQL 생성. 기존 `/v1/chat/completions` 그대로 사용하되 내부에서 실제 업스트림 모델 선택 → SQL 검증(SELECT 전용·자동 LIMIT·테이블 권한)·EXPLAIN 비용 가드·결과 PII 마스킹·few-shot 골든쿼리. 자세한 내용은 아래 "Text2SQL" 절 참고
- **운영·거버넌스 확장** (`v0.3.0`): 정책 시뮬레이터(`/admin/policies/simulate`), 모델 가격표 버전 이력(`/admin/pricing`, `/admin/pricing/seed`), 운영 리스크 스코어(`/admin/ops/risk`)·상태(`/admin/ops/status`), Provider SLO(`/admin/providers/slo`), 비용 이상탐지(`/admin/cost/anomalies`)·배부(`/admin/cost/allocation`)·팀 예산 예측(`/admin/budgets/projection`), 모델별 코딩 품질(`/admin/models/quality`), 작업 템플릿(`/admin/templates`), 프롬프트 버전 승격(`/admin/prompts/promotions`), 자동 라우팅 학습 루프(`/admin/routing/learning/auto`), DW 롤업(`/admin/dw/rollups`), Mattermost 알림(`/admin/notifications/mattermost`)
- 호출 이력 CSV 다운로드 `/admin/export.csv` (Excel UTF-8 BOM 포함, 한국어 그대로 열림)
- 운영용 백업 스크립트 `scripts/backup.ps1` / `scripts/backup.sh` (SQLite `.backup` + fallback ndjson + 보존 일수 적용)
- `/health`, `/ready`, `/metrics`, `/auth/login`, `/auth/logout`, `/auth/refresh`, `/auth/me`, `/admin`, `/admin/stats`, `/admin/requests`, `/admin/requests/{id}`, `/admin/prompts`, `/admin/export.csv`, `/admin/users`, `/admin/users/{id}`, `/admin/teams`, `/admin/teams/{team}`, `/admin/ips`, `/admin/ips/{ip}`, `/admin/routing/preview`, `/admin/routing/decisions`, `/admin/routing/decisions/{id}`, `/admin/routing/health`, `/admin/policies`, `/admin/policies/decisions`, `/admin/approvals`, `/admin/approvals/{id}/approve`, `/admin/approvals/{id}/reject`, `/admin/security/secrets`, `/admin/replay`, `/admin/golden-prompts`, `/admin/contexts`, `/admin/anomalies`, `/admin/llm/traces`, `/admin/llm/traces/{id}`, `/admin/llm/sessions`, `/admin/llm/prompts`, `/admin/llm/prompts/compare`, `/admin/llm/patterns`, `/admin/llm/insights`, `/admin/llm/timeseries`, `/admin/llm/feedback`, `/admin/llm/evaluations`, `/admin/quotas`, `/admin/retention`, `/admin/fallback`, `/admin/api-keys`, `/admin/api-keys/{id}/revoke`, `/admin/providers`, `/admin/mcp/tools`, `/admin/audit-logs`, `/admin/audit/auth-events`

## 실행 (개발)

```powershell
$env:UPSTREAM_API_KEY="sk-..."
go run ./cmd/gateway
```

기본 listen 주소는 `:8080`. Roo Code, OpenAI SDK, curl 등에서 base URL 을 `http://localhost:8080/v1` 로 바꾸면 됩니다.

```powershell
curl.exe http://localhost:8080/v1/chat/completions `
  -H "Authorization: Bearer dev-proxy-key" `
  -H "Content-Type: application/json" `
  -d '{ "model": "gpt-4.1-mini", "stream": true, "messages": [{ "role": "user", "content": "main.go를 리팩터링해줘" }] }'
```

`PROXY_API_KEYS` 미설정이거나 어드민 키가 하나도 없으면 proxy key 검증 없이 동작합니다. 키를 하나라도 생성하면 이후 AI API 호출에 proxy key 가 필요합니다.

```powershell
$env:PROXY_API_KEYS="dev:dev-proxy-key:alice:platform,team:team-proxy-key:bob:backend"
```

## 운영자 Quick Start

1. 운영 secret 설정: `UPSTREAM_API_KEY`, `GATEWAY_SECRET`, `ADMIN_TOKEN` 또는 `AUTH_ENABLED=true` + `AUTH_JWT_SECRET` + 부트스트랩 계정.
2. 기동: `go run ./cmd/gateway` 또는 Docker/Compose로 실행.
3. 헬스체크: `GET /health`, `GET /ready`, `GET /metrics`.
4. 어드민 접속: `http://<host>:8080/admin` 에서 provider, proxy API key, 예산, 정책을 확인.
5. 라우팅 검증: `POST /admin/routing/preview` 로 `vibe/auto` 결정 이유를 확인한 뒤 SDK base URL을 `http://<host>:8080/v1` 로 변경.
6. 운영 백업: `scripts/backup.ps1` 또는 `scripts/backup.sh` 를 주기 실행하고 fallback NDJSON 재처리 상태를 점검.

### 사용자 귀속 (왜 passthrough/anonymous 로 묶이나)

게이트웨이는 키의 **해시만** 저장하므로, 들어온 Bearer 키를 사용자에 귀속시키려면 그 키가 **등록된 proxy key**(위 `PROXY_API_KEYS` 또는 어드민 "API 키 발급")여야 합니다. 등록되지 않은 키는 기본적으로 사용자 식별이 불가능합니다.

- **익명(anonymous)**: 키가 아예 없고 등록 키도 없을 때.
- **외부 키 자동 귀속(status `external`)**: 등록 안 된 키(예: 클라이언트가 upstream 키를 직접 전달)라도 **키 지문으로 사용자별 분리**됩니다. 식별자는 발급 키와 동일하게 `key_<해시16>` 이며, 등록 여부는 **상태(active/external)** 로만 구분합니다(prefix 아님). 같은 키=같은 사용자, 다른 키=다른 사용자. "사용자별로 다른 키"를 보내면 등록 없이도 이력이 분리됩니다. 응답 헤더 `X-Api-Key-Id` 로 게이트웨이가 인식한 식별자를 즉시 확인할 수 있습니다. (구버전 `ext_…` 식별자는 시작 시 `key_…` 로 자동 이관)
  - `X-Vibe-User`(또는 `X-User-Id`/`X-Title`) 헤더로 표시 이름을, `X-Vibe-Team` 헤더로 팀을 지정하면 사용자/팀 화면에 그대로 나타납니다.
  - 정확한 통제(쿼터·팀 강제·인증)가 필요하면 키를 **등록**하세요. 등록 키 매칭이 외부 귀속보다 항상 우선합니다.
  - `ATTRIBUTE_EXTERNAL_KEYS=false` 로 두면 구버전처럼 모든 미등록 키를 단일 `passthrough` 로 묶습니다.
  - 응답 헤더 `X-Api-Key-Id` 로 어떤 식별자로 인식됐는지 확인 → "발급 키로 호출했는데 다른 데로 잡힌다" 진단에 사용.

## 주요 환경변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `LISTEN_ADDR` | `:8080` | 서버 listen 주소 |
| `UPSTREAM_BASE_URL` | `https://api.openai.com` | OpenAI 호환 upstream base URL |
| `UPSTREAM_API_KEY` / `OPENAI_API_KEY` | 없음 | upstream provider key |
| `UPSTREAM_PROVIDER` | `openai` | 로그에 기록할 provider 이름 |
| `DB_DRIVER` | `sqlite` | `sqlite` 또는 `postgres` |
| `DB_DSN` | `data/gateway.db` | SQLite 파일 경로 |
| `POSTGRES_DSN` / `DATABASE_URL` | 없음 | 있으면 PostgreSQL 사용 |
| `PROXY_API_KEYS` | 없음 | `name:key:owner:team` CSV |
| `ATTRIBUTE_EXTERNAL_KEYS` | `true` | 미등록 키를 키 지문(`key_…`, 상태 external)으로 사용자별 귀속. `false`면 단일 `passthrough` |
| `VCS_WEBHOOK_SECRET` | 없음 | 설정 시 `/vcs/*` 수집 엔드포인트 활성화(GitLab/Bitbucket/범용 → Prompt↔Commit↔MR 상관). 미설정 시 비활성 |
| `ADMIN_TOKEN` | 없음 | 설정 시 `/admin/*` Bearer 토큰 요구 (전권) |
| `ADMIN_READONLY_TOKEN` | 없음 | 설정 시 GET/HEAD 만 허용되는 읽기전용 admin 토큰 |
| `AUTH_ENABLED` | `false` | `true`면 Admin API는 JWT, OpenAI/MCP API는 scope 정책이 있는 API key를 요구 |
| `AUTH_JWT_SECRET` | 없음 | `AUTH_ENABLED=true`일 때 필수 JWT 서명 secret |
| `AUTH_ACCESS_TOKEN_TTL` | `15m` | admin JWT access token TTL |
| `AUTH_REFRESH_TOKEN_TTL` | `168h` | refresh token TTL. refresh 시 rotation 및 이전 토큰 폐기 |
| `AUTH_API_KEY_PREFIX` | `vc_sk_` | 일반 API key 자동 생성 prefix |
| `AUTH_SERVICE_KEY_PREFIX` | `vc_sa_` | service account key 자동 생성 prefix |
| `AUTH_ADMIN_BOOTSTRAP_EMAIL` | 없음 | 초기 `super_admin` 생성 email |
| `AUTH_ADMIN_BOOTSTRAP_PASSWORD` | 없음 | 초기 `super_admin` 생성 password. DB에는 bcrypt hash만 저장 |
| `GATEWAY_SECRET` | 개발용 기본값 | Provider API key 암호화 secret. 운영에서는 반드시 설정 |
| `LOG_RAW_PROMPTS` | `false` | 원문 prompt 저장 여부 |
| `LOG_RAW_BODIES` | `false` | 요청 원본 JSON body 저장 여부 (요청 재실행에 필요) |
| `LOG_RESPONSE_TEXT` | `false` | 응답 본문 일부 저장 여부 |
| `LOG_RESPONSE_MAX_BYTES` | `1048576` | 응답 분석/저장 최대 byte |
| `MODEL_PRICING_KRW_PER_1M` | `{}` | 모델별 100만 토큰 KRW 가격 JSON |
| `RETENTION_REQUEST_DAYS` | `90` | 요청 로그 보존 일수 (0 이면 보존 안 함) |
| `RETENTION_PROMPT_DAYS` | `30` | 프롬프트 로그 보존 일수 |
| `RETENTION_RESPONSE_DAYS` | `30` | 응답 로그 보존 일수 |
| `RETENTION_INTERVAL` | `1h` | 보존 정책 cleanup 워커 주기 |

비용 계산은 가격표가 설정된 모델에만 적용되며 단위는 원(₩) 입니다.

```powershell
$env:MODEL_PRICING_KRW_PER_1M='{ "gpt-4.1-mini": { "input_krw_per_1m": 540, "output_krw_per_1m": 2160, "cached_input_krw_per_1m": 135 } }'
```

`cached_input_krw_per_1m` 가 설정된 경우 OpenAI 가 `prompt_tokens_details.cached_tokens` 로 보고하는 캐시된 입력 토큰은 별도 단가로 정산됩니다 (설정이 없으면 일반 입력 단가 적용). 추론(reasoning) 토큰은 출력 단가로 함께 정산됩니다.

### 인증 / RBAC

기본값은 기존 호환 모드(`AUTH_ENABLED=false`)입니다. 켜면 admin API는 `/auth/login` JWT가 필요하고, OpenAI 호환 API key는 hash만 저장되며 만료·폐기·IP·scope·모델/provider 정책을 검사합니다.

```powershell
$env:AUTH_ENABLED="true"
$env:AUTH_JWT_SECRET="change-me-long-random"
$env:AUTH_ADMIN_BOOTSTRAP_EMAIL="admin@example.com"
$env:AUTH_ADMIN_BOOTSTRAP_PASSWORD="change-me"

curl.exe -X POST http://localhost:8080/auth/login `
  -H "Content-Type: application/json" `
  -d '{ "email": "admin@example.com", "password": "change-me" }'

curl.exe -X POST http://localhost:8080/admin/api-keys `
  -H "Authorization: Bearer <access_token>" `
  -H "Content-Type: application/json" `
  -d '{ "name": "dev", "scopes": ["chat:completion","models:read"], "allowed_models": ["gpt-4.1-mini","gpt-4.1"] }'
```

### 응답 캐시 (비용 절감)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `CACHE_EMBEDDING_ENABLED` | `true` | `/v1/embeddings` 동일 입력 응답 캐시 |
| `CACHE_EMBEDDING_TTL` | `24h` | 임베딩 캐시 TTL |
| `CACHE_CHAT_ENABLED` | `false` | `/v1/chat/completions` 응답 캐시 (opt-in) |
| `CACHE_CHAT_TTL` | `1h` | chat 캐시 TTL |
| `CACHE_EMBEDDING_MAX_BYTES` | `1048576` | 캐시 항목 최대 byte (chat 공용) |

chat 응답은 비결정적이라 기본 비활성화입니다. 활성화해도 **재현 가능한 요청만** 캐시합니다: `temperature=0` 또는 `seed` 가 설정된 요청, 혹은 클라이언트가 `X-Proxy-Cache: 1` 헤더로 명시 동의한 경우. 캐시 적중 시 `X-Cache: HIT` 헤더로 응답하고 upstream 호출 없이 비용 0으로 처리되며, XView 캐시 패널에 절감액이 표시됩니다. 캐시 키는 model·messages·tools·temperature·top_p·max_tokens·seed·response_format 기준이며 `stream` 등 휘발성 필드는 제외합니다.

### 세션 그룹화 (명시적 + 추론)

세션 비용 타임라인·Waterfall·에이전트 루프 탐지는 모두 `session_id` 기준으로 요청을 묶습니다. 그런데 대부분의 AI 코딩 툴은 HTTP 레벨에서 세션을 보내지 않습니다.

| 툴 | 세션 전달 방식 |
| --- | --- |
| Langflow | 바디 `session_id` |
| OpenWebUI | 바디 `chat_id` |
| Claude Code / Cursor / Roo Code / Qwen Code | **안 보냄** (대화 상태를 클라이언트 메모리로만 유지) |

게이트웨이는 **명시적(explicit) → 추론(inferred)** 2단계로 처리합니다.

1. **명시적**: 클라이언트가 보낸 값을 그대로 사용 — 헤더(`X-Session-ID`, `X-Vibe-Session-ID`, `X-Conversation-ID`, `X-Datadog-Session-ID` 등) 또는 바디(`session_id`/`chat_id`/`conversation_id`/`thread_id`, `metadata.*` 포함). 헤더가 바디보다 우선.
2. **추론**: 명시적 세션이 없으면 클라이언트 신원 + **슬라이딩 비활성 윈도우**로 자동 생성. 신원 = `api_key + client_ip + user-agent + (옵션) X-Vibe-Repo/X-Vibe-Branch`. 같은 클라이언트의 연속 호출은 한 세션으로 묶이고, `SESSION_IDLE_TIMEOUT`(기본 30분) 이상 잠잠하면 새 세션이 시작됩니다. 생성 ID는 `sess_<12hex>` 형태이며, DB의 `inferred_sessions` 에 저장되어 재시작 후에도 idle window 안이면 복구됩니다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `SESSION_INFERENCE_ENABLED` | `true` | 명시적 세션이 없을 때 자동 추론. `false`면 요청별(`trace:<id>`)로 분리(레거시 동작) |
| `SESSION_IDLE_TIMEOUT` | `30m` | 이 시간 이상 비활성이면 새 추론 세션 시작 |

> 더 정확한 그룹화가 필요하면 클라이언트(플러그인)에서 `X-Vibe-Session-ID` 헤더를 직접 보내는 것이 가장 좋습니다. repo/branch 단위로 나누려면 `X-Vibe-Repo`·`X-Vibe-Branch` 헤더를 추가하세요.

## 통계와 어드민

```powershell
Start-Process http://localhost:8080/admin
curl.exe http://localhost:8080/admin/stats
curl.exe http://localhost:8080/admin/requests
curl.exe http://localhost:8080/admin/api-keys
curl.exe http://localhost:8080/admin/providers
curl.exe http://localhost:8080/metrics
```

`/admin` 은 한국어 운영 대시보드입니다. IP·모델·언어별 요청량 / 토큰 / KRW 비용 / 평균 지연을 표시합니다.

### 어드민 편의 기능

- **자동 새로고침**: 헤더의 드롭다운으로 끔/5초/10초/30초/60초 선택. 선택은 세션에 보관.
- **다크 모드**: 헤더의 🌓 버튼 또는 `t` 단축키.
- **상대 시간**: `3분 전` 형태로 표시되고, 마우스를 올리면 절대 시각이 보입니다.
- **표 헤더 정렬**: 사용자/IP/모델/언어/호출이력 표의 헤더를 클릭하면 오름·내림 정렬. 정렬 상태는 화면별로 저장됩니다.
- **키보드 단축키**:
  - `?` 도움말, `/` 검색 포커스, `t` 다크 모드, `r` 새로고침, `Esc` 모달 닫기
  - `g` 다음에 `d`(대시보드) / `x`(XView) / `w`(Waterfall) / `l`(LLM 관측) / `c`(MCP) / `e`(에이전트) / `v`(VCS) / `r`(호출 이력) / `p`(프롬프트 검색) / `u`(사용자) / `m`(팀) / `i`(IP) / `q`(사용 한도) / `a`(안전) / `s`(설정)
- **시계열 차트**: 대시보드 상단에 24시간/7일/30일 토글로 요청 수(실선) + 비용 KRW(점선) SVG 라인 차트.
- **상위 사용자 위젯**: 요청 수 기준 Top 5 API 키, 클릭 시 사용자 상세로 이동.
- **상태 분포 카드**: 2xx / 3xx / 4xx / 429 / 5xx 비율을 막대와 표로 함께 표시.
- **시간대 히트맵**: Asia/Seoul 기준 요일×시간(0~23) 히트맵으로 사용 패턴 시각화.

### 분석 API

```powershell
curl.exe "http://localhost:8080/admin/timeseries?window=7d&bucket=day"
curl.exe "http://localhost:8080/admin/timeseries?window=24h&bucket=hour&scope=api_key&value=key_xxxxxxxx"
curl.exe "http://localhost:8080/admin/heatmap?window=30d"
curl.exe "http://localhost:8080/admin/llm/traces?session_id=sess-123"
curl.exe "http://localhost:8080/admin/llm/sessions"
curl.exe "http://localhost:8080/admin/waterfall?session_id=sess-123"
curl.exe "http://localhost:8080/admin/llm/prompts"
curl.exe "http://localhost:8080/admin/llm/patterns"
curl.exe "http://localhost:8080/admin/llm/insights?window=24h"
curl.exe "http://localhost:8080/admin/llm/timeseries?window=24h&bucket=hour"
curl.exe "http://localhost:8080/admin/llm/feedback"
curl.exe "http://localhost:8080/admin/llm/evaluations"
```

`/admin/stats` 응답에는 기존 IP/모델/언어 외에 `by_status` (HTTP 상태 분포)와 `top_users` (상위 5 API 키) 가 포함됩니다.

### Waterfall (트랜잭션 타임라인)

`Waterfall` 탭은 한 세션의 요청들을 시간순 간트 막대로 펼칩니다. 막대의 연한 부분=첫 응답 대기(TTFB), 진한 부분=스트리밍 수신, 막대 사이 빈 공간=클라이언트 대기/생각 시간입니다. 상단 요약은 **총 소요(wall) vs LLM 처리(busy, 구간 합집합) vs 대기(idle)** 를 분해해 "느림"의 원인이 모델인지 클라이언트인지 가립니다.

- **병목 분석(자동)**: 가장 느린 요청·가장 긴 대기를 % 와 함께 콜아웃하고, idle/busy·TTFB/스트리밍 비교로 병목 위치를 판정.
- **세션 시간 구성 바**: 첫 응답 대기(Σ TTFB) / 스트리밍 수신 / 클라이언트 대기(idle) 비율을 스택 바로.
- **느린 요청 플래그**: `slow_ms`(미지정 시 `max(3000, p95)` 자동) 초과 요청을 ⚠·빨간 테두리로 표시, 툴바에서 기준 조정.
- **분류 필터·CSV**: 범례 클릭으로 분류별 표시 토글, 스팬 전체 CSV 내보내기.

색상은 XView와 동일(정상/캐시/폴백/고복잡도/오류)하고 막대 클릭 시 그 요청의 라우팅 근거(Explain)로 이동합니다. API: `GET /admin/waterfall?session_id=<id>&slow_ms=<ms>` → 서버가 `start_offset_ms`·`ttfb_ms`·`total_ms`·`gap_before_ms`·`category`·`slow` 와 세션 집계(`wait_ms`/`stream_ms`/`slow_count`/`bottleneck`)를 미리 계산해 내려줍니다.

### LLM Observability 메타데이터

클라이언트가 다음 헤더를 보내면 어드민의 **LLM 관측** 탭에서 세션, 프롬프트 버전, 평가 실패를 기준으로 추적할 수 있습니다. 헤더가 없으면 session은 `trace:<trace_id>`, prompt는 `ad-hoc` 으로 기록됩니다.

```powershell
curl.exe http://localhost:8080/v1/chat/completions `
  -H "Authorization: Bearer dev-proxy-key" `
  -H "Content-Type: application/json" `
  -H "X-LLM-Session-ID: sess-123" `
  -H "X-LLM-Prompt-Name: code-review" `
  -H "X-LLM-Prompt-Version: v7" `
  -H "X-LLM-Prompt-Variables-Hash: vars-sha256" `
  -d '{ "model": "gpt-4.1-mini", "messages": [{ "role": "user", "content": "검토해줘" }] }'
```

요청 body의 `metadata.prompt`, `metadata.prompt_tracking`, `metadata._dd.ml_obs.prompt_tracking` 에 `{ "id" 또는 "name", "version", "variables" }` 형태의 구조화 프롬프트 메타데이터가 있어도 자동 수집합니다.

외부 평가기는 다음 API 로 결과를 제출할 수 있습니다.

```powershell
curl.exe -X POST http://localhost:8080/admin/llm/evaluations `
  -H "Content-Type: application/json" `
  -d '{ "evaluations": [{
    "request_id": "req_xxxxxxxx",
    "name": "external.factuality",
    "category": "quality",
    "evaluator": "ci-check",
    "score": 0.82,
    "passed": true,
    "label": "pass"
  }] }'
```

운영자가 trace 상세를 보고 사람 피드백을 남길 때는 다음 API를 사용할 수 있습니다.

```powershell
curl.exe -X POST http://localhost:8080/admin/llm/feedback `
  -H "Content-Type: application/json" `
  -d '{ "request_id": "req_xxxxxxxx", "rating": -1, "label": "hallucination", "comment": "근거 없는 답변" }'
```

## 안전 운영 (Kill Switch + 알림)

어드민 UI의 "안전" 탭과 `/admin/kill-switch`, `/admin/alerts` API 로 사용 가능합니다.

### Kill Switch (긴급 정지)

오작동한 사내 도구가 API 를 폭주시키는 경우 한 번에 모든 `/v1/*` 호출을 차단할 수 있습니다. 차단 중에는 `HTTP 503 + Retry-After: 60 + X-Kill-Switch: global + X-Kill-Reason: <사유>` 헤더로 응답합니다. admin 폼은 5초 캐시를 사용해 호출당 DB 조회 부담 없이 동작합니다.

```powershell
curl.exe -X POST http://localhost:8080/admin/kill-switch `
  -H "Content-Type: application/json" `
  -d '{ "disabled": true, "reason": "릴리즈 롤백 중" }'
```

`disabled: false` 로 다시 호출하면 정상 운영으로 복귀합니다.

### 알림 규칙 + Webhook

지정한 윈도우(초) 동안 지표(요청 수 / 오류율 / KRW 비용 / 토큰 / 지연 P95)가 임계값 이상이면 1분 주기 워커가 자동으로 발화합니다. webhook URL 이 있으면 Slack incoming-webhook 호환 JSON (`text` 필드 + 컨텍스트) 을 POST 합니다. 발화 후에는 동일 윈도우 동안 재발화하지 않습니다(디바운스).

```powershell
# 5분 동안 전체 요청이 500건 이상이면 Slack 으로 알림
curl.exe http://localhost:8080/admin/alerts `
  -H "Content-Type: application/json" `
  -d '{ "name": "분당 폭주 감시", "metric": "requests", "scope": "global",
        "window_seconds": 300, "threshold": 500,
        "webhook_url": "https://hooks.slack.com/services/...",
        "enabled": true, "note": "조직 안전망" }'

# 특정 API 키의 일별 비용이 10만원 이상이면 알림 (webhook 생략 시 DB 만 기록)
curl.exe http://localhost:8080/admin/alerts `
  -H "Content-Type: application/json" `
  -d '{ "name": "alice 일별 비용", "metric": "krw", "scope": "api_key",
        "scope_value": "key_xxxxxxxx", "window_seconds": 86400,
        "threshold": 100000, "enabled": true }'
```

지원 지표:

- `requests` — 윈도우 내 요청 수
- `errors` — 윈도우 내 4xx/5xx 비율 (0.0~1.0). 예: `0.1` = 10%
- `krw` — 윈도우 내 KRW 비용 누적
- `tokens` — 윈도우 내 토큰 누적
- `latency_p95_ms` — 윈도우 내 전체 응답 지연 P95(ms)
- `first_chunk_p95_ms` — 윈도우 내 upstream 첫 응답 청크 지연 P95(ms)
- `llm_eval_failures` — 윈도우 내 실패한 LLM evaluation 수
- `llm_eval_failure_rate` — 윈도우 내 LLM evaluation 실패율 (0.0~1.0)

```powershell
# 5분 동안 LLM 평가 실패율이 20% 이상이면 알림
curl.exe http://localhost:8080/admin/alerts `
  -H "Content-Type: application/json" `
  -d '{ "name": "LLM 평가 실패율", "metric": "llm_eval_failure_rate", "scope": "global",
        "window_seconds": 300, "threshold": 0.2, "enabled": true }'
```

발화 이력은 `/admin/alerts` 응답의 `events` 와 어드민 "안전" 탭에서 확인합니다.

### 협업 · 감사 (4단계)

#### 요청 태그·메모

호출 이력에서 의심스럽거나 검토가 필요한 요청에 태그/메모를 달 수 있습니다. 어드민 UI 의 요청 상세 모달 하단에서 태그(콤마 구분)와 메모를 저장하면, 호출 이력 표에 작은 핀(`#태그`)과 메모 미리보기가 함께 표시되고 `#태그` 키워드로 검색됩니다.

```powershell
curl.exe -X PUT "http://localhost:8080/admin/requests/req_xxxxx/note" `
  -H "Content-Type: application/json" `
  -d '{ "tags": ["의심", "재현필요"], "note": "토큰 폭주 의심" }'

# 검색
curl.exe "http://localhost:8080/admin/prompts?q=%23%EC%9D%98%EC%8B%AC"
```

태그·메모는 `request_notes` 별도 테이블에 보관되며 보존 정책 cleanup 시 요청과 함께 삭제됩니다.

#### 저장된 필터 (북마크)

프롬프트 검색 화면의 "현재 필터 저장" 버튼으로 현재 검색 조건(키워드, IP, 키, 언어, 기간 등)을 이름과 함께 저장하고, 드롭다운에서 다시 불러올 수 있습니다.

```powershell
curl.exe http://localhost:8080/admin/saved-filters `
  -H "Content-Type: application/json" `
  -d '{ "name": "이번 주 Go 호출", "view": "prompts", "params": "language=Go&since=2026-06-01T00:00:00Z&limit=500" }'
```

#### 감사 로그 CSV

`/admin/audit-logs.csv` 는 관리자 변경 이력(API 키 발급, provider 변경, kill switch, quota CRUD 등)과 알림 발화 이력을 한 파일로 합쳐 UTF-8 BOM + 한국어 CSV 로 내려보냅니다. 설정 탭의 "감사 로그 CSV 다운로드" 버튼으로도 받을 수 있습니다.

```powershell
curl.exe -OJ "http://localhost:8080/admin/audit-logs.csv?limit=5000"
```

### 디버깅 도구 (5단계)

#### 요청 재실행 (Replay)

`LOG_RAW_BODIES=true` 로 운영 중인 경우, 호출 상세 모달의 "동일 요청 재실행" 버튼으로 정확히 같은 요청 body 를 다시 upstream 에 보낼 수 있습니다. 재실행된 요청은 `X-Proxy-Replay-Of` 헤더로 원본 요청 ID 와 연결되어 별도의 새 행으로 기록되며, 어드민에서 결과가 인라인으로 표시됩니다. 버그 재현 / 회귀 확인에 유용합니다.

```powershell
curl.exe -X POST "http://localhost:8080/admin/requests/req_xxxxx/replay"
# 옵션: ?provider=anthropic 로 다른 provider 에 보내 비교
```

원본 body 가 저장되어 있지 않으면 `HTTP 422 body_not_stored` 가 반환됩니다.

#### 두 요청 Diff 뷰

호출 이력 검색 화면에서 각 행 왼쪽 체크박스로 두 개를 선택한 뒤 "두 요청 비교" 버튼을 누르면 모달에 좌우로 펼쳐 모델·상태·토큰·비용·프롬프트를 한눈에 비교합니다.

```powershell
curl.exe "http://localhost:8080/admin/requests/diff?a=req_aaa&b=req_bbb"
```

#### 입력 자동완성

검색/필터 입력에 마우스를 두면 최근 본 모델·IP·언어가 datalist 로 제안됩니다. 백엔드는 `/admin/suggest?field=model|ip|language|tag` 이고 캐시 없이 DB 상위 100개를 그대로 가져옵니다.

```powershell
curl.exe "http://localhost:8080/admin/suggest?field=model"
```

### 권한 분리

`ADMIN_TOKEN` 외에 `ADMIN_READONLY_TOKEN` 을 별도 설정하면, 그 토큰은 GET / HEAD 만 허용됩니다. 회계/감사 부서에는 읽기전용 토큰을 발급해 어드민 화면만 안전하게 열람하게 할 수 있습니다.

## Provider 라우팅

기본 provider 는 `UPSTREAM_PROVIDER`, `UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY` 로 시작 시 DB 에 저장됩니다. 추가 provider 는 어드민 UI 나 API 로 저장합니다.

```powershell
curl.exe http://localhost:8080/admin/providers `
  -H "Content-Type: application/json" `
  -d '{ "name": "openrouter", "base_url": "https://openrouter.ai/api", "api_key": "sk-or-...", "timeout_ms": 600000, "enabled": true }'
```

요청별 provider 선택:

```powershell
curl.exe http://localhost:8080/v1/chat/completions `
  -H "Authorization: Bearer dev-proxy-key" `
  -H "X-Proxy-Provider: openrouter" `
  -H "Content-Type: application/json" `
  -d '{ "model": "openai/gpt-4.1-mini", "stream": true, "messages": [{ "role": "user", "content": "main.go를 리팩터링해줘" }] }'
```

### 모델 패턴 기반 자동 라우팅

Provider 등록 시 `model_patterns` 에 콤마 구분 글롭(`*` 와일드카드)을 넣으면, 클라이언트가 `X-Proxy-Provider` 를 지정하지 않아도 요청 body 의 `model` 필드를 기준으로 해당 provider 로 자동 라우팅합니다.

```powershell
curl.exe http://localhost:8080/admin/providers `
  -H "Content-Type: application/json" `
  -d '{ "name": "anthropic", "base_url": "https://api.anthropic.com", "api_key": "sk-ant-...", "timeout_ms": 600000, "enabled": true, "model_patterns": "claude-*,anthropic/*" }'
```

이후 `model=claude-3-5-sonnet` 요청은 자동으로 anthropic provider 로, `model=gpt-4.1-mini` 는 기본 openai 로 라우팅됩니다. 어드민 UI 의 설정 탭 > 업스트림 프로바이더 폼에서도 동일하게 입력할 수 있습니다.

### Intelligent Routing Engine

`model` 에 `auto`, `vibe/auto`, `vibe-coders/auto` 를 넣으면 게이트웨이가 요청 complexity, risk, provider health 를 계산해 모델과 provider 를 자동 선택합니다. 기본 매핑은 simple→`gpt-4.1-mini`, standard/complex→`gpt-4.1`, reasoning→`o3` 입니다. auto alias 는 명시적 자동 라우팅 요청이므로 일반 `/admin/routing-rules` 보다 우선합니다. `X-Proxy-Provider` 로 provider 를 고정해도 auto 모델 선택은 계속 동작하며, provider 만 고정됩니다. Provider `model_patterns` 가 `vibe/*` 처럼 alias 기준으로 등록되어 있으면, 선택된 실제 모델 패턴이 없을 때 요청 alias 기준 provider도 후보로 사용합니다.

Complexity score 는 0~100이며 simple(0~29), standard(30~59), complex(60~84), reasoning(85~100) 으로 분류합니다. 입력 길이, 토큰 추정, 코드 밀도, 파일 수, 대화 깊이, 지시 밀도, 추론/리팩토링/디버깅 키워드를 반영합니다. Risk score 는 PII, secret/API key, SQL, 인증/인가, crypto, deployment/infrastructure command를 탐지합니다. 최근 latency/p95/timeout/429/5xx/fallback rate는 provider health score(0~100)에 반영됩니다.

```powershell
curl.exe http://localhost:8080/admin/routing/preview `
  -H "Content-Type: application/json" `
  -d '{ "model": "vibe-coders/auto", "messages": [{ "role": "user", "content": "auth middleware를 리팩터링하고 배포 리스크를 검토해줘" }] }'
```

Routing Explain 예시:

```json
{
  "selected_model": "gpt-4.1",
  "selected_provider": "openai",
  "complexity": { "score": 63, "tier": "complex" },
  "risk": { "score": 38, "tier": "medium", "categories": ["authentication", "deployment_command"] },
  "health_score": 96,
  "fallback_path": ["429:backup", "5xx:backup", "timeout:lowest-latency-provider"],
  "decision_reason": "client requested vibe/auto; auto alias mapped complex tier to gpt-4.1; provider health selected openai(96)"
}
```

운영 API:

- `POST /admin/routing/preview` — upstream 호출 없이 routing 결과만 계산. 선택적으로 `api_key_id` 를 넣으면 해당 키의 allowed/denied model/provider 정책까지 반영
- `GET /admin/routing/decisions` / `GET /admin/routing/decisions/{id}` — 요청별 selected model/provider, complexity/risk/health, fallback path, decision reason 조회
- `GET /admin/routing/health` — 최근 provider health score 조회

Governance 정책 예시:

```json
{
  "name": "enterprise-safety",
  "rules": [
    { "name": "block secrets", "contains_secret": true, "block": true },
    { "name": "approve high risk", "risk_score": ">80", "require_approval": true },
    { "name": "security model allowlist", "team": "security", "allow_models": ["gpt-5", "claude-sonnet"] }
  ]
}
```

정책 충돌은 `BLOCK > APPROVAL > ALLOW > DEFAULT` 순서로 결정되며, 매칭된 판단은 정책 감사 이벤트에 기록됩니다.

### 라우팅 학습 (Routing Learning Engine)

운영 계층(고정 복잡도 규칙) 위의 **학습 계층**입니다. 게이트웨이는 모든 chat 호출에 대해 **작업유형**(프롬프트 키워드로 추정: 리팩토링/생성/디버그/설명/테스트/변환/문서/리뷰)과 **복잡도 버킷**(낮음 0–33 / 중간 34–66 / 높음 67–100)을 기록하고, 모델별 **성공률·평균 비용·평균 지연·👍/👎**를 누적합니다.

`GET /admin/routing/learning?window=7d&min_samples=20` 은 (작업유형 × 복잡도 × 모델) 매트릭스와, 셀별로 **표본이 충분한 모델 중 성공률이 가장 높은(동률 시 저비용)** 모델을 고른 추천을 반환합니다(성공 = 2xx · 오류 없음 · 폴백 없음). 예: `복잡도 82 → GPT-5(성공 92%) vs Claude(96%) → Claude 추천`.

설정 탭의 **"라우팅 학습 추천"** 표에서 현재 최다 사용 모델과 추천 모델을 비교하고, **"규칙으로 적용"** 버튼으로 해당 복잡도 구간에 대한 라우팅 규칙을 즉시 생성합니다(human-in-the-loop). 작업유형은 추정치이며 적용 규칙은 복잡도 구간 단위로 동작합니다.

### 에이전트 성능 분석 (Agent Performance Analytics)

### AI Cost Predictor (사전 비용 예측 + 가드)

호출을 업스트림에 보내기 **전에** 입력/출력 토큰·KRW 비용·지연을 예측합니다. 출력 토큰은 모델별 최근 7일 평균(표본 부족 시 요청의 `max_tokens`, 그것도 없으면 기본값)으로 추정하고, 비용은 모델 가격표로 계산합니다.

- 모든 chat 응답에 헤더: `X-Estimated-Input-Tokens`, `X-Estimated-Output-Tokens`, `X-Estimated-Cost-KRW`, `X-Estimated-Latency-MS`.
- **비용 가드**(안전 탭): 예상 비용이 임계값(KRW)을 넘으면 `HTTP 402` 로 차단. 클라이언트가 `X-Cost-Approve: 1` 헤더를 보내면 승인되어 통과. 메트릭 `proxy_cost_guard_blocked_total`.
- **예측기(dry-run)**: `POST /admin/cost/predict {model, input_tokens, max_tokens?}` → `{input_tokens, output_tokens, cost_krw, latency_ms, priced, basis}`. 가드 설정: `GET|POST /admin/cost {enabled, threshold_krw}`.

**에이전트** 탭은 코딩 에이전트(Claude Code/Cursor/Roo Code/Cline/Qwen Code/Continue/…)별 리더보드입니다. 요청 User-Agent로 에이전트를 분류해 **성공률**(2xx·오류無·폴백無)·**평균/누적 비용**·**평균 지연/TTFB**·**도구 오류율**·토큰을 비교합니다. `GET /admin/agents?window=7d` → `{agents[]}`. 어떤 에이전트가 가장 안정적이고(성공률) 가성비가 좋은지(평균 비용) 한눈에 보고 표준 도구를 정하는 데 씁니다.

### 프롬프트 지문 (Prompt Fingerprint)

프롬프트 검색 탭 하단의 **"프롬프트 지문"** 표는 의미적으로 유사한 작업 프롬프트를 하나로 묶습니다. 붙여넣은 코드를 제거하고 핵심 키워드 + 작업유형(+한국어 조사·어미 정규화)으로 만든 **어휘 지문**(`fp_…`, 의미 임베딩 아님)으로 클러스터링하여, 코딩 도구가 반복 전송하는 정형 프롬프트를 드러냅니다. 클러스터별 **건수·성공률·평균/누적 비용·평균 토큰·최다 사용 모델·최저가(성공률 5%p 이내) 모델·예시 프롬프트**를 제공합니다. 예: `"REST 컨트롤러 만들어줘" 계열 412건, 평균 ₩X, 최저가 모델 gpt-4.1-mini`. `GET /admin/prompts/fingerprints?window=7d&limit=100`.

### Team Benchmark · AI 활용지수 · AI Incident

- **팀 벤치마크**(팀 탭): 팀별 월비용(30d)·성공률·커밋·머지 MR·생산성 점수 비교. `GET /admin/benchmark/teams?window=30d`
- **AI 활용지수**(사용자 탭): 사용자별 Prompt·세션·활동일·커밋·머지 MR·성공률 기반 0~100 점수(요청 30%+활동일 20%+커밋 20%+MR 15%+성공률 15%, 관측 휴리스틱). `GET /admin/benchmark/users?window=30d`
- **AI Incident**(안전 탭): 프로바이더별 폴백/5xx가 시간당 임계(기본 5건) 이상인 시간대를 장애로 추정해 연속 구간 병합 — 폴백 수·5xx·**영향 사용자**·진행 중 표시. 예: "openai 장애 → anthropic 자동 전환, 폴백 212회, 영향 18명". `GET /admin/incidents?window=7d&min_events=5`

### Knowledge Cache (반복 규칙 중앙 등록)

매 호출에 반복 전송되는 사내 코딩 규칙·시스템 프롬프트를 **한 번 등록**하고, 클라이언트는 본문 대신 짧은 참조만 보냅니다. 게이트웨이가 업스트림 전송 시 전체 텍스트로 **확장**합니다.

- 등록: 설정 탭 > "Knowledge Cache" (이름·ID·본문). API: `POST /admin/knowledge`, 목록/삭제/토글 `GET|DELETE|PATCH /admin/knowledge[/{id}]`.
- 참조 방법 (둘 중 하나):
  - 메시지 본문에 플레이스홀더: `{{kb:coding-standards}}`
  - 헤더: `X-Vibe-Knowledge: coding-standards,security-rules` → 시스템 메시지로 맨 앞에 주입
- 확장된 호출은 응답 헤더 `X-Knowledge-Expanded: <id,...>` 로 확인. 메트릭 `proxy_knowledge_expansions_total`, `proxy_knowledge_tokens_total`.

효과: 규칙을 한 곳에서 고치면 **모든 호출에 즉시 반영**(거버넌스), 클라이언트→게이트웨이 페이로드·프롬프트 로그 저장 감소. 업스트림 토큰 *비용* 절감은 안정적 프리픽스에 대한 provider 프리픽스 캐싱(cached 토큰)과 결합될 때 발생합니다. 감사 로그에는 확장 전 짧은 참조가 보존되고, 모델에는 전체 본문이 전달됩니다.

Proxy API Key 발급:

```powershell
curl.exe http://localhost:8080/admin/api-keys `
  -H "Content-Type: application/json" `
  -d '{ "name": "Roo Code", "owner": "alice", "team": "platform" }'
```

응답의 `secret` 은 한 번만 확인할 수 있습니다.

## Text2SQL (자연어 → 읽기전용 SQL)

`TEXT2SQL_ENABLED=true` 면 `vibe/text2sql-*` 가상 모델로 자연어 질문을 읽기 전용 SQL 로 변환합니다. **사용자 계약은 그대로** — 기존 `/v1/chat/completions` 에 `model` 만 바꿔 호출하면 됩니다. 게이트웨이는 가상 모델을 그대로 업스트림에 보내지 않고, 내부에서 **실제 업스트림 모델**을 선택해 SQL 을 생성·검증·(선택)실행한 뒤 일반 Chat Completion 형식으로 응답합니다.

```powershell
curl.exe http://localhost:8080/v1/chat/completions `
  -H "Authorization: Bearer dev-proxy-key" `
  -H "Content-Type: application/json" `
  -H "X-Text2SQL-Schema-Name: analytics" `
  -d '{ "model": "vibe/text2sql-preview", "messages": [{ "role": "user", "content": "지난달 부서별 ITSM 요청 건수를 알려줘" }] }'
```

| 가상 모델 | 모드 | 기본 업스트림 |
| --- | --- | --- |
| `vibe/text2sql-preview` | SQL 생성만 | `TEXT2SQL_PREVIEW_MODEL` |
| `vibe/text2sql-execute` | 정책 통과 시 read-only 실행 | `TEXT2SQL_EXECUTE_MODEL` |
| `vibe/text2sql-accurate` | 생성(복잡 분석) | `TEXT2SQL_ACCURATE_MODEL` |
| `vibe/text2sql-local` | 생성(폐쇄망·저비용) | `TEXT2SQL_LOCAL_MODEL` |
| `vibe/text2sql-auto` | 복잡도 기반 자동 | 라우팅 선택 |

- **안전장치**: SELECT/CTE 전용(DDL·DML·스택쿼리·`SELECT INTO`·위험함수 차단, 문자열/주석 리터럴 스크럽 후 분석), 자동 `LIMIT`, 테이블 allowlist + **컬럼 민감도(normal/mask/exclude)** — `exclude` 컬럼은 LLM 컨텍스트에서 제외되고 참조 SQL은 차단, 결과 PII 마스킹, PostgreSQL `EXPLAIN` **위험 점수화**(비용·seq scan·nested loop) 차단, 가상모델 비유출(업스트림엔 실제 모델만), `task_type=text2sql` + `requested_model`/`upstream_model` 감사.
- **스키마 레지스트리**: `text2sql_schemas`(이름·팀·기본) + `text2sql_tables`/`text2sql_columns`(업무 설명·민감도)로 프롬프트 컨텍스트를 구조화 생성. `POST /admin/text2sql/collect` 로 실행 DB(`information_schema`/`sqlite_master`)에서 자동 수집(운영자 태그 보존).
- **few-shot · 품질**: 검증된 골든 쿼리를 질문 유사도로 생성 프롬프트에 주입하고, 성공 쿼리는 골든 자동 후보로 적립. `text2sql.sql_valid`/`executed` 평가를 LLM evaluation 파이프라인으로 emit, 모델별 SQL 품질 메트릭 제공.
- **응답 포맷**: 해석 / 생성 SQL / 결과 / 주의사항 / 실행 가능 여부 / 다음 질문 제안 섹션으로 현업 친화 구성.
- **장기 분석**: `POST /admin/dw/clickhouse` 로 일별 rollup 을 ClickHouse HTTP 인터페이스(JSONEachRow)로 적재(`CLICKHOUSE_URL` 설정 시).
- **관리**: 어드민 `Text2SQL` 탭 + `GET /admin/text2sql`(프로필·통계·로그·모델 메트릭), 스키마 카탈로그/레지스트리 `(/admin/text2sql/schemas|tables|columns|collect)`, 런타임 프로필 `(/admin/text2sql/profiles)`, 골든 쿼리 `(/admin/text2sql/golden[/run])`.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `TEXT2SQL_ENABLED` | `false` | Text2SQL 모드 활성화 |
| `TEXT2SQL_PREVIEW_MODEL` | `gpt-4.1-mini` | preview 업스트림 모델 |
| `TEXT2SQL_EXECUTE_MODEL` | `gpt-4.1-mini` | execute 업스트림 모델 |
| `TEXT2SQL_ACCURATE_MODEL` | `claude-sonnet-4` | accurate 업스트림 모델 |
| `TEXT2SQL_LOCAL_MODEL` | `qwen-coder` | local 업스트림 모델 |
| `TEXT2SQL_SUMMARY_MODEL` | `gpt-4.1-mini` | 실행 결과 요약 모델 |
| `TEXT2SQL_DIALECT` | `PostgreSQL` | SQL 방언 |
| `TEXT2SQL_SCHEMA` | 없음 | 인라인 스키마 컨텍스트(카탈로그 미사용 시) |
| `TEXT2SQL_DEFAULT_LIMIT` | `100` | 자동 LIMIT |
| `TEXT2SQL_MAX_LIMIT` | `1000` | 명시 LIMIT 상한 / 실행 행 cap |
| `TEXT2SQL_MAX_EXPLAIN_COST` | `0` | (postgres) EXPLAIN 총비용 상한, 0=미적용 |
| `TEXT2SQL_MASK_RESULTS` | `true` | 실행 결과 PII 마스킹 |
| `TEXT2SQL_EXEC_DRIVER` | `postgres` | execute용 DB 드라이버 |
| `TEXT2SQL_EXEC_DSN` | 없음 | execute용 read-only DSN(미설정 시 preview만) |

## MCP Gateway (프로토콜 집약 게이트웨이)

LLM 게이트웨이이자 **MCP 게이트웨이**입니다. 여러 업스트림 MCP 서버를 단일 `/mcp` 엔드포인트(JSON-RPC 2.0, Streamable HTTP) 뒤에 모아, 클라이언트(Claude Code·Cursor 등)는 게이트웨이 한 곳에만 연결합니다.

- **집약·네임스페이스**: 등록된 모든 업스트림의 `tools/list`·`prompts/list` 를 합쳐 `<업스트림ID>__<이름>` 로 노출, `resources/list`·`resources/templates/list` 도 집약(원본 URI 보존). 충돌 없이 한 목록으로 제공.
- **라우팅**: `tools/call`·`prompts/get` 은 네임스페이스로, `resources/read` 는 URI로 해당 업스트림에 라우팅(전체 타임아웃·세션 핸드셰이크/세션ID 자동 관리).
- **정책 재사용**: 기존 MCP allowlist/차단 정책(서버 라벨=업스트림 이름)으로 게이트웨이 호출을 차단.
- **통합 관측·귀속**: 모든 호출을 `tool_invocations` 파이프라인으로 로깅 → MCP 탭(서버/도구/루프/카탈로그)·사용자 귀속·세션에 그대로 합산. 메트릭 `proxy_mcp_tool_calls_total` 등.
- 지원 메서드: `initialize`(tools+resources+prompts capability 광고) / `tools/list`·`tools/call` / `resources/list`·`resources/read`·`resources/templates/list` / `prompts/list`·`prompts/get` / `ping`. 인증은 `/v1` 과 동일하게 proxy key.

등록(어드민 MCP 탭 또는 API):

```powershell
curl.exe http://localhost:8080/admin/mcp/upstreams `
  -H "Content-Type: application/json" `
  -d '{ "name": "github", "url": "https://mcp.example.com/github/mcp", "auth_token": "ghp_..." }'
```

클라이언트는 MCP 서버 URL 로 `http://<gateway>:8080/mcp` 하나만 설정하면 됩니다. (현재 Streamable HTTP 업스트림 지원; stdio 서브프로세스는 향후 과제)

## VCS 상관 (Prompt → Commit → MR → Merge)

단순 게이트웨이를 넘어 **프롬프트가 실제 코드/MR 로 이어졌는지** 추적합니다. 오프라인망의 **GitLab·Bitbucket(Server/Cloud)** 과 범용 수집을 모두 지원합니다(외부 의존성 0).

- **자동 감지(설정 불필요)**: 에이전트 대화에 `git commit -m "…"` · `git push` 가 보이면 게이트웨이가 **추론(inferred) 이벤트**로 자동 기록하고 현재 세션·사용자에 연결합니다. `VCS_INFER_FROM_CONTENT`(기본 `true`)로 끌 수 있습니다. (커밋 SHA·URL·MR/머지 상태는 없음 — 정식 연동으로 보완)
- **수집 활성화(정식: MR·머지 상태·URL)**: `VCS_WEBHOOK_SECRET` 설정 → `/vcs/*` 엔드포인트 활성화.
  - GitLab: 프로젝트 웹훅 URL `http://<gateway>:8080/vcs/webhook/gitlab`, Secret Token = `VCS_WEBHOOK_SECRET` (Push·Merge request events).
  - Bitbucket: 웹훅 URL `http://<gateway>:8080/vcs/webhook/bitbucket?token=<VCS_WEBHOOK_SECRET>` (PR·push; Server `pr:*`/`repo:refs_changed`, Cloud `pullrequest:*`/`repo:push`).
  - 범용/CI·git 훅: `POST /vcs/events` (헤더 `X-Vibe-VCS-Secret`) 로 `{provider,kind,repo,branch,sha,title,session_id?}` 또는 `{events:[...]}`.
- **세션 연결**: 커밋 메시지·MR 제목·브랜치에 `Vibe-Session: <id>`(또는 `[vibe:<id>]`) 마커를 넣으면 그 세션에 연결되고, 세션의 **주 사용자(api_key)** 까지 자동 연결됩니다. 범용 수집은 `session_id` 를 직접 지정 가능.
- **표시**: 세션 타임라인 모달에 "연결된 VCS(커밋/MR)" 표(유형·제목·저장소·작성자·시각, MR 상태 배지). API: `GET /admin/vcs/events?session_id=&repo=&api_key_id=`.

이로써 `Prompt → Response → Commit → MR → Merge` 전 구간을 한 게이트웨이에서 연결합니다.

## 사용자·IP 별 이력 조회

```powershell
# 사용자(Proxy API 키) 단위 사용량
curl.exe http://localhost:8080/admin/users
curl.exe http://localhost:8080/admin/users/key_xxxxxxxx?limit=100

# IP 단위 사용량
curl.exe http://localhost:8080/admin/ips
curl.exe http://localhost:8080/admin/ips/203.0.113.10?limit=100

# 호출 단건 상세 (프롬프트 전문 + 응답 메타 포함)
curl.exe http://localhost:8080/admin/requests/req_xxxxxxxx

# 프롬프트 키워드 검색 (마스킹 텍스트 / 원문 모두 검색)
curl.exe "http://localhost:8080/admin/prompts?q=login&language=Go&limit=20"
```

어드민 UI(`/admin`)의 사용자 / IP / 호출 이력 / 프롬프트 검색 탭에서 동일한 데이터를 시각적으로 확인할 수 있고, 행 클릭 시 단건 모달로 프롬프트 전문이 펼쳐집니다.

## 사용 한도(Quota)

API 키 / 팀 / IP / 전체 단위로 일별·월별 토큰 또는 KRW 한도를 걸 수 있습니다. 한도 평가 기준 시각은 Asia/Seoul 입니다. 초과 시 `HTTP 429` + `Retry-After`(초) + `X-Quota-Scope`, `X-Quota-Tokens`, `X-Quota-Cost-KRW`, `X-Quota-Period-Start`, `X-Quota-Period-End` 헤더를 함께 반환합니다.

```powershell
# 알리스 키에 월 30,000원 한도
curl.exe http://localhost:8080/admin/quotas `
  -H "Content-Type: application/json" `
  -d '{ "scope": "api_key", "scope_value": "key_xxxxxxxx", "period": "monthly", "krw_limit": 30000, "enabled": true, "note": "Alice 월 한도" }'

# 플랫폼 팀 일별 1,000,000 토큰
curl.exe http://localhost:8080/admin/quotas `
  -H "Content-Type: application/json" `
  -d '{ "scope": "team", "scope_value": "platform", "period": "daily", "token_limit": 1000000, "enabled": true }'

# 전체 게이트웨이 월 1,000,000원 안전망
curl.exe http://localhost:8080/admin/quotas `
  -H "Content-Type: application/json" `
  -d '{ "scope": "global", "scope_value": "*", "period": "monthly", "krw_limit": 1000000, "enabled": true, "note": "조직 안전망" }'
```

쿼터 비활성/삭제는 `PATCH /admin/quotas/{id}` / `DELETE /admin/quotas/{id}` 또는 어드민 UI의 "사용 한도" 탭에서 가능합니다. 현재 기간 누적치와 남은 비율은 같은 탭의 진행률 막대로 시각화됩니다.

### 월 예산 소진 예측 (Budget Burn-down)

쿼터가 "도달 시 차단"하는 경성 한도라면, 예산은 "현재 추세면 월말에 얼마 쓸지"를 예측·경고하는 연성 관측 도구입니다(차단 없음). 전체 / 팀 / API 키 단위로 월 예산(KRW)을 등록하면, 월초(KST) 대비 누적 지출과 일평균 소진율을 월말까지 연장한 **예상 지출**·**소진 예상일**을 어드민 "사용 한도" 탭에서 보여줍니다.

```powershell
# 플랫폼 팀 월 예산 500,000원
curl.exe http://localhost:8080/admin/budgets `
  -H "Content-Type: application/json" `
  -d '{ "scope": "team", "scope_value": "platform", "monthly_krw": 500000, "note": "플랫폼팀 월 예산" }'

# 예산 현황(예측 포함) 조회
curl.exe http://localhost:8080/admin/budgets
```

응답의 각 항목은 `spent_krw`(누적), `burn_ratio`(누적/예산), `projected_krw`(월말 예상), `projected_ratio`(예상/예산), `exhaustion_date`(소진 예상일, 이번 달 안일 때만), `on_track`(예산 이내 추세 여부)를 포함합니다. 삭제는 `DELETE /admin/budgets/{id}`. 안전 탭의 알림 지표 `budget_burn_ratio`(등록된 예산 중 최대 `projected_ratio`)로 임박 경보를 Webhook 통지할 수 있습니다.

## 보존 정책 (Retention)

오래된 행을 자동 삭제해 SQLite/Postgres 비대를 방지합니다. 기본값은 요청 90일, 프롬프트 30일, 응답 30일이며 `RETENTION_*` 환경변수로 조정합니다. cleanup 워커는 `RETENTION_INTERVAL`(기본 1시간) 주기로 실행되고, `/admin/retention` 으로 상태 조회 + 수동 트리거가 가능합니다.

```powershell
curl.exe http://localhost:8080/admin/retention
curl.exe -X POST http://localhost:8080/admin/retention
```

## 호출 이력 CSV 익스포트

회계·감사 보고를 위해 호출 이력을 CSV 로 내려받을 수 있습니다. CSV에는 `first_chunk_ms`와 `latency_ms`가 함께 포함되며, UTF-8 BOM 이 포함되어 Excel 에서 바로 한글이 깨지지 않고 열립니다. 어드민 UI 의 프롬프트 검색 탭에서 "CSV 다운로드" 버튼으로도 이용 가능합니다.

```powershell
curl.exe -OJ "http://localhost:8080/admin/export.csv?since=2026-06-01T00:00:00Z&limit=5000"
```

지원 쿼리: `q`(키워드), `api_key_id`, `ip`, `language`, `since`(RFC3339), `limit`(기본 1000, 최대 10000).

## 백업

운영 중 SQLite 파일과 fallback ndjson 을 안전하게 받아내는 헬퍼 스크립트가 있습니다. `sqlite3` 가 있으면 `.backup` 명령으로 일관 사본을 만들고, 없으면 파일 복사로 대체하면서 경고를 남깁니다. 보존 일수가 지난 백업은 자동 삭제합니다.

```powershell
pwsh -File scripts/backup.ps1 -DataDir data -OutDir backups -KeepDays 14
```

```bash
./scripts/backup.sh -d data -o backups -k 14
```

## 변경사항

### v0.1.26 Stability Release

- 문서 링크 정리, 운영자 Quick Start, Routing Explain/Governance 예제 보강.
- `vibe/auto` 점수·provider health·fallback 금지 조건 회귀 테스트 확대.
- Governance 정책 충돌 우선순위 `BLOCK > APPROVAL > ALLOW > DEFAULT` 고정 및 allow 감사 이벤트 기록.
- inferred session DB 영속화와 재시작 복구 추가.

### 이전 v0.1.x

- OpenAI 호환 프록시, Datadog형 LLM Observability, Intelligent Routing, Auth/RBAC, Governance Layer, MCP Gateway, 비용/쿼터/백업 운영 기능을 단계적으로 추가.

## Docker 빌드와 오프라인망 릴리즈

`scripts/release.ps1` (Windows / PowerShell) 또는 `scripts/release.sh` (Linux / macOS) 가 다음을 한 번에 수행합니다.

1. 멀티스테이지 `Dockerfile` 로 distroless 런타임 이미지 빌드
2. `docker save` 로 OCI tar 추출 후 `gzip -9` 압축
3. `release/<image>-<version>.tar.gz`, `.sha256`, `README-offline-<version>.md` 산출

```powershell
pwsh -File scripts/release.ps1 -Version v0.1.0
```

```bash
./scripts/release.sh -v v0.1.0 -p linux/amd64
```

산출물 예시:

```
release/
  ai-coding-proxy-gateway-v0.1.0.tar.gz
  ai-coding-proxy-gateway-v0.1.0.tar.gz.sha256
  README-offline-v0.1.0.md
```

### 폐쇄망 적재

1. `release/` 폴더 전체를 폐쇄망 서버로 복사 (USB / 망연계 시스템 등)
2. 체크섬 확인

   ```bash
   sha256sum -c ai-coding-proxy-gateway-v0.1.0.tar.gz.sha256
   ```

3. 이미지 적재

   ```bash
   gunzip -c ai-coding-proxy-gateway-v0.1.0.tar.gz | docker load
   ```

4. 실행 (단일 컨테이너)

   ```bash
   docker run -d --name proxy-gateway --restart=always \
       -p 8080:8080 \
       -v /opt/proxy-gateway/data:/data \
       -e UPSTREAM_BASE_URL=https://api.openai.com \
       -e UPSTREAM_API_KEY=sk-... \
       -e ADMIN_TOKEN=change-me \
       -e GATEWAY_SECRET=$(openssl rand -hex 32) \
       -e MODEL_PRICING_KRW_PER_1M='{"gpt-4.1-mini":{"input_krw_per_1m":540,"output_krw_per_1m":2160}}' \
       ai-coding-proxy-gateway:v0.1.0
   ```

5. 또는 `docker-compose.yml` 과 함께 운영

   ```bash
   export GATEWAY_VERSION=v0.1.0
   export UPSTREAM_API_KEY=sk-...
   export ADMIN_TOKEN=change-me
   export GATEWAY_SECRET=$(openssl rand -hex 32)
   export MODEL_PRICING_KRW_PER_1M='{"gpt-4.1-mini":{"input_krw_per_1m":540,"output_krw_per_1m":2160}}'
   docker compose up -d
   ```

데이터는 `/data` 볼륨에 SQLite 파일과 fallback NDJSON 로 보관되므로 컨테이너를 재기동해도 누적 통계가 유지됩니다.
