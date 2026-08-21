# 업스트림 프로바이더 라우팅 · 폴백 가이드

요청 하나가 처리되는 순서는 딱 세 단계입니다.

```
① provider 선택  →  ② 업스트림 호출  →  ③ 실패 시 조건부 폴백
```

이 문서는 각 단계의 규칙을 전부 한 곳에 모읍니다. 어드민 화면에서는 **설정 탭 → 업스트림 프로바이더 → `📖 라우팅 · 폴백 동작 설명 열기`** 버튼으로 같은 내용을 모달로 볼 수 있습니다.

---

## 1. provider 선택 순서

위에서부터 먼저 걸리는 규칙이 이깁니다. 선택 근거는 응답 헤더 `X-Route-Reason` 과 요청 로그의 `route_reason` 에 그대로 기록됩니다.

| 순위 | 선택 방법 | 조건 | `route_reason` |
|---|---|---|---|
| 1 | `X-Proxy-Provider` 헤더 | 클라이언트가 provider 이름을 직접 지정 | `header` |
| 2 | `?provider=` 쿼리 | URL 쿼리로 지정 | `query` |
| 3 | 라우팅 규칙 | 복잡도 기반 규칙이 provider를 지정 | `rule_provider` |
| 4 | **모델 패턴 자동 매칭** | 요청 body의 `model` 이 provider의 `model_patterns` 글롭에 매칭 | `model_pattern` |
| 5 | 기본 provider | 위 어디에도 걸리지 않을 때 `UPSTREAM_PROVIDER` | `default` |

모델이 `auto` / `vibe/auto` / `vibe-coders/auto` 이면 그 앞에서 Intelligent Routing 이 **모델**을 먼저 고르고(`auto_router`), 그렇게 정해진 모델로 위 순서를 탑니다.

### 여러 패턴이 동시에 매칭되면

**provider 이름 알파벳 오름차순으로 첫 번째**가 선택됩니다 (`ORDER BY name ASC`). 지연시간이나 health 점수 순이 아닙니다. 우선순위를 바꾸려면 provider 이름을 조정하세요 (예: `a-primary`, `b-backup`).

어드민의 **모델 패턴 충돌 진단** 패널이 겹치는 패턴과 현재 승자를 보여주고, 모델명을 입력하면 실제 경로를 시뮬레이션합니다.

---

## 2. 폴백(failover) 발동 조건

아래 **네 가지를 모두** 만족할 때만 다른 provider로 재시도합니다. 하나라도 어긋나면 폴백은 일어나지 않습니다.

| 조건 | 내용 | 어긋나면 |
|---|---|---|
| provider 미고정 | `X-Proxy-Provider` · `?provider=` 를 **쓰지 않아야** 함 | 고정한 곳으로만 보내고 폴백 안 함 |
| 민감정보 아님 | 프롬프트에서 PII·secret 위험이 탐지되지 않아야 함 | 데이터 보호를 위해 폴백 차단 (`fallback_disabled:sensitive_data`) |
| **매칭 provider 2개 이상** | 같은 모델명에 `model_patterns` 가 매칭되는 provider가 **둘 이상** | **폴백 후보 0개** — 가장 흔한 원인 |
| 실패 유형 해당 | 429 · 5xx · 타임아웃 · 연결 실패 | 401/403/404 같은 **4xx는 폴백하지 않음** |

폴백 시도 순서 역시 **provider 이름 알파벳 오름차순**입니다.

### 왜 "매칭 provider 2개 이상"이 중요한가

폴백 후보는 **`model_patterns` 매칭으로만** 만들어집니다. 기본 provider라고 해서 자동으로 후보가 되지 않습니다. 따라서:

- 기본 provider의 `model_patterns` 가 비어 있으면 → 그 provider는 폴백을 **받을 수도, 넘길 수도** 없습니다.
- `openai: gpt-*` / `anthropic: claude-*` 처럼 패턴이 **겹치지 않으면** → 한 모델에는 항상 1개만 매칭되므로 폴백이 발생하지 않습니다.

폴백을 원한다면 같은 모델을 두 provider가 받도록 **패턴을 의도적으로 겹쳐야** 합니다.

---

## 3. 폴백이 안 되는 흔한 이유

| 증상 | 원인 | 해결 |
|---|---|---|
| 폴백이 전혀 안 됨 | 기본 provider에 `model_patterns` 가 비어 있음 | 기본 provider에도 패턴을 넣고, 대체 provider와 **겹치게** 등록 |
| provider가 2개인데 폴백 안 됨 | 패턴이 서로 겹치지 않음 (`gpt-*` / `claude-*`) | 같은 모델을 양쪽이 처리하도록 동일·중첩 패턴 등록 |
| 401/404인데 폴백 안 됨 | 키 오류·모델 없음은 다른 곳도 결과가 같아 폴백 대상이 아님 | 키와 모델명을 직접 수정 |
| SDK에서 고정했더니 폴백이 사라짐 | 클라이언트가 `X-Proxy-Provider` 를 전송 중 | 헤더를 빼고 모델 패턴 자동 라우팅에 위임 |
| 민감한 요청만 폴백 안 됨 | PII·secret 탐지로 의도적 차단 | 정상 동작. 필요하면 프롬프트에서 민감정보 제거 |

어드민 프로바이더 화면의 **폴백 커버리지** 표시가 provider별로 폴백 상대가 있는지(`✅` / `⚠️ 폴백 상대 없음`)를 바로 보여줍니다.

---

## 3-1. 회로 차단기 · 폴백 예산 (v0.76.58)

폴백이 "되기는 하는데 느리다"는 문제를 다루는 두 장치입니다.

### 회로 차단기 (Circuit Breaker)

기본 활성(`UPSTREAM_BREAKER_ENABLED=true`). 장애가 난 provider를 **폴백 후보에서 자동으로 제외**합니다. 이것이 없으면 죽은 provider를 매 요청마다 다시 호출하고, 매번 타임아웃을 전부 소모한 뒤에야 폴백이 시작됩니다.

| 상태 | 의미 |
|---|---|
| `closed` (정상) | 연속 실패를 세는 중 |
| `open` (차단됨) | 후보에서 제외. `UPSTREAM_BREAKER_COOLDOWN`(기본 30초) 동안 유지 |
| `half_open` (복구 확인 중) | 유지 시간 경과. **요청 1건만** 흘려보내 확인 — 성공하면 정상, 실패하면 즉시 재차단 |

- 차단 조건: **연속 실패 `UPSTREAM_BREAKER_THRESHOLD`회**(기본 5). 실패로 세는 것은 폴백 트리거와 동일하게 429 · 5xx · 타임아웃 · 연결 실패입니다. **4xx는 세지 않습니다** — 키 오류나 모델 없음은 어느 provider로 가도 같은 결과라, 이걸로 차단하면 멀쩡한 provider를 내리게 됩니다.
- **모든 provider가 차단되면 최초 provider는 그래도 시도합니다.** 아무도 호출하지 않으면 복구를 감지할 방법이 없고, 복구 가능한 장애가 스스로 만든 전면 장애가 되기 때문입니다.
- 상태는 **메모리에만** 있습니다(인스턴스별). 재시작하면 과거 판정을 물려받지 않고 다시 탐침합니다.
- 확인·해제: 라우팅 탭 → `Provider Health` → **회로 차단기** 패널. 개별/전체 해제 버튼이 있고, API는 `POST /admin/routing/breaker-reset` (`{"provider":"이름"}`, 비우면 전체)입니다. 차단이 발생하면 Mattermost `provider` 카테고리로 알립니다.

### 응답 헤더 대기 상한

`UPSTREAM_RESPONSE_HEADER_TIMEOUT`(기본 60초)은 업스트림 **응답 헤더**를 기다리는 시간만 제한합니다. `UPSTREAM_TIMEOUT`(기본 10분)은 스트리밍 본문까지 포함한 전체 시간이라 낮출 수 없는데, 먹통 provider가 요청을 붙잡는 구간은 바로 헤더 대기입니다. 이 값만 조이면 **긴 스트리밍을 자르지 않으면서** 폴백이 빨리 시작됩니다.

### 폴백 예산

`UPSTREAM_FAILOVER_BUDGET`(기본 `0` = 무제한)은 **대체 provider를 시도하는 데 쓸 총 시간**의 상한입니다. 예산이 소진되면 남은 후보를 더 돌지 않고 마지막 결과를 그대로 반환하며, `fallback_path`에 `failover_budget_exhausted:<provider>`가 남습니다.

요청 단위로는 `X-Failover-Budget-MS` 헤더로 덮어쓸 수 있습니다.

```bash
# 이 요청은 폴백에 최대 2초까지만 쓴다
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer dev-proxy-key" \
  -H "X-Failover-Budget-MS: 2000" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4.1-mini","messages":[{"role":"user","content":"hi"}]}'
```

예산은 **시도와 시도 사이**에만 검사하므로, 이미 응답이 오고 있는 요청을 중간에 끊지 않습니다.

---

## 4. 응답 헤더로 확인하기

어드민을 열지 않고 클라이언트에서 바로 라우팅 결과를 확인할 수 있습니다.

| 헤더 | 의미 |
|---|---|
| `X-Provider` | **실제로 응답한 provider** |
| `X-Route-Reason` | 선택 근거: `header` · `query` · `model_pattern` · `rule_provider` · `default` |
| `X-Route-Detail` | 매칭된 글롭 패턴이나 근거(헤더명·환경변수명) |
| `X-Failover-From` | 폴백이 일어났을 때 **원래** 선택됐던 provider |
| `X-Failover-Reason` | 폴백 유발 원인: `429` · `5xx` · `timeout` · `transport_error` · `context_overflow` |
| `X-Failover-Path` | 실제 폴백 경로 전체 (`429:a-primary->b-backup` 형태, 쉼표 구분) |

폴백이 없었다면 `X-Failover-*` 는 **아예 나오지 않습니다**. 즉 헤더 유무 자체가 폴백 발생 여부입니다.

```bash
curl -i http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer dev-proxy-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4.1-mini","messages":[{"role":"user","content":"hi"}]}' \
  | grep -i '^x-provider\|^x-route\|^x-failover'
```

---

## 5. 구성 레시피

### ① 단일 벤더 (폴백 불필요)

기본 provider 하나만 등록하고 패턴은 비웁니다. 모든 모델이 기본으로 갑니다. 폴백은 없습니다.

### ② 벤더별 분리 라우팅 (폴백 없음)

```
openai      model_patterns = gpt-*,o3-*
anthropic   model_patterns = claude-*,anthropic/*
```

모델별로 정확히 나뉘지만, 한 모델에 1개만 매칭되므로 **폴백은 발생하지 않습니다**. 라우팅만 필요할 때 쓰는 구성입니다.

### ③ 이중화 (폴백 동작)

같은 모델을 두 곳이 받도록 **패턴을 겹칩니다**.

```
a-primary   base_url = https://api.openai.com        model_patterns = gpt-*
b-backup    base_url = https://backup.example.com    model_patterns = gpt-*
```

`a-primary` 가 429/5xx/타임아웃을 내면 `b-backup` 으로 넘어갑니다. **이름이 곧 우선순위**이므로 정렬을 의식해 짓는 것이 좋습니다.

### ④ 로컬 + 클라우드 (vLLM / Ollama)

로컬 서버를 `base_url` 에 **`/v1` 없이** 등록합니다 (게이트웨이가 `{base_url}/v1/...` 로 전달).

```
vllm     base_url = http://vllm:8000       model_patterns = bge-*,e5-*
ollama   base_url = http://ollama:11434    model_patterns = nomic-embed-*,mxbai-embed-*
```

임베딩(`/v1/embeddings`)도 채팅과 **완전히 동일한** 선택·폴백 규칙을 따릅니다.

---

## 6. 그 밖에 알아둘 것

### 컨텍스트 초과 자동 승급

업스트림이 400 + context length 초과를 반환하면, provider를 바꾸는 대신 **더 큰 컨텍스트 모델로 한 번** 재시도합니다 (`context_overflow:`). 위의 provider 폴백 조건과 무관하게 동작합니다.

### 계획(plan)과 실제(path)

- `fallback_plan` — *실패하면 이렇게 될 것*이라는 **사전 예측**. `/admin/routing/preview` 응답에 포함됩니다.
- `fallback_path` — *실제로 일어난* 폴백 경로. 폴백이 없었다면 **비어 있습니다**.

둘은 서로 다른 값이며 섞이지 않습니다.

### 폴백률 알림

폴백이 성공하면 호출자는 정상 응답을 받으므로 **장애가 감춰집니다.** primary가 죽은 채로 이중화 여유분만 소모되는 상태를 놓치지 않으려면, 안전 탭 → 알림 규칙에서 지표 **`폴백 발생률`(`failover_rate`)** 또는 **`폴백 발생 건수`(`failovers`)** 로 규칙을 만드세요. 예: scope `global`, 지표 `failover_rate`, 임계 `0.05`(5%), 윈도우 300초.

### 이름 주의 — `/admin/fallback`

설정 탭 아래의 **`Fallback 로그 재처리`(`/admin/fallback`)** 는 provider 폴백과 **무관합니다**. DB 장애 때 NDJSON으로 빠진 **감사 로그**를 다시 넣는 기능입니다.

---

## 7. 관련 화면 · API

| 대상 | 위치 |
|---|---|
| 모델 패턴 충돌 · 폴백 커버리지 진단 | 설정 탭 → 업스트림 프로바이더 |
| 라우팅 동작 설명 모달 | 설정 탭 → 업스트림 프로바이더 → `📖 라우팅 · 폴백 동작 설명 열기` |
| 특정 모델의 실제 경로 시뮬레이션 | 같은 패널의 `모델명 경로 확인` |
| `GET/POST /admin/routing/pattern-conflicts` | 패턴 충돌 · 폴백 커버리지 · 경로 시뮬레이션 |
| `POST /admin/routing/preview` | auto 모델 라우팅 미리보기 (`fallback_plan` 포함) |
| `GET /admin/routing/decisions` | 요청별 실제 라우팅 결정 · `fallback_path` |
| `GET /admin/routing/health` | provider health · fallback rate · degradation · **회로 차단기 상태** |
| `POST /admin/routing/breaker-reset` | 차단된 provider 수동 해제 |
| `GET /admin/requests/{id}/explain` | 개별 요청이 왜 그렇게 처리됐는지 |
