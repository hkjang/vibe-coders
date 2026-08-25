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
| **후보가 2개 이상** | 같은 `failover_group` 에 속하거나, 같은 모델명에 `model_patterns` 가 매칭되는 provider가 **둘 이상** (3-0절) | **폴백 후보 0개** — 가장 흔한 원인 |
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

## 3-0. 폴백 그룹 · 우선순위 (v0.76.63)

2절의 세 번째 조건("같은 모델에 매칭되는 provider가 2개 이상")은 **패턴이 우연히 겹쳐야만** 이중화가 생긴다는 뜻이었습니다. 가장 흔한 구성 — 기본 provider + 벤더별 provider 하나 — 은 패턴이 겹치지 않아 조용히 폴백이 0이었습니다.

이제 **폴백 그룹**으로 이중화를 명시 선언합니다.

| 필드 | 의미 |
|---|---|
| `failover_group` | 같은 이름을 가진 provider끼리 서로 폴백합니다. **패턴이 겹치지 않아도** 됩니다 |
| `priority` | 그룹 안 시도 순서. **낮을수록 먼저**. 기본 `100`. 같으면 이름순(모든 인스턴스에서 동일) |

```powershell
curl.exe http://localhost:8080/admin/providers `
  -H "Content-Type: application/json" `
  -d '{ "name": "h200-a", "base_url": "http://h200-1:8000", "api_key": "-", "enabled": true, "model_patterns": "core-h200", "failover_group": "h200-pool", "priority": 10 }'

curl.exe http://localhost:8080/admin/providers `
  -H "Content-Type: application/json" `
  -d '{ "name": "h200-b", "base_url": "http://h200-2:8000", "api_key": "-", "enabled": true, "model_patterns": "core-h200", "failover_group": "h200-pool", "priority": 20 }'
```

### 후보가 만들어지는 순서

1. 요청 모델에 `model_patterns` 가 매칭되는 provider (priority 오름차순)
2. 그중 하나라도 `failover_group` 에 속해 있으면, **같은 그룹의 나머지 provider** 도 후보에 추가

패턴 매칭이 먼저이므로 정확히 그 모델을 서비스하는 provider가 항상 우선하고, 그룹 동료는 그 뒤를 받칩니다. 그룹 덕분에 **각 provider의 글롭을 똑같이 유지할 필요가 없습니다** — 예: 평소엔 `core-h200` 만 받는 노드와 `spare-model` 도 받는 예비 노드를 한 그룹에 묶을 수 있습니다.

> **priority가 이름순을 대체합니다.** 이전에는 provider 이름 알파벳순이 곧 시도 순서라 `a-primary`/`b-backup` 처럼 정렬을 의식해 이름을 지어야 했습니다. 이제 이름과 무관하게 `priority` 로 지정하면 됩니다. 지정하지 않은 provider는 기본값 `100` 이므로, 명시적으로 앞당긴 것 뒤·뒤로 미룬 것 앞에 놓입니다.

### 커버리지 진단에서 구분됩니다

프로바이더 화면의 폴백 커버리지 표시가 세 가지를 구분합니다.

| 표시 | 의미 |
|---|---|
| ✅ | **폴백 그룹**으로 명시 선언된 이중화 |
| 🟡 | 패턴이 우연히 겹쳐 생긴 이중화 — **글롭을 고치면 사라질 수 있음** |
| ⚠️ | 폴백 상대 없음 |

🟡 는 동작은 하지만 의도한 구성이 아닙니다. 이중화가 필요하다면 같은 `failover_group` 을 지정해 ✅ 로 만드세요.

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
- 상태는 기본적으로 **메모리에만** 있습니다(인스턴스별). 재시작하면 과거 판정을 물려받지 않고 다시 탐침합니다.
- **인스턴스 간 공유** (`UPSTREAM_BREAKER_SHARED=true`, 기본 꺼짐): 한 인스턴스가 감지한 차단을 다른 인스턴스가 **자기 임계값만큼 실패해보지 않고** 바로 반영합니다. 자세한 내용은 아래 참고.
- 확인·해제: 라우팅 탭 → `Provider Health` → **회로 차단기** 패널. 개별/전체 해제 버튼이 있고, API는 `POST /admin/routing/breaker-reset` (`{"provider":"이름"}`, 비우면 전체)입니다. 차단이 발생하면 Mattermost `provider` 카테고리로 알립니다.

### 차단기 상태 인스턴스 간 공유

기본은 인스턴스별 독립 감지입니다. 인스턴스가 3대라면 provider 하나가 죽었을 때 **각자 임계값(기본 5회)만큼 실패**해야 알아차립니다 — 같은 사실을 세 번 발견하는 셈입니다.

`UPSTREAM_BREAKER_SHARED=true` 로 켜면 차단 **전환 시점에만** DB에 기록하고, 각 인스턴스가 `UPSTREAM_BREAKER_SYNC_INTERVAL`(기본 3초)마다 읽어 반영합니다. 요청마다 쓰기가 생기지 않습니다.

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `UPSTREAM_BREAKER_SHARED` | `false` | 차단 전환을 DB로 공유. **공유 DB가 전제**이므로 기본 꺼짐 |
| `UPSTREAM_BREAKER_SYNC_INTERVAL` | `3s` | 다른 인스턴스의 차단 상태를 읽는 주기 |

> **SQLite 단일 파일 배포에서는 켜지 마세요.** 인스턴스마다 DB가 따로라 공유할 대상이 없고 쓰기만 늘어납니다. 다중 인스턴스는 Postgres 같은 공유 DB가 전제입니다.

#### 동작 방식과 안전장치

동료의 차단 상태를 **그대로 받아들입니다(adopt).** 특별 취급하지 않고 로컬 상태로 채택하므로, 이후의 유지 시간·복구 탐침·해제가 **자기가 감지한 것과 완전히 동일한 경로**로 처리됩니다.

잘못된 판정이 퍼질 위험은 세 가지로 제한됩니다.

1. **로컬 증거가 우선입니다.** 이미 로컬에서 차단·탐침 중인 provider는 동료의 보고로 덮어쓰지 않습니다.
2. **오래된 보고는 무시됩니다.** 차단 유지 시간이 지난 보고, 그리고 죽은 인스턴스가 남긴 행(`updated_at` 기준)은 반영하지 않습니다 — 사라진 인스턴스가 provider를 영구 배제하지 못합니다.
3. **각자 복구를 확인합니다.** 유지 시간이 지나면 인스턴스마다 자기 탐침을 돌리고, **성공하면 공유 행을 지워** 모두에게 회복을 알립니다.

즉 특정 인스턴스만 네트워크 경로가 나빠 오판해도, 최대 유지 시간 한 번 뒤 다른 인스턴스의 탐침이 정정합니다. 관리자가 수동 해제하면 공유 행도 함께 지워집니다.

운영 화면의 회로 차단기 패널에 공유 여부와 이 인스턴스의 ID가 표시되고, 최근 원인에 `(peer ...)` 가 붙은 항목은 **다른 인스턴스가 감지해 받아들인 것**입니다.

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

## 3-1-1. Health 기반 강등 (v0.76.63)

회로 차단기는 **완전히 실패하는** provider를 뺍니다. 느리거나 가끔 5xx를 내는 **저하 상태**는 응답을 하므로 차단기가 건드리지 않고, 그래서 순서 맨 앞에 남아 매번 요청 하나와 그 지연을 낭비합니다.

`UPSTREAM_HEALTH_DEMOTE_THRESHOLD`(기본 `50`, `0`이면 비활성) 미만인 provider는 후보 목록의 **맨 뒤로 밀립니다.**

- **재정렬이 아니라 강등입니다.** `priority` 는 운영자가 선언한 의도이므로 순서 결정권을 유지하고, 정상/강등 두 그룹 **안에서는 priority 순서가 그대로** 보존됩니다.
- **제외하지 않습니다.** health는 후행 지표라, 시도하지 않는 provider는 회복해도 회복한 것을 알 수 없습니다.
- **이력이 없으면 강등하지 않습니다.** 윈도우 안에 트래픽이 없는 provider는 저하 증거가 없는 것이지 나쁜 것이 아닙니다.
- 강등이 일어나면 응답 헤더 `X-Health-Demoted` 에 이름이 실립니다. 보이지 않는 재정렬은 이 게이트웨이가 걷어내 온 불투명함 그 자체이기 때문입니다.

> health score 자체는 오래전부터 계산·표시되고 있었지만 **어떤 라우팅 결정에도 반영되지 않았습니다.** 이 강등이 그 첫 사용처입니다.

---

## 3-1-2. 폴백 리허설 (v0.76.63)

"우리 폴백 진짜 되나"를 **장애 전에** 확인합니다. 프록시가 실제로 걷는 후보 목록을 그대로 걸으면서 지정한 provider를 실패로 처리하고, 최종적으로 누가 요청을 처리하는지 보고합니다. **업스트림 호출은 발생하지 않고 아무것도 변경하지 않습니다.**

설정 탭 → 업스트림 프로바이더 → 모델명 입력 후 `폴백 리허설` 버튼. 결과 화면에서 provider별 `중단`/`복구` 버튼으로 시나리오를 바꿔가며 확인할 수 있습니다.

```bash
curl -X POST http://localhost:8080/admin/routing/failover-drill \
  -H "Content-Type: application/json" \
  -d '{"model":"core-h200","fail":["h200-a"]}'
```

| `outcome` | 의미 |
|---|---|
| `served` | 지정한 장애를 견디고 누군가 처리함 (`served_by`) |
| `exhausted` | 후보를 모두 소진 — 이 시나리오에서 요청이 실패합니다 |
| `no_redundancy` | 후보가 1개뿐 — 이 provider가 죽으면 폴백이 없습니다 |

`steps` 에는 시도 순서와 각 provider의 결과(`served` · `simulated_failure` · `skipped_breaker_open`)가, `health_demoted` 에는 health로 뒤로 밀린 provider가 담깁니다.

---

## 3-2. 로드밸런싱 · 세션 고정 (v0.76.59)

같은 모델(`core-h200` 등)을 여러 provider가 서비스할 때, 기본값은 **이름순 첫 번째로만** 보내고 나머지는 폴백 예비로만 씁니다(active-passive). `UPSTREAM_LOAD_BALANCE=round_robin` 으로 기동하면 active-active 풀이 됩니다.

```
gpu-a   base_url = http://h200-1:8000   model_patterns = core-h200
gpu-b   base_url = http://h200-2:8000   model_patterns = core-h200
gpu-c   base_url = http://h200-3:8000   model_patterns = core-h200
```

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `UPSTREAM_LOAD_BALANCE` | `first` | `first`(기존 동작) · `round_robin`(단일 인스턴스) · **`session_hash`(다중 인스턴스 권장)** |
| `UPSTREAM_STICKY_SESSIONS` | `true` | 세션을 처음 처리한 provider에 고정 |
| `UPSTREAM_STICKY_TTL` | `30m` | 고정 유지 시간(마지막 요청 기준) |

### 모드 선택 — 인스턴스가 몇 대인가

| 모드 | 배정 방식 | 다중 인스턴스 |
|---|---|---|
| `first` | 이름순 첫 번째 (분산 없음) | 안전 |
| `round_robin` | 프로세스 메모리의 회전 커서 | ❌ **깨짐** |
| `session_hash` | 세션 키로 provider를 계산(rendezvous 해시) | ✅ **안전** |

**게이트웨이를 2대 이상 띄운다면 `session_hash` 를 쓰세요.** `round_robin` 은 회전 커서와 세션 고정 맵을 프로세스 메모리에 두므로, 인스턴스마다 독립적으로 회전합니다. 같은 대화가 로드밸런서에 의해 다른 인스턴스로 들어가면 다른 provider로 보내져 **세션 고정이 깨지고 prefix 캐시가 매번 버려집니다.**

`session_hash` 는 provider를 세션 키에서 **계산**합니다 — `argmax(hash(세션키 + provider이름))`. 공유 저장소·조율이 전혀 없어도 모든 인스턴스가 같은 답을 내므로 고정이 자동으로 유지됩니다. modulo 대신 rendezvous(HRW) 해시를 쓰는 이유는 **풀이 바뀔 때 이동을 최소화**하기 위해서입니다 — provider 하나가 빠지면 그 provider에 있던 세션만 이동하고 나머지는 그대로입니다(modulo는 거의 전부 재배치).

분포는 회전처럼 완벽히 균등하지는 않고 해시 균등입니다. 세션 수가 적으면 편차가 보이지만 수가 쌓이면 고르게 수렴합니다.

### 왜 세션 고정이 필요한가

에이전트는 매 턴 대화 전체를 재전송합니다. 턴마다 다른 노드로 튀면 각 노드의 prefix/KV 캐시가 매번 버려져 지연과 비용이 늘고, 응답 성향이 대화 중간에 바뀔 수 있습니다. 그래서 **분산은 세션 단위로, 세션 안에서는 고정**입니다.

### 세션을 무엇으로 식별하는가

위에서부터 먼저 잡히는 것을 씁니다.

| 순서 | 출처 | `X-Session-Affinity` |
|---|---|---|
| 1 | 세션 헤더 (`X-Session-ID`, `X-LLM-Session-ID`, `X-Conversation-ID`, `X-Qwen-Code-Session-Id` 등) | `header` |
| 2 | body의 `session_id`·`chat_id`·`conversation_id`·`thread_id`(`metadata` 안 포함) | `body` |
| 3 | **대화 프리픽스 해시** — (시스템 프롬프트 + 첫 사용자 메시지 + API 키) | `conversation` |
| 3-1 | **요청 내용 해시** — 임베딩처럼 대화가 없는 요청에 (모델 + `input` + API 키) | `content` |
| 4 | 추론 세션(키+IP+UA+repo+branch) | `inferred` |

**3번이 qwen code 같은 에이전트의 실질 경로입니다.** qwen code는 일반 OpenAI 호환 엔드포인트에 세션 식별자를 보내지 않습니다 — 기본 provider가 붙이는 것은 `User-Agent: QwenCode/...` 와 사용자가 설정한 `customHeaders` 뿐이고, `metadata.sessionId` 를 body에 넣는 경로는 DashScope 전용입니다. 계획된 `X-Qwen-Code-Session-Id` 헤더도 Alibaba 1st-party 호스트로 범위가 좁혀져 있어 서드파티 게이트웨이에는 오지 않습니다.

추론 세션(4번)에 의존하면 같은 PC·같은 키에서 띄운 **동시 대화가 전부 하나로 뭉개져** 한 provider에 몰립니다. 대화 프리픽스 해시는 클라이언트 협조 없이 대화를 구분하며, 동시에 **같은 프리픽스를 같은 노드로 보내 vLLM 캐시 적중을 최대화**합니다.

**임베딩(`/v1/embeddings`)** 은 대화가 없어 3번이 걸리지 않습니다. 그대로 두면 한 클라이언트의 모든 임베딩이 4번(추론 세션)으로 **하나의 키에 뭉개져**, 배치 작업 전체가 프로바이더 한 대로만 갑니다 — 가장 병렬화하기 좋은 워크로드에서 로드밸런싱이 무력화됩니다. 그래서 요청 자신의 내용으로 키를 만듭니다(3-1).

- 서로 다른 입력은 풀 전체로 **분산**됩니다.
- 동일한 입력은 **같은 노드로** 가므로 업스트림 임베딩 캐시가 활용됩니다.
- 임베딩에는 유지할 대화가 없으므로 고정하지 않아 잃는 것이 없습니다.

> 클라이언트가 세션 헤더를 보낼 수 있다면 그게 가장 정확합니다. qwen code는 설정의 `customHeaders` 로 정적 헤더만 넣을 수 있어 대화별 값에는 쓸 수 없습니다.

### 고정이 풀리는 경우

- TTL(`UPSTREAM_STICKY_TTL`) 경과
- 고정된 provider가 **후보에서 빠짐** — 회로 차단기 open, 비활성화, 정책 변경 → 즉시 다른 provider로 재배치
- **폴백 발생** — 실제로 처리한 provider로 고정이 따라갑니다. 안 그러면 이후 모든 턴이 죽은 노드를 먼저 재시도합니다
- 운영자가 수동 해제

`X-Proxy-Provider`·`?provider=` 로 고정했거나 라우팅 규칙이 provider를 지정한 요청은 밸런서를 아예 거치지 않습니다.

### 다중 인스턴스에서 알아둘 것

`session_hash` 라도 **인스턴스별로 남는 상태가 두 가지** 있고, 둘 다 스스로 수렴합니다.

- **폴백 재고정** — 인스턴스 A에서 폴백이 일어나면 A만 그 세션을 실제 처리한 provider로 로컬 재고정합니다. B는 여전히 해시 값을 계산해 원래 provider를 시도하고, 실패하면 똑같이 폴백합니다. 즉 **B는 자기 회로 차단기가 열릴 때까지 몇 번 더 헛시도**합니다(기본 5회).
- **회로 차단기** — 인스턴스별 메모리입니다. 각 인스턴스가 독립적으로 장애를 감지합니다. 양쪽 차단기가 열리면 후보 집합이 같아지므로 해시 결과도 다시 일치합니다.

이 헛시도를 줄이려면 `UPSTREAM_BREAKER_THRESHOLD` 를 낮추세요(예: `2`). 완전한 즉시 동기화가 필요하면 차단기 상태 공유가 별도로 필요합니다 — 현재는 미구현입니다.

---

## 3-3. 라운드로빈이 잘 됐는지 확인하기

### 클라이언트에서

응답 헤더만 보면 됩니다.

| 헤더 | 값 |
|---|---|
| `X-Provider` | 실제 처리한 provider |
| `X-Route-Reason` | `sticky_hash`(해시로 결정, 모든 인스턴스 동일) / `round_robin`(회전 배정) / `sticky_session`(로컬 고정 — 폴백 후 재고정된 경우) |
| `X-Route-Detail` | `2/3` 같은 회전 위치, 또는 고정된 세션 표시 |
| `X-Session-Affinity` | 세션 식별 출처 — `header`/`body`/`conversation`/`content`(임베딩)/`inferred` |
| `X-Session-Affinity-Key` | 식별 키(앞 12자) |

같은 대화의 턴마다 `X-Provider` 가 유지되면 정상입니다(`session_hash` 모드면 계속 `sticky_hash`, 폴백을 겪은 세션은 `sticky_session`). 매 턴 `round_robin` 이면 세션 식별이 실패하는 것이므로 `X-Session-Affinity` 를 확인하세요.

### 운영자 화면

라우팅 탭 → **Provider Health** → `로드밸런싱 · 세션 고정` 패널.

- **균형도(balance index)** — 가장 적게 쓴 provider ÷ 가장 많이 쓴 provider. `100%`면 완전 균등, `0%`면 한 곳에 전부. 80% 이상이면 정상으로 봅니다
- **Provider 풀** — 어떤 모델 패턴이 몇 개 provider로 분산되는지. `provider 1개 — 분산 안 됨` 이면 패턴이 겹치지 않은 것입니다
- **실제 처리(로그) vs 밸런서 선택** — 앞은 `request_logs` 집계, 뒤는 밸런서가 고른 횟수입니다. 폴백·캐시 적중·provider 고정 요청은 밸런서를 거치지 않으므로 둘이 갈라질 수 있고, **그 차이가 곧 원인**입니다
- **고정 세션** 수와 **폴백 유입** 수
- `이 provider 비우기` — 특정 노드를 드레인할 때 고정 세션만 해제(다음 요청부터 다른 노드로 재배정)

API: `GET /admin/routing/balancer?model=core-h200&window=1h`

```json
{
  "mode": "round_robin",
  "sticky_sessions": true,
  "active_sessions": 3,
  "balance_index": 1,
  "pools":  [{ "pattern": "core-h200", "providers": ["gpu-a","gpu-b","gpu-c"], "size": 3, "balanced": true }],
  "intent": [{ "provider": "gpu-a", "picks": 6, "share": 0.33, "sessions": 1 }],
  "actual": [{ "provider": "gpu-a", "requests": 6, "failovers": 0, "avg_latency_ms": 120 }]
}
```

`POST /admin/routing/balancer` 에 `{"provider":"gpu-a"}` (비우면 전체)로 고정 세션을 해제합니다.

### 분산이 안 될 때 체크리스트

1. `mode` 가 `round_robin` 또는 `session_hash` 인가 (`UPSTREAM_LOAD_BALANCE`). 인스턴스가 2대 이상인데 `round_robin` 이면 그것이 원인입니다 — 패널에 경고가 표시됩니다
2. 세 provider가 **모두 enabled** 이고 `model_patterns` 가 **동일**한가 → `pools` 의 `size` 확인
3. 클라이언트가 `X-Proxy-Provider` 를 보내고 있지 않은가 → `X-Route-Reason` 이 `header` 면 그렇습니다
4. 회로 차단기가 provider를 빼고 있지 않은가 → 회로 차단기 패널 확인
5. 세션이 하나로 뭉개지지 않았는가 → `X-Session-Affinity` 가 `inferred` 면 대화 구분이 안 되는 상태입니다

---

## 3-4. 세션 ID를 업스트림에 전달 (`SESSION_INJECT_HEADER`)

qwen code처럼 **세션 식별자를 보내지 않는** 클라이언트의 요청은, 프로바이더 입장에서 매 턴이 서로 무관해 보입니다. 게이트웨이는 sticky 라우팅을 위해 이미 "이 요청이 어느 대화인지"를 계산하므로(§3-2), **그 값을 `X-Session-ID` 헤더로 업스트림에 함께 보냅니다.** 기본 활성(`SESSION_INJECT_HEADER=true`).

- **한 대화 = 한 ID.** 값은 대화 식별 키에서 유도되므로 **턴마다 바뀌지 않고**, 별도로 저장하는 상태도 없습니다. 매 턴 바뀌는 ID는 없느니만 못합니다 — 프로바이더에겐 매 요청이 새 세션으로 보이기 때문입니다.
- **클라이언트가 이미 보냈다면 건드리지 않습니다.** 클라이언트가 자기 대화를 식별하고 있다면 그쪽이 더 정확하므로 그대로 전달합니다.
- **응답에도 돌려줍니다.** `X-Session-ID` 와 `X-Session-ID-Source: gateway:conversation` 를 함께 내려주므로, 클라이언트가 그 값을 받아 다음 요청부터 직접 보낼 수도 있습니다.
- 업스트림이 모르는 헤더를 거부하는 환경이라면 `SESSION_INJECT_HEADER=false` 로 끕니다.

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

## 6-1. 재시작 없이 바꾸기 — 장애 중에 필요한 노브

이 문서의 환경변수 중 **장애 대응용 노브**는 기동 후에도 바꿀 수 있습니다.
**설정 → 런타임 설정** 화면의 `upstream` · `quota` 그룹에서 저장하면 재시작·재배포 없이 즉시 적용되고,
다중 파드에서는 각 파드가 다음 폴링 주기(`SETTINGS_RELOAD_INTERVAL`) 안에 따라옵니다.

| 키 | 대응 환경변수 | 언제 만지게 되는가 |
|---|---|---|
| `upstream.breaker_enabled` | `UPSTREAM_BREAKER_ENABLED` | 차단기가 멀쩡한 provider를 빼고 있을 때 임시로 끔 |
| `upstream.breaker_threshold` | `UPSTREAM_BREAKER_THRESHOLD` | 장애 provider를 더 빨리 빼고 싶을 때 낮춤 |
| `upstream.breaker_cooldown` | `UPSTREAM_BREAKER_COOLDOWN` | 회복이 느린 provider에 탐침 간격을 늘림 |
| `upstream.failover_budget` | `UPSTREAM_FAILOVER_BUDGET` | 재시도가 길어져 클라이언트가 먼저 끊길 때 조임 |
| `upstream.health_demote_threshold` | `UPSTREAM_HEALTH_DEMOTE_THRESHOLD` | 느려진 provider를 뒤로 미룸 |
| `upstream.load_balance` | `UPSTREAM_LOAD_BALANCE` | 분산을 켜거나(`session_hash`) 한 대로 몰 때(`first`) |
| `upstream.sticky_sessions` · `upstream.sticky_ttl` | `UPSTREAM_STICKY_SESSIONS` · `UPSTREAM_STICKY_TTL` | 고정 때문에 특정 provider에 쏠릴 때 |
| `quota.reservations_enabled` | `QUOTA_RESERVATIONS_ENABLED` | 쿼터 확인 부하를 줄이거나, 동시 요청 초과를 막을 때 |

**런타임에서 바꿀 수 없는 것 — 의도적입니다.** `UPSTREAM_BASE_URL` · `UPSTREAM_API_KEY` · `UPSTREAM_PROVIDER`
같은 **접속 정보**는 트래픽이 어디로 갈지를 정하고 기동 시 만들어진 클라이언트에 물려 있습니다.
임계값을 조정하는 것과 목적지를 바꾸는 것은 다른 종류의 변경이라, 접속 정보는 기동 설정으로 남겨 두었습니다.
provider를 추가·수정하려면 **설정 → 업스트림 프로바이더** 화면을 쓰세요(이쪽은 원래부터 런타임 반영입니다).

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
| `POST /admin/routing/failover-drill` | 폴백 리허설 — 지정한 provider 장애 시 누가 처리하는지 시뮬레이션 |
| `GET/POST /admin/routing/balancer` | 라운드로빈 분산 검증(균형도·풀·intent vs actual) · 세션 고정 해제 |
| `GET /admin/requests/{id}/explain` | 개별 요청이 왜 그렇게 처리됐는지 |
