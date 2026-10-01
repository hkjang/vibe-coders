# 운영 가이드 (Operations)

AI 코딩 프록시 게이트웨이의 기동·종료·관측·백업·장애 대응 절차를 한 문서에 정리했습니다.

현재 버전 명령 예시는 `v0.86.35` 후보 소스 기준입니다. 실제 배포에는 해당 태그의 최종 검증과
게시된 자산을 확인하고, 후보 문서만으로 운영 업그레이드나 `/app`의 Stable 승격을 진행하지 마세요.

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
VITE_UI_VERSION=v0.86.35 pnpm --dir web build
find internal/appui/dist -mindepth 1 ! -name '.gitkeep' -delete
cp -R web/dist/. internal/appui/dist/
test -s internal/appui/dist/index.html
test -n "$(find internal/appui/dist/assets -type f -print -quit)"

GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath \
  -ldflags "-s -w -X vibe-coders/internal/proxy.AppVersion=v0.86.35" \
  -o gateway ./cmd/gateway
UI_APP_ENABLED=true ./gateway
```

생성된 `web/dist`와 `internal/appui/dist`의 overlay 파일은 ignore 대상이며 소스 자산으로
커밋하지 않습니다.

### 2.3 Docker

```bash
docker build --build-arg VERSION=v0.86.35 -t ai-coding-proxy-gateway:v0.86.35 .

export GATEWAY_VERSION=v0.86.35
export UPSTREAM_API_KEY='<실제 upstream key>'
scripts/init-deployment-env.sh /opt/proxy-gateway/gateway.env
docker volume create proxy-gateway-data >/dev/null
# 기존 볼륨·바인드 마운트를 재사용할 때 소유권을 nonroot(65532)로 복구합니다. 새 볼륨은 변경 없이 끝납니다.
docker run --rm --user 0:0 --mount source=proxy-gateway-data,target=/data \
  ai-coding-proxy-gateway:v0.86.35 repair-data-dir
docker run -d --name proxy-gateway --restart=always \
  -p 8080:8080 \
  --mount source=proxy-gateway-data,target=/data \
  --env-file /opt/proxy-gateway/gateway.env \
  ai-coding-proxy-gateway:v0.86.35
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
export GATEWAY_VERSION=v0.86.35
export UPSTREAM_API_KEY='<실제 upstream key>'
scripts/init-deployment-env.sh /opt/proxy-gateway/gateway.env
docker compose --env-file /opt/proxy-gateway/gateway.env up -d
docker compose --env-file /opt/proxy-gateway/gateway.env logs -f gateway
```

초기화 스크립트는 새 secret을 원자적으로 만들고, 기존 파일이면 필수 키와 64자리 secret을
검증한 뒤 요청한 `GATEWAY_VERSION` 행만 원자 갱신합니다. 기존 secret은 회전하지 않습니다.
개발용 Compose에서만 같은 스크립트에 저장소의 `.env`
경로를 넘길 수 있으며 이 경우에도 권한은 0600이어야 합니다. 운영 중에는
`docker compose down -v`를 실행하지 마세요. 이전 배포의 볼륨이나 바인드 마운트를 이어받는다면
`up -d` 전에 2.3의 `repair-data-dir` 1회 실행으로 소유권을 nonroot에 맞춥니다.

### 2.5 오프라인망 적재

운영 망에 인터넷이 없을 때는 외부에서 릴리즈 패키지를 만들어 옮깁니다.
릴리스 빌드 호스트에는 Docker, Bash, curl, Python 3, Grype 0.117.0이 필요하며 Node.js와
jq는 Docker builder 외부에 설치할 필요가 없습니다. 패키징 전에 Grype가 실제 최종
이미지의 High·Critical 취약점을 검사합니다.

```bash
# 인터넷이 되는 환경에서 산출
./scripts/release.sh -v v0.86.35 -p linux/amd64
# 기존 이미지·sha256·README + SBOM-v0.86.35.spdx.json +
# THIRD_PARTY_LICENSES-v0.86.35.md 생성
```

폐쇄망 서버에서:

```bash
sha256sum -c ai-coding-proxy-gateway-v0.86.35.tar.gz.sha256
gunzip -c ai-coding-proxy-gateway-v0.86.35.tar.gz | docker load
docker run -d ... -e UI_APP_ENABLED=true ai-coding-proxy-gateway:v0.86.35
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

이 엔드포인트는 읽기 전용입니다. 조회해도 이벤트를 기록하거나 알림을 보내지 않으므로, 대시보드를 여러 번 새로고침해도 중복 알림이 발생하지 않습니다. 이벤트 기록과 알림은 게이트웨이 내부 워커가 5분마다 자체적으로 수행하며(기준선 7일, 최근 1시간, z=3), 같은 항목은 최소 15분 안에 다시 기록되지 않습니다.

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

### 5.5 정책 시뮬레이션 결과 확인

Preview의 `/app/governance/policies?tab=advisor`에서 분석 기간을 선택한 뒤 추천의
`섀도우 영향`을 실행합니다. 결과의 `실행한 추천`·`실행한 규칙`·`실행한 분석 기간`은 그 실행의
기준입니다. 실패한 계산은 요청 ID를 확인하고 `다시 시뮬레이션`으로 수동 실행하세요.
실행 권한을 확인할 수 없거나 기간·사용자·화면 수명이 바뀌어 폐기한 응답을 자동으로 복원하거나
재전송하지 않습니다. 긴 결과는
`시뮬레이션 결과 읽기` 영역으로 Tab 이동한 뒤 방향키·PageDown으로 살펴볼 수 있습니다.

이 작업은 정책을 저장·적용하지 않는 과거 기록 계산입니다. 기능 읽기 전용에서도 기존
`admin:write`와 정책 화면 조회 권한이 있으면 허용합니다. 추천 GET의 `admin:read`만으로 계산
POST를 허용하는 것은 아닙니다. 초안 생성·캐너리 상향은 별도의 변경 작업입니다.

다음 한계를 확인한 뒤 운영 정책을 별도로 검토하세요.

- 기본 최대 5,000개의 조인 기록이며 고유 요청 전체를 뜻하지 않습니다. 상한에 도달해도 더 많은
  기록이 있었다고 단정할 수 없고, 시작 기준만 있으므로 같은 기간의 재실행도 표본이 달라질 수 있습니다.
- 사용자·역할·엔드포인트·비밀정보·MCP·비용 등 일부 조건의 당시 문맥은 복원되지 않습니다.
  조건이 무시되는 것이 아니라 빈값·기본값을 실제로 평가하므로 조건에 따라 일치 또는 불일치할 수 있습니다.
  차단 0건은 안전 보증이 아닙니다.
- 영향 키·팀 수와 오탐 후보는 차단 표본 기준이고, 팀은 현재 API 키 정보입니다. 오탐 후보는 과거
  성공(2xx) 기록이지 실제 오탐 판정이 아니며 과거 추정 비용은 청구액·미래 절감액이 아닙니다.
- 원문 표본은 새 결과 상태에 보관하지 않습니다. 표시 보호는 현재 접두사 기준이며 기존 원시 API
  전체의 개인정보 제거를 보장하지 않습니다. 권한 거부 감사까지 없다는 전역 무부수효과 주장도 하지 않습니다.

검증 범위와 운영 잔여 작업은 [인수 검증표](APP_UI_ACCEPTANCE.md)의 E2E-010을 따릅니다.

### 5.6 추천으로 비활성 정책 초안 생성

같은 어드바이저에서 추천의 `초안 생성`을 누르면 `비활성 정책 초안 생성` 검토창을 엽니다.
`검토한 추천`·`저장될 정책 이름`·`검토한 분석 기간`·`검토한 규칙`을 확인하세요. 열린 규칙은
목록을 다시 읽어도 다른 추천으로 바뀌지 않습니다. 기간·조회 기준이 달라지거나 쓰기 권한이
회수되면 자동 생성하지 않으며, 필요한 목록 조회와 `원래 규칙 다시 확인`을 거쳐 명시적으로 실행합니다.
긴 규칙은 `초안 생성 검토 읽기` 영역에 Tab으로 이동한 뒤 방향키·PageDown으로 읽을 수 있습니다.

이 작업은 저장을 수행하므로 기능 읽기 전용에서는 실행할 수 없습니다. 현재 `security:read`와
`admin:write`, 기능 소유자와 인증 상태를 초안 생성 API 호출을 시작하기 직전에 확인합니다. 추천 조회에는 별도로
`admin:read`가 필요합니다. 계정·세션·탭 수명이 바뀐 뒤의 오래된 콜백과 응답은 새 검토에 반영하지
않으며, 취소된 조회의 완료가 다음 검토의 조회를 대신하거나 잠그지 않게 합니다.

- 생성되는 정책은 비활성이며 실제 사용 전환은 정책 탭의 별도 작업입니다. 시뮬레이션 실행·성공은
  생성 요건이나 안전성 보증이 아닙니다. 검토한 분석 기간은 저장 API에 전송하지 않습니다.
- 오류와 요청 ID를 확인하되 응답 누락·형식 오류만으로 생성되지 않았다고 단정하지 마세요.
  먼저 정책 목록에서 확인하세요. 일반 오류·불명확한 응답 때문에 자동 재생성하지 않으며
  `다시 초안 생성`도 중복을 만들 수 있습니다. 기존 공유 클라이언트의 401 인증 갱신 후 재전송은 유지합니다.
  추천 식별자나 재확인은 서버의 멱등성·동시 변경 차단을 제공하지 않습니다.
- `비활성 정책 초안을 생성했습니다.` 뒤 목록 갱신만 실패했다면 다시 생성하지 마세요.
  `정책 목록 다시 조회`로 조회만 재시도합니다. 닫은 검토의 늦은 조회 응답은 새 검토를 바꾸지 않습니다.
- 현재 접두사로 검토 표시와 요청 ID를 보호하지만 원래 규칙 전송·서버 저장·별도 감사 원문을
  지우는 기능은 아닙니다. 규칙에 비밀값을 넣지 마세요. 정책과 감사의 원자적 저장도 새로 보장하지 않습니다.
- 서버 설정에 따라 기존 후속 모의 검사가 기록될 수 있습니다. 검사·감사 레코드와 최초 초기화의
  시드 설정·이력이 추가될 수 있으므로 정책 외 DB 쓰기가 없다고 해석하지 마세요.

사전 v0.86.30 라벨 후보에서 확인한 UI·합성 브라우저와 실제 Go HTTP 계약 검사는 서로 다른
검증입니다. 최종 v0.86.31 빌드·통합 회귀·CI·배포 자산 확인 전에는 릴리즈 완료로 보지 않습니다.

### 5.7 비활성 정책의 복수 규칙 편집

`/app/governance/policies`의 정책 목록에서 비활성 정책의 `초안 편집`을 엽니다. 추천으로 만든
초안도 이 경로에서 편집할 수 있습니다. `정책 이름`·`정책 설명`·`정책 우선순위`와 각 규칙의
이름·사용 여부·우선순위·`조건 JSON`·`동작 JSON`을 수정한 뒤 `변경 내용 검토`에서 변경 전후를
확인하고 `검토한 내용 저장`을 누릅니다. 변경이 없으면 저장 요청을 보내지 않습니다.

- 저장 API는 규칙 목록 전체를 교체합니다. 보존 가능한 미편집 규칙 ID와 JSON·알 수 없는 중첩
  필드는 유지하며, `규칙 추가`와 `규칙 삭제`의 명시적 확인으로 목록을 바꿉니다. 모든 규칙을
  비우려면 추가 확인이 필요합니다. 이는 정책 자체를 삭제하는 작업이 아니며 저장 후에도 정책은
  비활성입니다. 기존 적용 비율도 유지하고, 활성화·캐너리 변경은 별도 작업으로 남습니다.
- 현재 접두사 등 기존 표시 보호 기준에 해당하는 값은 원문을 입력란이나 비교에 표시하지 않습니다.
  그대로 유지하거나 `{필드명} 전체 교체`로 빈 입력부터 작성하세요. 보호 문구를 원문 대신 저장하지
  않으며, 새 민감정보로 보이는 값의 저장은 차단합니다. 표시 보호는 원래 규칙의 서버 저장·감사
  원문 제거를 뜻하지 않습니다. 서버 설정에 따라 기존 후속 모의 검사와 기록이 발생할 수 있습니다.
- 정책 ID가 서버 공백 정리로 바뀌는 경우에는 편집 진입을 막습니다. 정책 ID 변경·정책 삭제 기능이
  아닙니다. 규칙 ID나 JSON 최상위 키를 그대로 보존할 수 없다면 해당 규칙의 전체 교체·삭제 또는
  JSON 전체 교체 안내를 따르세요. 이름·설명의 공백 정리와 빈 정책 이름의 기본값은 전후 비교에
  실제 전송할 값으로 표시합니다. 안전하게 확인할 수 없는 숫자·필드는 임의 기본값으로 채우지 않습니다.
- 서버는 규칙이 없을 때 `rules`를 생략할 수 있으므로 이 생략만 빈 목록으로 해석합니다.
  `null`이나 다른 잘못된 형태까지 정상 빈 목록으로 취급하지 않습니다.
- 변경 중 취소·이동에는 기존 변경 폐기 보호를 사용합니다. 저장 API 호출을 시작하기 직전에 현재
  `security:read`·`admin:write`, 기능 소유자·읽기 전용·사용자·역할·팀·세션과 검토 승인을 확인하고,
  다시 조회한 원본이 같고 여전히 비활성인지 검사합니다. 원본이 바뀌거나 없어졌다면 닫은 뒤 최신
  목록에서 다시 편집하세요. 이 재조회는 동시에 발생하는 다른 변경까지 막는 기능은 아닙니다.
- `저장 여부를 확인할 수 없습니다.`가 나오면 미저장으로 단정하지 말고 `목록 다시 조회`로 먼저
  확인하세요. 명시적 재조회에서 원본 전체가 그대로임을 확인하기 전에는 재저장을 잠급니다.
  원본 변경·삭제나 조회 실패는 잠금을 풀지 않습니다. 이 확인도 서버의 동시 변경을 차단하지는 않습니다.
  일반 오류·불명확한 응답에 새 자동 재시도를 추가하지 않으며 기존 공유 클라이언트의
  401 인증 갱신 후 재전송은 유지합니다. `비활성 정책을 저장했습니다.` 뒤 조회만 실패했다면
  다시 저장할 필요 없이 목록 조회만 재시도하세요. 원문 JSON은 주소·브라우저 저장소·새 변경 요청
  캐시에 보관하지 않으며, 폐기된 계정·세션·화면의 오래된 콜백과 응답은 새 편집과 격리합니다.

통합 전 v0.86.31 라벨 후보에서 신규 UI 82개·관련 262개·전체 단위 2,677개(195파일), 전용 합성
브라우저 22개·전체 695개가 통과했습니다. 실제 Go·SQLite HTTP 7개와 하위 사례 16개의 정상/race
검사는 별도의 기존 서버 계약 근거입니다. 이후 최종 v0.86.32 `e1357ca1`의 통합 회귀·CI·태그와
7개 배포 자산을 확인해 게시했습니다. 이 출고만으로 `/app`의 Stable 승격이나 전체 단계 인수가
완료되지는 않으며 v0.86.34 후보 검증과도 구분합니다.

### 5.8 선택한 요청의 단계 기록

`/app/observability/traces`에서 요청의 `상세 보기`를 열면 `선택한 요청의 단계 기록`을
조회합니다. 읽기 전용에서도 기존 `admin:read` 권한과 팀 범위로 사용할 수 있습니다.
표의 `기록 시각`·`기록 상대 위치`·`기록된 지연`을 확인하고, 실패 시 `단계 기록 다시 조회`를
사용하세요. 좁은 화면에서는 `단계 표 가로 스크롤`에 초점을 두고 방향키로 표를 읽을 수 있습니다.

- 음수 상대 위치는 기록 시각이 요청 기준 시각보다 이른 기록입니다. 실제 저장·시작/종료 순서를
  복원한 것이 아니며 도구의 `소요 시간 미기록`은 지연 0과 다릅니다. 시간대는 표시만 바꾸고
  조회 조건의 UTC 나노초 시각은 보존합니다.
- 후보 요청은 최대 200개, 도구·텍스트 SQL은 각각 최대 100개의 후보를 확인합니다.
  같은 시각의 요청 후보가 상한을 넘으면 전체 조회를 거부합니다. 하위 `조회 상한 초과`와
  `표시 생략`은 서로 다른 제한이며 선택된 부분 집합의 최초·전체·항상 같은 순서를 보장하지 않습니다.
  하위 단계가 없다는 표시는 도구 실행 자체가 없었다는 뜻이 아닙니다.
- 목록 갱신 중에는 표를 유지하되 `이전 기록`으로 표시합니다. 목록 조회 실패·권한 회수·
  계정 변경 뒤의 옛 결과는 새 조회 근거가 아닙니다. 현재 목록을 먼저 정상 조회하세요.
- 이 화면은 새 읽기 전용 메타데이터 API를 사용합니다. 구버전 서버나 접근 불가 대상에서는
  안내를 표시하며 원문 추적 API로 자동 우회하지 않습니다. 올바른 형식의 미존재·범위 밖 대상·
  삭제·후보 초과는 같은 404 안내이며, DB/팀 식별 조회 오류는 기존 계약대로 500입니다.
- SQL 조회 열에는 프롬프트·응답·생성 SQL·도구 인자·원문 오류를 포함하지 않습니다.
  현재 접두사로 단계 이름을 보호하지만 모든 개인정보의 탐지, 기존 API·저장·감사의 원문 제거,
  완전한 분산 추적 또는 원자적인 전역 권한 취소를 보장하지 않습니다.

v0.86.33에서 이 조회를 출고했으며 세부 검증과 한계는 [인수 검증표](APP_UI_ACCEPTANCE.md)를 따릅니다.
운영 변경·기존 `/admin` 제거·자동 정식 승격은 포함하지 않습니다.

### 5.9 요청 상세창에서 처리 단계 보기 (`v0.86.34`)

`/app/observability/requests`에서 원하는 행의 `상세`를 연 다음 `처리 단계 보기`를 누릅니다.
상세를 여는 것만으로 추가 단계 조회를 시작하지 않습니다. 추적 ID가 없거나 비공개여도 유효한
v2 요청 참조와 원래 UTC 나노초 시각이 있으면 같은 창에서 기존 한글 단계 표와 기록 타임라인을
확인할 수 있습니다. 기존 `이 요청의 추적 보기`·요약·별도 비교·기존 화면 연결은 대체하지 않습니다.

- 같은 목록을 갱신 중일 때는 이전 기록을 읽을 수 있지만 단계 재조회는 잠깁니다. 목록 갱신에
  실패하면 이전 결과를 새로운 조회 근거로 쓰지 않으며 목록부터 정상 조회해야 합니다.
- 정상 새 목록, 필터 변경·계약 하향·현재 권한/팀/계정 변경에는 기존 선택을 폐기합니다.
  다시 행을 열어 `처리 단계 보기`를 눌러야 하며 갱신 시각이 우연히 같아도 이전 선택을 되살리지 않습니다.
- v1 목록이나 부적합한 원래 시각에는 요약만 제공하며 시각을 임의 보정하거나 원문 API로
  자동 우회하지 않습니다. 구버전·404·서버 오류에는 안내를 확인한 뒤 명시적으로 다시 조회하세요.
- 새 성공 단계 DTO는 제한된 메타데이터입니다. 기존 별도 비교·오류 캐시 전체가 무원문이라는
  의미는 아니며 원문 저장·감사·완전한 분산 추적·원자적인 전역 권한 취소를 보장하지 않습니다.

첫 조회 후 결과 영역으로 초점을 이동하며 다음 Tab으로 재조회 버튼에 접근할 수 있습니다.
Escape로 닫으면 현재 목록의 해당 행으로 돌아가고 행이 사라졌으면 결과 제목으로 돌아갑니다.
v0.86.34는 최종 메인 CI·이미지·공개 배포 자산 검증을 거쳐 출고했습니다. 운영 Stable 승격과
전체 Phase 인수는 별도입니다.

### 5.10 세션 목록의 조회 기준 확인 (`v0.86.35` 후보)

후보 화면은 요청한 기간과 실제 응답 기간을 나눠 안내합니다. 기간 전환 중 이전 표가 남으면
그 기간의 이전 결과로 표시하며, 새 기간 조회가 실패해 응답이 없으면 0건으로 표시하지 않습니다.
검색과 합계는 불러온 최대 200개 세션에 적용되며 전체 저장소 검색이나 전체 건수는 아닙니다.

URL의 기간·검색 조건이 바뀌면 입력도 맞추되 상세 여닫기·재조회에서는 미제출 초안을 유지합니다.
목록이 갱신 중이거나 현재 응답을 확인할 수 없으면 새 상세 열기를 안내와 함께 제한합니다.
이미 열린 상세와 직접 세션 연결은 목록 조회 실패와 별개로 유지합니다.

상세는 목록 기간과 별개인 세션의 제한된 최근 요청입니다. 목록·상세의 오류 집계 기준도
달라 합계가 반드시 같지는 않습니다. 기존 미리보기·상세·CSV의 마스킹 및 서버 권한 정책은
유지되며 이번 UI 개선으로 모든 원문·개인정보가 제거되거나 전체 기록이 보장되지는 않습니다.
이 후보의 단위·브라우저·최종 출고 검증은 진행 중입니다.

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
  --image ai-coding-proxy-gateway:v0.86.35 \
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
  --image ai-coding-proxy-gateway:v0.86.35 \
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

`v0.86.28`은 여러 인스턴스가 동시에 시작할 때 마이그레이션 잠금 대기가 다른 인스턴스의
동시 인덱스 생성을 막는 순환을 방지하도록 보강합니다. 마이그레이션의 상호 배제와 스키마는
유지합니다. 잠금 대기에서 호출자가 전달한 취소를 처리하지만, 전체 시작 시간 제한을 새로
설정하거나 다른 장기 트랜잭션 때문에 생기는 모든 대기를 제거하는 변경은 아닙니다.

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

### 8.6 컨테이너가 8080에서 뜨지 않음 (readonly database / 데이터 디렉터리 권한)

증상: 컨테이너가 `restart=always`로 재시작을 반복하고 `curl http://<HOST>:8080/ready`가 연결조차 되지 않습니다.
`docker logs --tail 20 proxy-gateway`에 다음 중 하나가 보입니다.

- `open database error="data directory /data is not writable by the gateway process (uid=65532 gid=65532); /data (owner 0:0, mode drwxr-xr-x) ..."`
- `migrate database error="attempt to write a readonly database (8)"` (v0.83.0 이하)

원인: 게이트웨이는 distroless nonroot(uid 65532)로 실행되는데 `/data`를 다른 사용자가 만들었거나 기록한 경우입니다.
대표적으로 root가 `mkdir`한 호스트 디렉터리를 `-v /opt/proxy-gateway/data:/data`로 바인드 마운트한 경우,
root로 실행한 다른 프로세스가 볼륨을 채운 경우, Kubernetes PVC를 `fsGroup` 없이 마운트한 경우입니다.
이미지에는 셸과 `chown`이 없으므로 게이트웨이 바이너리의 보조 명령으로 진단·복구합니다.

1. 진단 (nonroot로 실행되며 아무것도 바꾸지 않습니다)

   ```bash
   docker run --rm --mount source=proxy-gateway-data,target=/data \
     ai-coding-proxy-gateway:v0.86.35 check-data-dir
   ```

   사용 불가한 경로마다 소유자·권한과 원인을 출력하고 종료 코드 1을 반환합니다.

2. 복구 (root로 1회 실행, `/data` 이하를 65532:65532로 재소유하고 소유자 읽기·쓰기 비트를 복원)

   ```bash
   docker run --rm --user 0:0 --mount source=proxy-gateway-data,target=/data \
     ai-coding-proxy-gateway:v0.86.35 repair-data-dir
   ```

   변경한 항목을 모두 출력하며, 다시 실행해도 변경이 없습니다. 심볼릭 링크는 재소유만 하고 따라가지 않습니다.
   다른 uid로 실행하도록 이미지를 바꿨다면 `--uid`/`--gid`로 지정합니다.

3. 재검증 후 재기동

   ```bash
   docker run --rm --mount source=proxy-gateway-data,target=/data \
     ai-coding-proxy-gateway:v0.86.35 check-data-dir
   docker restart proxy-gateway
   curl -fsS http://<HOST>:8080/ready
   ```

바인드 마운트는 `--mount source=...` 대신 `-v /opt/proxy-gateway/data:/data`를 그대로 씁니다.
Kubernetes는 `securityContext.fsGroup: 65532`를 지정하거나 위 복구 명령을 initContainer(`runAsUser: 0`)로 실행합니다.
`LOG_FALLBACK_PATH` 디렉터리가 쓰기 불가하면 기동은 되지만 시작 시 WARN 로그가 남고 DB 장애 중 요청 로그가 유실되므로 같은 방법으로 복구합니다.

### 8.7 SSO 로그인 후 메뉴가 거의 사라짐 (역할 강등)

증상: Keycloak으로 로그인하면 `/admin`에 '내 홈' 정도만 남고 운영·보안·설정 메뉴가 보이지 않습니다.
`/auth/me`의 `role`이 `developer`(또는 `SSO_KEYCLOAK_DEFAULT_ROLE` 값)로 바뀌어 있고, 어드민 → 설정 → 변경 이력에
`sso_authorized ... role=developer` 이벤트가 남습니다.

원인: v0.82.1~v0.84.0은 SSO 로그인마다 저장된 역할을 클레임에서 계산한 역할로 덮어썼습니다. Keycloak 토큰의
realm/client 역할이 역할 매핑(`vibe-admin` → `admin` 등, 또는 관리자 화면의 역할 매핑)에 하나도 걸리지 않으면
기본 역할이 적용돼 콘솔에서 승격해 둔 `super_admin`까지 강등됐습니다. 팀도 groups 클레임이 없으면 비워졌습니다.

v0.84.0부터의 동작: 명시적 매핑은 상향·하향 모두 그대로 적용됩니다. 매핑이 없을 때는 **IdP가 직전 로그인에서
직접 부여했던 역할·팀만** 철회하고, 관리자가 콘솔에서 지정한 역할·팀은 유지합니다(Keycloak에서 역할을 제거한
경우의 회수는 그대로 동작합니다). 이미 강등된 계정은 자동으로 복구되지 않으므로 아래 중 하나로 되돌립니다.

1. 남아 있는 `super_admin`이 있으면 어드민 → 사용자 → 해당 계정 → 역할 변경.
2. 남은 관리자가 없으면 데이터 볼륨에 대해 보조 명령으로 역할을 지정합니다. 게이트웨이와 같은 env 파일을 쓰며
   기존 세션은 모두 종료되므로 다시 로그인합니다.

   ```bash
   docker run --rm --mount source=proxy-gateway-data,target=/data \
     --env-file /opt/proxy-gateway/gateway.env \
     ai-coding-proxy-gateway:v0.86.35 set-user-role --email admin@example.com --role super_admin
   ```

   PostgreSQL이면 같은 env 파일의 `DB_DSN`으로 접속하므로 볼륨 마운트 없이 실행합니다. 변경은 감사 이력에
   `role_repaired`로 남습니다.

재발 방지: Keycloak 역할을 내부 역할로 매핑해 두면(기본 매핑 `vibe-admin`→`admin` 등, 또는 어드민 → 설정 → SSO 화면의
역할 매핑) IdP가 역할의 단일 출처가 되어 이 구분이 필요 없습니다.

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
