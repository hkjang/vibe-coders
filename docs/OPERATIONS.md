# 운영 가이드 (Operations)

AI 코딩 프록시 게이트웨이의 기동·종료·관측·백업·장애 대응 절차를 한 문서에 정리했습니다.

---

## 1. 사전 준비

| 항목 | 값 |
| --- | --- |
| Go 버전 | 1.26.8 (`go.mod` 기준) |
| OS | Linux / Windows / macOS |
| DB | SQLite (기본) 또는 PostgreSQL |
| 포트 | 기본 `:8080` (LISTEN_ADDR 로 변경 가능) |
| 데이터 위치 | 로컬 바이너리: `./data`; Docker: named volume `proxy-gateway-data` |

필수 환경변수는 단 두 가지입니다.

```bash
GATEWAY_SECRET=<openssl rand -hex 32>     # provider key 암호화 키 — 운영 필수
ADMIN_TOKEN=<openssl rand -hex 32>        # 어드민 API/UI 접근 토큰
```

`GATEWAY_SECRET` 은 한 번 정해지면 절대 바꾸면 안 됩니다(저장된 provider key 를 복호화 못 함). 운영 전에 반드시 안전한 값으로 고정하세요.

---

## 2. 기동 절차

### 2.1 로컬 개발 모드

```powershell
# Windows / PowerShell
$env:UPSTREAM_API_KEY = "sk-..."
$env:GATEWAY_SECRET   = "dev-only-secret"
$env:ADMIN_TOKEN      = "dev-admin"
go run ./cmd/gateway
```

```bash
# Linux / macOS
UPSTREAM_API_KEY=sk-... \
GATEWAY_SECRET=dev-only-secret \
ADMIN_TOKEN=dev-admin \
go run ./cmd/gateway
```

기동 로그에 `AI Coding Proxy Gateway listening addr=:8080 database=sqlite` 가 보이면 정상입니다.

### 2.2 바이너리 빌드

React `/app`까지 포함하는 직접 빌드는 frontend 산출물을 embed 경로에 먼저 overlay해야
합니다. 이전 hashed 파일은 제거하되 추적 중인 `.gitkeep`은 보존합니다.

```bash
corepack enable
pnpm --dir web install --frozen-lockfile
VITE_UI_VERSION=v0.81.0 pnpm --dir web build
find internal/appui/dist -mindepth 1 ! -name '.gitkeep' -delete
cp -R web/dist/. internal/appui/dist/
test -s internal/appui/dist/index.html
test -n "$(find internal/appui/dist/assets -type f -print -quit)"

GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath \
  -ldflags "-s -w -X vibe-coders/internal/proxy.AppVersion=v0.81.0" \
  -o gateway ./cmd/gateway
UI_APP_ENABLED=true ./gateway
```

생성된 `web/dist`와 `internal/appui/dist`의 overlay 파일은 ignore 대상이며 소스 자산으로
커밋하지 않습니다.

### 2.3 Docker

```bash
docker build --build-arg VERSION=v0.81.0 -t ai-coding-proxy-gateway:v0.81.0 .

export GATEWAY_VERSION=v0.81.0
export UPSTREAM_API_KEY='<실제 upstream key>'
scripts/init-deployment-env.sh /opt/proxy-gateway/gateway.env
docker volume create proxy-gateway-data >/dev/null
docker run -d --name proxy-gateway --restart=always \
  -p 8080:8080 \
  --mount source=proxy-gateway-data,target=/data \
  --env-file /opt/proxy-gateway/gateway.env \
  ai-coding-proxy-gateway:v0.81.0
```

Dockerfile은 Node 24+pnpm frozen frontend builder → Go 1.26.8 embed builder → distroless
nonroot의 3-stage 구조입니다. React 정적 에셋은 Go 바이너리에 포함되고 운영
컨테이너에는 Node.js가 없습니다. `/app`은 기본 OFF이므로 Preview가 필요할 때만
`UI_APP_ENABLED=true`를 지정합니다. `/admin`은 설정과 무관하게 계속 제공됩니다.

### 2.4 docker compose

`docker-compose.yml`도 단일 컨테이너 실행과 정확히 같은 실제 named volume
`proxy-gateway-data`를 사용합니다. 운영 비밀값은 저장소의 `.env`가 아니라 권한 0600인
`/opt/proxy-gateway/gateway.env`에 고정합니다.

```bash
export GATEWAY_VERSION=v0.81.0
export UPSTREAM_API_KEY='<실제 upstream key>'
scripts/init-deployment-env.sh /opt/proxy-gateway/gateway.env
docker compose --env-file /opt/proxy-gateway/gateway.env up -d
docker compose --env-file /opt/proxy-gateway/gateway.env logs -f gateway
```

초기화 스크립트는 새 secret을 원자적으로 만들고, 기존 파일이면 필수 키와 64자리 secret을
검증한 뒤 요청한 `GATEWAY_VERSION` 행만 원자 갱신합니다. 기존 secret은 회전하지 않습니다.
개발용 Compose에서만 같은 스크립트에 저장소의 `.env`
경로를 넘길 수 있으며 이 경우에도 권한은 0600이어야 합니다. 운영 중에는
`docker compose down -v`를 실행하지 마세요.

### 2.5 오프라인망 적재

운영 망에 인터넷이 없을 때는 외부에서 릴리즈 패키지를 만들어 옮깁니다.
릴리스 빌드 호스트에는 Docker, Bash, curl, Python 3가 필요하며 Node.js와 jq는
Docker builder 외부에 설치할 필요가 없습니다.

```bash
# 인터넷이 되는 환경에서 산출
./scripts/release.sh -v v0.81.0 -p linux/amd64
# 기존 이미지·sha256·README + SBOM-v0.81.0.spdx.json +
# THIRD_PARTY_LICENSES-v0.81.0.md 생성
```

폐쇄망 서버에서:

```bash
sha256sum -c ai-coding-proxy-gateway-v0.81.0.tar.gz.sha256
gunzip -c ai-coding-proxy-gateway-v0.81.0.tar.gz | docker load
docker run -d ... -e UI_APP_ENABLED=true ai-coding-proxy-gateway:v0.81.0
```

---

## 3. 기동 후 헬스체크

```bash
curl -fsS http://localhost:8080/health     # {"status":"ok"}
curl -fsS http://localhost:8080/ready      # {"status":"ready"}
curl -fsS http://localhost:8080/metrics    # Prometheus exposition
```

부팅이 정상이면 `/ready` 가 200 을 반환합니다. DB 가 잠시 끊겨도 `/ready` 는 503, `/health` 는 그대로 200 입니다.

기동 직후 두 관리자 UI와 Next Console deep link를 확인하세요.

```
Legacy Stable Console: http://<host>:8080/admin
Next Console Preview:  http://<host>:8080/app/
```

```bash
curl -fsSI http://localhost:8080/app
curl -fsS http://localhost:8080/app/providers >/dev/null
curl -fsS http://localhost:8080/admin >/dev/null
```

`/app`은 기본 OFF이며 위 Preview 확인에는 `UI_APP_ENABLED=true`가 필요합니다.
`ADMIN_TOKEN` 을 설정한 경우 UI 상단의 "관리자 토큰" 입력란에 그 값을 넣어야 데이터를 받아옵니다.
릴리스 빌드 호스트에서는 `bash scripts/container-smoke.sh <image> <version>`으로 redirect,
deep link, hashed asset cache, 버전 일치와 `/admin` fallback까지 검증합니다.

---

## 4. 종료 절차

### 4.1 로컬 / 바이너리

콘솔에서 `Ctrl+C` (SIGINT) 또는 `kill -TERM <pid>` (SIGTERM). 게이트웨이는 다음을 보장합니다.

1. HTTP 서버에 graceful shutdown (15초 타임아웃)
2. 비동기 감사 로그 큐를 끝까지 flush — drop 카운트는 `/metrics` 의 `proxy_log_events_dropped_total` 으로 확인 가능
3. 보존 워커 / 알림 워커 stop

이상이 정상 종료입니다. `kill -KILL` 은 마지막 수단입니다(미flush 큐가 fallback ndjson 으로 빠집니다).

### 4.2 Docker

```bash
docker stop proxy-gateway      # SIGTERM 후 10초 grace
docker logs proxy-gateway --tail=20
docker rm proxy-gateway        # 컨테이너 제거 (이미지/데이터는 유지)
```

### 4.3 docker compose

```bash
docker compose --env-file /opt/proxy-gateway/gateway.env stop gateway
docker compose --env-file /opt/proxy-gateway/gateway.env down  # volume 보존; -v 금지
```

### 4.4 검증

종료 후 다음을 확인:

```bash
test "$(docker volume inspect --format '{{.Name}}' proxy-gateway-data)" = proxy-gateway-data
test -z "$(docker ps -q --filter volume=proxy-gateway-data)"  # 실행 중 사용자가 없어야 함
```

Docker 데이터는 호스트의 `data/` 디렉터리가 아니라 named volume 안에 있습니다. 파일을
확인하려고 임의 helper 이미지를 실행하지 말고 6절의 backup 스크립트로 검증된 사본을
만드세요. `/data/fallback.ndjson`에 데이터가 남았다면 다음 기동 후 설정 탭의
"Fallback 로그 재처리" 또는 `POST /admin/fallback`으로 DB에 재반영합니다.

---

## 5. 관측 (Observability)

### 5.1 Prometheus 메트릭 — `/metrics`

| 메트릭 | 의미 |
| --- | --- |
| `proxy_requests_total` | 누적 프록시 요청 수 |
| `proxy_stream_requests_total` | SSE 스트리밍 요청 수 |
| `proxy_upstream_errors_total` | upstream 오류 (502/504 등) |
| `proxy_quota_blocked_total` | 쿼터로 차단된 요청 (429) |
| `proxy_kill_switch_blocked_total` | Kill switch 로 차단된 요청 (503) |
| `proxy_alerts_fired_total` | 알림 규칙 발화 횟수 |
| `proxy_alerts_delivered_total` | webhook 전송 성공 |
| `proxy_llm_evaluations_total` | 프로세스가 관측한 LLM evaluation 누적 수 |
| `proxy_llm_evaluation_failures_total` | 프로세스가 관측한 실패 LLM evaluation 누적 수 |
| `proxy_log_queue_depth` | 비동기 로그 큐 잔량 (gauge) |
| `proxy_log_events_dropped_total` | 큐 가득 차서 drop 된 감사 로그 |
| `proxy_log_events_written_total` | DB 에 쓰인 감사 로그 |
| `proxy_request_duration_ms` | 전체 요청 지연 히스토그램 |
| `proxy_first_chunk_duration_ms` | upstream 첫 응답 청크 지연 히스토그램 |

권장 알람: `proxy_log_events_dropped_total > 0` (5분 윈도우), `proxy_upstream_errors_total` 의 분당 증가, `proxy_log_queue_depth > 80% of LOG_QUEUE_SIZE`, `proxy_first_chunk_duration_ms` P95 급증.

### 5.2 어드민 알림

`/admin/alerts` 에서 게이트웨이 자체 알림 규칙을 설정하면 외부 모니터링 없이도 Slack/Teams/사내 웹훅으로 즉시 통보합니다. 자체 알림 지표에는 `requests/errors/krw/tokens`, 지연 기반 `latency_p95_ms/first_chunk_p95_ms`, LLM 평가 기반 `llm_eval_failures/llm_eval_failure_rate`, MCP/도구 기반 `tool_errors/tool_error_rate/tool_loop/mcp_new_tools`, 이상 탐지 `anomaly_zmax`, 예산 소진 예측 `budget_burn_ratio`(등록된 예산 중 최대 *월말 예상/월 예산* 비율), 업스트림 폴백 `failovers`/`failover_rate`(폴백은 성공하면 호출자에게 정상 응답이 가므로 장애가 감춰집니다 — 폴백률 알림을 권장) 가 포함됩니다. 자세한 사용법은 [관리자 가이드](./ADMIN_GUIDE.md) 참조.

### 5.2.1 이상 탐지 (Anomaly Detection)

`/admin/anomalies` 는 모델별 요청당 비용·전체 지연·첫 청크 지연을 최근 윈도우(기본 1시간) 와 장기 기준선(기본 7일) 으로 비교해 z-score 가 임계(기본 3) 를 넘는 항목을 반환합니다. 대시보드의 "이상 징후" 카드에도 표시되며, `anomaly_zmax` 알림 지표로 임계 초과 시 통보할 수 있습니다.

```bash
curl "http://localhost:8080/admin/anomalies?baseline=7d&recent=1h&z=3"
```

기준선 표본이 일정해도(분산 0) 평균의 5% 를 최소 노이즈로 두어 진짜 급증을 놓치지 않습니다. 최소 표본(기준선 20건, 최근 5건) 미만 모델은 노이즈 방지를 위해 제외됩니다.

### 5.3 LLM Observability

어드민의 **LLM 관측** 탭과 API는 Datadog LLM Observability의 운영 기능을 게이트웨이 내부 데이터로 제공합니다.

```bash
curl "http://localhost:8080/admin/llm/traces?limit=100"
curl "http://localhost:8080/admin/llm/sessions?limit=100"
curl "http://localhost:8080/admin/llm/prompts?limit=100"
curl "http://localhost:8080/admin/llm/patterns?limit=50"
curl "http://localhost:8080/admin/llm/insights?window=24h&limit=50"
curl "http://localhost:8080/admin/llm/timeseries?window=24h&bucket=hour"
curl "http://localhost:8080/admin/llm/feedback?limit=100"
curl "http://localhost:8080/admin/llm/evaluations?limit=100"
```

운영 권장:

- agent/chat 단위로 `X-LLM-Session-ID` 를 넣어 세션별 비용·오류·평가 실패를 묶습니다.
- 프롬프트 템플릿은 `X-LLM-Prompt-Name`, `X-LLM-Prompt-Version` 또는 body의 `metadata._dd.ml_obs.prompt_tracking` 로 버전 추적합니다.
- gateway-managed evaluation 실패가 많은 session/prompt/pattern을 우선 조사합니다.
- 사람이 직접 본 품질 판단은 `POST /admin/llm/feedback` 로 남겨 운영 피드백과 자동 평가를 분리해 봅니다.
- 사내 평가기나 CI가 별도 품질 점수를 계산한다면 `POST /admin/llm/evaluations` 로 제출해 같은 trace detail에서 보이게 합니다.

### 5.4 로그 위치

- 표준 출력 (slog JSON 또는 텍스트). systemd / docker logs / 컨테이너 stdout 로 수집하세요.
- 비상시 로컬 바이너리는 `data/fallback.ndjson`, Docker는 named volume 내부
  `/data/fallback.ndjson` — DB 쓰기가 실패하거나 비정상 종료 시 마지막 보루.

Fallback 상태 확인과 재처리:

```bash
curl http://localhost:8080/admin/fallback
curl -X POST http://localhost:8080/admin/fallback
```

재처리 결과의 `imported` 는 DB 에 새로 들어간 로그, `duplicates` 는 이미 DB 에 있어 제거한 로그, `failed` / `remaining` 은 파일에 남겨둔 라인입니다.

---

## 6. 백업 / 복구

Docker 운영 데이터는 `proxy-gateway-data` named volume에 있고 비밀값은
`/opt/proxy-gateway/gateway.env`(0600)에 있습니다. 둘은 한 복구 단위이므로 함께
백업합니다. distroless 런타임에는 shell이나 tar가 없기 때문에
`scripts/backup-volume.sh`는 지정한 gateway 이미지를 **실행하지 않은 carrier
container**로만 만들고 `docker cp`를 사용합니다. 외부 helper 이미지는 필요하지 않습니다.

### 6.1 Docker named volume 백업

SQLite 일관성을 위해 먼저 gateway를 중지합니다. stopped gateway container가 volume을
참조하는 것은 허용되지만 실행 중인 container가 하나라도 있으면 스크립트가 중단합니다.

```bash
docker compose --env-file /opt/proxy-gateway/gateway.env stop gateway
scripts/backup-volume.sh backup \
  --image ai-coding-proxy-gateway:v0.81.0 \
  --volume proxy-gateway-data \
  --env-file /opt/proxy-gateway/gateway.env \
  --output-dir /opt/proxy-gateway/backups
docker compose --env-file /opt/proxy-gateway/gateway.env start gateway
```

산출물은 `gateway-volume-<UTC>-<pid>.tar.gz`와 같은 이름의 `.sha256`입니다. archive는
SQLite header/가능한 경우 `PRAGMA quick_check`, 내부 파일 checksum, volume 이름을
포함합니다. `gateway.env`도 들어 있으므로 두 파일 모두 0600으로 보관하고 별도 매체에
암호화해 복제하세요. 이미지 태그는 `latest`가 아닌 현재 배포된 정확한 태그를 사용합니다.

로컬 바이너리의 `./data`만 백업할 때는 기존 `scripts/backup.sh -d data -o backups`를
사용할 수 있습니다. 이 host-directory 절차를 Docker named volume에 사용하지 마세요.

### 6.2 Docker named volume 복구

복구 스크립트는 다음을 모두 확인하기 전에는 volume을 삭제하지 않습니다.

- 대상 volume의 정확한 이름, local driver 및 archive에 기록된 source volume
- archive와 sidecar SHA256, 허용된 경로/파일 형식, 내부 checksum 및 SQLite 상태
- 현재/백업 `GATEWAY_SECRET` 일치(불일치 시 명시적인 `--restore-env` 필요)
- volume을 참조하는 container가 전혀 없음
- 정확한 확인 문구 `RESTORE proxy-gateway-data`

```bash
# container만 제거하고 volume은 유지합니다. 절대로 -v를 붙이지 않습니다.
docker compose --env-file /opt/proxy-gateway/gateway.env down

scripts/backup-volume.sh restore \
  --image ai-coding-proxy-gateway:v0.81.0 \
  --volume proxy-gateway-data \
  --env-file /opt/proxy-gateway/gateway.env \
  --output-dir /opt/proxy-gateway/backups \
  --archive /opt/proxy-gateway/backups/gateway-volume-<UTC>-<pid>.tar.gz \
  --confirm 'RESTORE proxy-gateway-data'

docker compose --env-file /opt/proxy-gateway/gateway.env up -d
curl -fsS http://localhost:8080/ready
curl -fsS http://localhost:8080/admin >/dev/null
```

삭제 직전 스크립트는 현재 volume과 env의 `gateway-volume-prerestore-*` 안전 archive를
자동 생성합니다. 백업의 env까지 되돌리겠다고 결정한 경우에만 `--restore-env`를
추가하세요. 이 명시적 옵션은 현재 env가 분실되거나 손상된 재해복구도 지원하며, archive의
검증된 env를 0600 파일로 원자적으로 복원합니다. 이때 현재 env가 유효하지 않으면 복구 전
안전 archive의 configuration source에도 그 사실을 기록합니다. 복구 실패 시 volume을
임의로 다시 삭제하지 말고 출력된 안전 archive를 보존해 원인을 조사합니다. 수동
`docker volume rm`이나 `docker compose down -v`로 이 검증 절차를 우회하지 마세요.

`GATEWAY_SECRET`이 백업 시점과 다르면 provider key를 복호화할 수 있으므로 기본 복구는
fail closed로 중단합니다.

### 6.3 PostgreSQL 사용 시

`POSTGRES_DSN=postgres://user:pass@host:5432/db?sslmode=disable` 또는 `DATABASE_URL` 을 설정하면 자동으로 PostgreSQL 을 사용합니다. SQLite 와 동일한 스키마가 자동 생성됩니다. 백업은 운영 중인 Postgres 의 표준 백업(pg_basebackup/pg_dump) 으로 수행하세요.

---

## 7. 보존 / Retention

오래된 행이 무한히 쌓이지 않도록 백그라운드 워커가 매 `RETENTION_INTERVAL` (기본 1시간) 마다 다음을 삭제합니다.

| 환경변수 | 기본값 | 대상 |
| --- | --- | --- |
| `RETENTION_REQUEST_DAYS` | 90 | request_logs + prompt/response/token/language/llm_evaluations/llm_feedback 자식 테이블 |
| `RETENTION_PROMPT_DAYS` | 30 | prompt_logs |
| `RETENTION_RESPONSE_DAYS` | 30 | response_logs |
| `RETENTION_DOMAIN_EXAMPLE_DAYS` | 365 | domain_examples — 라우팅 예시로 적립된 리닥션 프롬프트 텍스트 |
| `RETENTION_INTERVAL` | 1h | cleanup 워커 주기 |

`domain_examples` 는 프롬프트와 **다른 시계**로 정리됩니다. 이 표는 도메인 라우팅이 근거로 삼는 말뭉치라, 프롬프트 보존 창에 맞춰 같이 비우면 그 주기마다 라우팅 품질이 떨어집니다. 반대로 정리하지 않으면 원본 프롬프트가 삭제된 뒤에도 텍스트가 무기한 남습니다. 그래서 프롬프트보다는 길고 무한하지는 않은 별도 값을 씁니다.

값을 `0` 으로 두면 해당 항목은 정리하지 않습니다. 변경 후에는 게이트웨이 재기동이 필요합니다. 어드민 UI 설정 탭에서 "지금 정리 실행" 으로 수동 트리거할 수도 있습니다.

---

## 8. 장애 대응 (Runbook)

### 8.1 모든 호출 즉시 차단 (긴급 정지)

오작동한 사내 도구가 비용을 폭주시키는 경우 1초 안에 차단할 수 있습니다.

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"disabled":true,"reason":"릴리즈 롤백 중"}' \
  http://localhost:8080/admin/kill-switch
```

또는 어드민 UI → "안전" 탭 → "⚠️ 모든 /v1 호출 즉시 차단".

복귀:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"disabled":false}' \
  http://localhost:8080/admin/kill-switch
```

### 8.2 특정 사용자/팀/IP 만 차단

쿼터를 0 으로 두면 그 시점부터 모든 요청이 429 가 됩니다.

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"scope":"api_key","scope_value":"key_xxxx","period":"daily","krw_limit":1}' \
  http://localhost:8080/admin/quotas
```

또는 키 자체를 비활성화: 어드민 UI 사용자 탭 → 키 클릭 → 비활성화.

### 8.3 upstream 응답이 느림 / 5xx

1. `/metrics` 의 `proxy_upstream_errors_total` 분당 증가 확인
2. `/admin/providers` 에서 timeout_ms 조정
3. 어드민 "안전" 탭에서 모델별 알림 규칙 활성화 (`metric=errors, scope=model`)
4. 일시적으로 다른 provider 로 라우팅: provider 의 `model_patterns` 를 조정해 트래픽을 분기

### 8.4 DB 잠금 / 디스크 가득 참

SQLite 의 경우 디스크가 가득 차면 모든 쓰기가 실패하고 `fallback.ndjson` 으로 빠집니다.

1. `df -h` 로 디스크 확인
2. `RETENTION_*` 을 줄여 임시로 강제 정리: 어드민 → 설정 → "지금 정리 실행"
3. 디스크가 늘었으면 어드민 설정 탭의 "Fallback 로그 재처리" 또는 `POST /admin/fallback` 으로 누락 로그를 DB 에 반영합니다.

### 8.5 보안 사건 (키 유출 의심)

1. 어드민 사용자 탭에서 해당 키 즉시 "비활성화"
2. 어드민 설정 → 변경 이력 → 의심 시점부터 정렬 → CSV 다운로드
3. 프롬프트 탭에서 해당 키 ID 로 검색 + #의심 태그 부여
4. `GATEWAY_SECRET` 까지 유출되었다면 — provider key 모두 재발급 + DB 의 `provider_configs` 갱신

---

## 9. 보안 권장사항 (체크리스트)

- [ ] `GATEWAY_SECRET` 을 무작위 32바이트로 고정 (개발용 기본값 사용 금지)
- [ ] `ADMIN_TOKEN` 설정 + 운영자만 알도록 관리
- [ ] 회계/감사 부서에는 `ADMIN_READONLY_TOKEN` 별도 발급
- [ ] HTTPS 종단은 앞단의 Nginx / Traefik / Cloud LB 에 위임 (게이트웨이 자체는 HTTP)
- [ ] `LOG_RAW_PROMPTS=true`, `LOG_RAW_BODIES=true` 를 켤 경우 별도 DB 암호화 / 디스크 암호화 필수
- [ ] PII 마스킹 규칙 (한국 주민번호, 카드, 휴대전화, 이메일, AWS/GitHub 토큰 등) 은 기본 활성화 — 비활성화 옵션은 없습니다
- [ ] 백업 디렉토리도 동일 수준으로 보호 (DB 사본이므로)
- [ ] 게이트웨이의 `/admin*` 은 사내망에서만 접근 가능하도록 ACL/방화벽으로 분리
- [ ] Webhook URL 은 외부에 노출되지 않는 사내 Slack/Teams 채널로

---

## 10. 자주 묻는 운영 질문

**Q. 재기동 시 통계는 유지되나요?**
A. 네. SQLite/Postgres 에 모두 영구 저장되며 컨테이너만 갈아끼워도 같은 데이터 디렉토리만 마운트하면 그대로 이어집니다.

**Q. 게이트웨이가 다운되면 호출이 어떻게 되나요?**
A. 게이트웨이가 다운된 동안 클라이언트는 연결 실패를 받게 됩니다. HA 가 필요하면 여러 인스턴스를 띄우고 앞단에 LB 를 두세요. 그때는 SQLite 대신 PostgreSQL 을 권장합니다.

**Q. 로그가 너무 많이 쌓여요.**
A. `RETENTION_REQUEST_DAYS` 등을 줄이거나, 어드민 "설정 → 데이터 보존 정책 → 지금 정리 실행" 을 누르세요. 백업이 있다면 더 공격적으로 줄일 수 있습니다.

**Q. provider key 를 잃어버렸어요.**
A. 평문 키는 저장하지 않습니다. AES-GCM 으로 암호화된 형태만 보관하며 어드민에서도 노출되지 않습니다. 분실 시 vendor 측에서 새 키를 발급받아 어드민 "프로바이더" 폼에 재입력하세요.
