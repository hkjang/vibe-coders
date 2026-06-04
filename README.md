# AI 코딩 프록시 게이트웨이

Roo Code / Cursor / Continue 등 OpenAI 호환 API 를 호출하는 VS Code 확장 및 AI 코딩 도구를 중간에서 초저지연으로 중계하면서 사용량·프롬프트·토큰·언어·호출 IP·비용(KRW) 을 추적하는 SSE 프록시 게이트웨이입니다. 폐쇄망 운영을 위한 오프라인 도커 이미지 릴리즈 패키지를 제공합니다.

## 문서

- **[운영 가이드](docs/OPERATIONS.md)** — 기동/종료, 헬스체크, 백업·복구, 장애 대응 런북
- **[사용자 가이드](docs/USER_GUIDE.md)** — Roo Code / Cline / Cursor / OpenAI SDK 연결, 본인 사용량 확인
- **[관리자 가이드](docs/ADMIN_GUIDE.md)** — 어드민 UI 탭 사용법, 일상/주간/월간 운영 체크리스트
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
- Datadog LLM Observability 대응 기능: Trace/Span Explorer, Session Explorer, Prompt Tracking, Patterns, Insights, managed evaluation, external evaluation submit API
- 강화된 PII 마스킹 (한국 주민번호·휴대전화·일반전화·사업자등록번호, 카드번호, 이메일, IPv4, JWT, PEM private key, AWS/GitHub/Slack/Anthropic/OpenAI 키)
- OpenAI `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens` 추적 + cached 단가 분리 KRW 비용 계산
- 모델 패턴(`claude-*`, `anthropic/*` 등) 기반 provider 자동 라우팅. 클라이언트가 `X-Proxy-Provider` 를 지정하지 않아도 모델명만으로 라우팅
- 호출 이력 CSV 다운로드 `/admin/export.csv` (Excel UTF-8 BOM 포함, 한국어 그대로 열림)
- 운영용 백업 스크립트 `scripts/backup.ps1` / `scripts/backup.sh` (SQLite `.backup` + fallback ndjson + 보존 일수 적용)
- `/health`, `/ready`, `/metrics`, `/admin`, `/admin/stats`, `/admin/requests`, `/admin/requests/{id}`, `/admin/prompts`, `/admin/export.csv`, `/admin/users`, `/admin/users/{id}`, `/admin/ips`, `/admin/ips/{ip}`, `/admin/llm/traces`, `/admin/llm/traces/{id}`, `/admin/llm/sessions`, `/admin/llm/prompts`, `/admin/llm/patterns`, `/admin/llm/insights`, `/admin/llm/evaluations`, `/admin/quotas`, `/admin/retention`, `/admin/fallback`, `/admin/api-keys`, `/admin/providers`, `/admin/audit-logs`

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
| `ADMIN_TOKEN` | 없음 | 설정 시 `/admin/*` Bearer 토큰 요구 (전권) |
| `ADMIN_READONLY_TOKEN` | 없음 | 설정 시 GET/HEAD 만 허용되는 읽기전용 admin 토큰 |
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
  - `g` 다음에 `d`(대시보드) / `l`(LLM 관측) / `r`(호출 이력) / `p`(프롬프트 검색) / `u`(사용자) / `i`(IP) / `q`(사용 한도) / `s`(설정)
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
curl.exe "http://localhost:8080/admin/llm/prompts"
curl.exe "http://localhost:8080/admin/llm/patterns"
curl.exe "http://localhost:8080/admin/llm/insights?window=24h"
curl.exe "http://localhost:8080/admin/llm/evaluations"
```

`/admin/stats` 응답에는 기존 IP/모델/언어 외에 `by_status` (HTTP 상태 분포)와 `top_users` (상위 5 API 키) 가 포함됩니다.

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

Proxy API Key 발급:

```powershell
curl.exe http://localhost:8080/admin/api-keys `
  -H "Content-Type: application/json" `
  -d '{ "name": "Roo Code", "owner": "alice", "team": "platform" }'
```

응답의 `secret` 은 한 번만 확인할 수 있습니다.

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
