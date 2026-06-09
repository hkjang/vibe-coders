# 관리자 가이드 (Admin Guide)

`http://<host>:8080/admin` 에 접속하는 운영 관리자를 위한 사용 설명서입니다. 한국어 UI 와 다중 탭으로 구성되어 있고, 모든 동작은 동일한 이름의 REST API 로도 자동화할 수 있습니다.

---

## 1. 첫 접속

1. 브라우저로 `http://<host>:8080/admin` 접속
2. 상단 우측 "관리자 토큰" 입력란에 `ADMIN_TOKEN` 값 붙여넣기
3. 데이터가 보이면 정상. 401 이 나오면 토큰이 잘못된 것입니다.

### 헤더의 운영 보조 도구

| 아이콘/버튼 | 기능 |
| --- | --- |
| 자동 새로고침 드롭다운 | 끔/5/10/30/60초 마다 현재 화면 다시 로드. 세션에 보관. |
| 🌓 / ☀️ | 라이트/다크 테마 전환 (`t` 단축키 동일). |
| `?` | 단축키 도움말 오버레이. |
| 관리자 토큰 | 입력값은 sessionStorage 에만 저장되고, 다른 탭/세션에는 공유되지 않습니다. |

### 키보드 단축키

- `?` 도움말, `/` 검색 입력 포커스, `t` 테마, `r` 새로고침, `Esc` 모달 닫기
- `g` 후 한 글자: `d`(대시보드), `x`(XView), `w`(Waterfall), `l`(LLM 관측), `c`(MCP), `r`(호출 이력), `p`(프롬프트 검색), `u`(사용자), `m`(팀), `i`(IP), `q`(사용 한도), `a`(안전), `s`(설정)

---

## 2. 탭 한눈에 보기

| 탭 | 무엇을 할까 |
| --- | --- |
| 대시보드 | 총 요청·토큰·KRW·평균 지연·첫 청크 지연, 24h/7d/30d 시계열 차트, 상위 사용자, 상태 분포, 이상 징후, 시간대 히트맵, 최근 20건 |
| XView | 요청 1건=점 1개의 응답시간 분포(스캐터)로 이상치를 발견하고, 점을 클릭하면 그 요청이 **왜** 그렇게 처리됐는지(라우팅·폴백·캐시·안전·비용·세션) 설명하는 eXplainability View |
| Waterfall | 한 세션의 트랜잭션(요청)들을 시간순 간트 막대로 펼쳐, 첫 응답 대기(TTFB)·스트리밍 수신 구간과 요청 사이의 대기(생각) 시간을 보고 LLM 처리시간(busy) vs 대기시간(idle)을 분해 |
| LLM 관측 | Datadog LLM Observability 대응 Trace/Span/Session/Prompt/Patterns/Insights/Feedback/Evaluation 화면 |
| MCP | MCP/tool 서버·도구 리더보드, 호출/오류 집계, 오류 호출 drill-down |
| 호출 이력 | IP/모델/언어 필터로 검색, 두 행 선택 후 비교, 행 클릭 시 상세 모달 |
| 프롬프트 검색 | 키워드/언어/IP/키/기간으로 마스킹 프롬프트 검색, CSV 다운로드, 저장된 필터 |
| 사용자 | Proxy API 키별 사용량·비용, 키 클릭 시 일별·모델별·IP별 상세와 LLM trend/eval failure/feedback drill-down |
| 팀 | 팀별 사용량·비용, 팀 클릭 시 API 키/모델/IP/LLM trend drill-down |
| IP | 호출 IP 별 사용량, IP 클릭 시 일별·모델별·키별 상세 |
| 사용 한도 | API 키/팀/IP/전체 단위 일별·월별 토큰·KRW 한도 |
| 안전 | Kill Switch + 알림 규칙 + 발화 이력 |
| 설정 | Proxy API 키 발급/비활성화, 업스트림 provider, 보존 정책, 변경 이력 + 감사 CSV |

---

## 3. 대시보드

화면 위에서 아래로:

1. **요약 KPI**: 총 요청수 / 총 토큰 / 누적 KRW / 전체 지연 P50/P95/P99 / 첫 청크 지연 P50/P95/P99
2. **시계열 차트**: 24h(시간별) / 7d(일별) / 30d(일별) 토글. 실선은 요청 수, 점선은 KRW 비용. 점에 마우스를 올리면 토큰·비용까지 툴팁.
3. **상위 사용자**: 요청 수 기준 Top 5. 클릭 시 그 사용자의 상세 페이지로 이동.
4. **상태 분포**: 2xx/3xx/4xx/429/5xx 비율 막대 + 표.
5. **이상 징후**: 모델별 요청당 비용·지연을 최근 6시간 vs 7일 기준선으로 비교해 z-score ≥ 3 인 급변(급증/급감)을 표로 표시. 모델 가격 변동·성능 저하·폭주를 선제적으로 포착. `/admin/anomalies` API, `anomaly_zmax` 알림 지표.
6. **IP별 / 모델별 / 언어별** 표 (헤더 클릭 시 정렬).
6. **시간대 히트맵**: Asia/Seoul 기준 요일(가로)×시간(세로). 색이 짙을수록 그 시간대 호출이 많음. 트래픽 패턴 + 비정상 시간대(새벽 폭주 등) 발견용.
7. **최근 호출 이력 20건**.

---

## 3-1. XView (트랜잭션 응답시간 분포)

평균 응답시간 차트는 9초짜리 장애가 100ms 요청들 사이에 묻혀도 "평균 130ms 정상"처럼 보입니다. XView는 **요청 1건을 점 1개**로 찍어(가로=시간, 세로=응답시간) 이상치를 즉시 드러냅니다.

- **세로축 스케일**: 로그(기본) / 선형 토글. 로그 스케일이면 100ms 군집과 9초 이상치를 한 화면에서 봅니다.
- **지표 토글**: 전체 응답시간 / 첫 청크 지연(스트리밍 TTFB).
- **보조선**: P50(회색)·P95(노랑)·P99(빨강) 백분위 기준선.
- **색상 분류**:
  - 🟢 캐시 히트 (`provider=cache`)
  - 🔵 정상
  - 🟡 폴백 (upstream 장애로 대체 provider 사용)
  - 🔴 오류 (status ≥ 400, kill switch·정책 차단 포함)
  - 🟣 고비용/복잡 (토큰이 상위 10% 또는 4000 이상)
- **창**: 5m / 15m / 1h / 6h / 24h. **필터**: 모델, endpoint.
- **드릴다운**: 점에 마우스를 올리면 모델·provider·지연·토큰·비용·상태 툴팁, 클릭하면 요청 상세 모달.
- 점이 6000건을 넘으면 최근 6000건으로 제한(범례 옆에 표시).

API: `GET /admin/scatter?window=1h&metric=latency&model=&endpoint=&limit=6000` — 점 배열(`request_id, created_at, latency_ms, first_chunk_ms, status_code, provider, model, total_tokens, cost_krw, stream, tool_count, failover`)과 `truncated` 플래그를 반환합니다.

### eXplainability View (점 클릭 → "왜 이렇게 처리됐나")

스캐터의 점(또는 호출 이력/상세 모달의 "🧭 XView 설명" 버튼)을 클릭하면 그 요청 1건의 처리 근거를 6개 패널로 설명합니다. 감사·보안·비용 통제 근거가 요청별로 남으므로 금융권 등 규제 환경에 적합합니다.

| 패널 | 내용 |
| --- | --- |
| 🧭 라우팅 | 선택된 provider·모델, 라우팅 근거(헤더 지정/쿼리/모델 패턴 자동/기본), 매칭된 패턴, **복잡도 점수(0~100)와 티어**(low/medium/high) |
| 🔁 폴백 | 폴백 발생 여부, 최초→대체 provider, 사유(전송 실패 등) |
| 🟢 캐시 | 캐시 히트 여부, cached 토큰, **절감액**(전체 캐시 / 프롬프트 캐시) |
| 🛡 안전 | 차단 여부, 마스킹 적용, 실패한 안전·보안 평가(PII/인젝션/독성/도구 인자 시크릿) |
| 💰 비용 | 실제 비용 vs 정가(캐시 미적용 시), **절감액**, 토큰 분해(prompt/completion/cached/reasoning) |
| 🧵 세션 | 세션 타임라인 링크, 스트리밍 여부, 원문 상세 링크 |

복잡도 점수는 프롬프트 토큰·대화 깊이·도구 수 기반 휴리스틱 추정치이며(모델 산출값 아님) UI에 그 사실이 명시됩니다.

API: `GET /admin/requests/{id}/explain` → `{routing, fallback, cache, safety, cost, session}`.

---

## 3-2. Waterfall (트랜잭션 타임라인)

XView가 "요청 분포"를, 세션 비용 타임라인이 "누적 비용 곡선"을 본다면, **Waterfall은 한 세션 안에서 시간이 어디로 흘렀는지**를 봅니다. 분산 트레이싱 도구(Jaeger·크롬 네트워크 워터폴)와 같은 간트 막대 표현입니다.

### 보는 법

1. `Waterfall` 탭 → 세션 목록에서 "보기" (또는 XView 설명 패널/세션 타임라인 모달의 "워터폴" 링크).
2. 각 요청이 가로 막대 한 줄. 가로축은 세션 시작 기준 경과 시간(벽시계).
   - **연한 부분** = 첫 응답까지의 대기(TTFB) — 모델이 첫 토큰을 내놓기까지.
   - **진한 부분** = 스트리밍 수신 구간.
   - **막대 사이 빈 공간** = 클라이언트(에이전트/사람)의 대기·생각 시간 — 서버는 놀고 있던 시간.
3. 막대 색은 XView와 동일: 파랑=정상, 초록=캐시 히트, 노랑=폴백, 보라=고복잡도(점수 ≥ 70), 빨강=오류. **빨간 테두리/⚠** = 느린 요청.
4. 막대/표 행 클릭 → 해당 요청의 XView 설명(라우팅 근거)으로 이동.

### 병목 분석 (자동)

차트 위 **병목 분석** 카드가 눈으로 찾을 필요 없이 핵심을 짚어줍니다.

- **가장 느린 요청**: 최대 `total_ms` 요청 + 전체 대비 %. 클릭하면 그 요청의 라우팅 근거로 이동.
- **가장 긴 대기(생각)**: 최대 `gap_before_ms` + 전체 대비 %. 에이전트가 어디서 오래 멈췄는지.
- **판정 문구**: idle > busy면 "클라이언트 대기 병목", 아니면 TTFB·스트리밍 중 큰 쪽을 지목.

### 세션 시간 구성 (스택 바)

요약 아래 가로 스택 바가 세션 전체 시간을 세 조각으로 분해합니다: **첫 응답 대기(Σ TTFB)** / **스트리밍 수신(Σ 본문)** / **클라이언트 대기(idle)**. "느리다"가 모델 큐(TTFB)인지, 긴 출력(스트리밍)인지, 에이전트 사고(idle)인지 한눈에 구분됩니다.

### 상단 요약 지표

| 지표 | 의미 |
| --- | --- |
| 총 소요(wall) | 세션 첫 요청 시작 ~ 마지막 요청 종료까지 벽시계 시간 |
| LLM 처리(busy) | 실제 업스트림이 일한 시간(요청 구간들의 **합집합**, 동시 요청 중복 제거) + 처리율(busy/wall) |
| 대기/생각(idle) | wall − busy. 이 값이 크면 병목은 모델이 아니라 클라이언트 쪽 사고/도구 루프입니다. |
| 느린 요청 | `slow_ms` 기준 초과 요청 수. 기준 미지정 시 `max(3000ms, p95)` 자동. 툴바의 "느림 기준(ms)" 입력으로 조정. |
| 누적 비용·토큰·도구 | 세션 전체 합계 |

busy/idle 분해는 "느리다"의 원인이 **LLM인지 클라이언트 대기인지**를 가르는 핵심 단서입니다. 처리율이 낮은데 체감이 느리면 모델 증설이 아니라 에이전트 동작을 봐야 합니다.

### 필터 · 내보내기

- **분류 필터**: 범례 칩을 클릭하면 해당 분류(오류/캐시/폴백/고복잡도/정상)를 차트·표에서 숨기거나 다시 표시. 예: "오류만" 보기.
- **CSV 내보내기**: 현재 세션 스팬 전체를 CSV로 저장(엑셀 한글 대응 BOM 포함). 오프라인 분석·증빙용.

### API

`GET /admin/waterfall?session_id=<id>&limit=<n>&slow_ms=<ms>` → `{session_id, requests, wall_ms, busy_ms, idle_ms, busy_ratio, wait_ms, stream_ms, slow_ms, slow_count, bottleneck, total_cost_krw, total_tokens, tool_calls, categories, spans[]}`. 각 span은 `start_offset_ms`(세션 시작 기준), `ttfb_ms`, `total_ms`, `gap_before_ms`(직전 대기), `category`, `slow`를 서버에서 미리 계산해 내려줍니다. `bottleneck`은 `{slowest_seq, slowest_ms, slowest_pct, longest_gap_seq, longest_gap_ms, longest_gap_pct}`. `slow_ms` 미지정 시 `max(3000, p95)` 자동. 세션 헤더가 없던 요청들은 `session_id=no-session`으로 묶입니다.

---

## 4. LLM 관측

Datadog LLM Observability의 핵심 기능을 게이트웨이 내부 데이터로 재구성한 탭입니다.

| 영역 | 내용 |
| --- | --- |
| Trace Explorer | 요청 단위 trace 목록. session, prompt, 모델/provider, 첫 청크/전체 지연, 토큰·비용, tool count, 상태를 한눈에 확인. 상세 모달에는 파생 LLM/tool span 표시 |
| Session Explorer | `session_id` 별 요청 수, 토큰, KRW, 오류, 평가 실패, 최초/최근 시각. 행의 `타임라인 > 보기` 로 세션 비용 타임라인 모달 표시 |
| Session Timeline | 한 세션의 턴을 시간순으로 펼쳐 누적 비용 곡선(SVG)과 턴별 모델·상태·첫청크·토큰·비용·누적비용·도구 호출 표를 보여줌. 점 색: 초록=정상, 노랑=평가실패, 빨강=오류. 어떤 턴에서 비용이 급증했는지 한눈에 파악. API: `GET /admin/llm/session?session_id=` |
| Prompt Tracking | prompt name/version 별 호출 수, 평균 지연, 토큰·비용, 오류, 평가 실패 |
| Prompt Compare | Prompt Tracking 행에서 `비교`를 눌러 버전 간 호출량, 토큰, KRW, 지연, 오류율, 평가 실패율 차이 확인. 상단 `API 키 ID` / `팀` 필터가 켜져 있으면 같은 스코프 안에서만 비교. baseline 미지정 시 가까운 이전 버전, 없으면 최근성 기준 대체 baseline 자동 선택하며, 선택 근거와 추천 후보 목록을 모달 상단에 표시. 추천 후보는 3/5/10개로 조절 가능하고, 버튼으로 바로 눌러 baseline을 교체 가능하며, 각 후보에 호출량/평균 지연/오류율/평가 실패율/최근 시각과 정렬 기준이 함께 보임 |
| Patterns | 최근 프롬프트를 debugging/testing/refactoring/security/prompt-injection-risk 등 운영 토픽으로 자동 묶음 |
| Insights | 평가 실패, 프롬프트 인젝션 위험, usage 누락, 느린 첫 청크, 오류 세션을 최근 윈도우 기준으로 자동 추출. 각 행의 `열기`로 관련 trace/prompt/evaluation 위치로 즉시 drill-down 하고, prompt 계열 인사이트는 `비교`, session 계열 인사이트는 `세션 묶음`으로 최근 trace bundle 모달을 바로 열 수 있음. 세션 묶음 모달에서는 JSON/CSV 다운로드 가능 |
| Trend | 최근 24시간/7일/30일 기준으로 요청량, 비용, 평가 실패, 부정 피드백, human/eval alignment 흐름을 시계열로 표시 |
| Feedback | 운영자가 trace 상세에서 `좋음/문제 있음/중립` 피드백과 라벨, 코멘트를 남기고 최근/라벨별/prompt별 피드백과 alignment를 집계 |
| Evaluation | gateway-managed 평가(prompt PII, prompt injection, toxicity, completion, usage, first chunk latency)와 외부 평가 결과 |

LLM 관측 탭 상단 필터에서 `API 키 ID`, `팀` 값을 넣으면 trace/session/prompt/patterns/insights/evaluation/feedback/timeseries 패널을 해당 범위로 좁혀 볼 수 있습니다. drill-down 링크로 들어오면 `model`, `session_id`, `prompt_name`, `prompt_version`, `evaluation_name`까지 함께 걸립니다. 사용자 상세와 팀 상세에는 같은 스코프를 채운 `필터된 LLM 보기` deep link가 있습니다.

정확한 세션·프롬프트 집계를 원하면 클라이언트가 다음 헤더를 보내도록 설정합니다.

```bash
X-LLM-Session-ID: sess-123
X-LLM-Prompt-Name: code-review
X-LLM-Prompt-Version: v7
X-LLM-Prompt-Variables-Hash: vars-sha256
```

요청 body의 `metadata.prompt`, `metadata.prompt_tracking`, `metadata._dd.ml_obs.prompt_tracking` 에 구조화 프롬프트 메타데이터가 들어와도 자동 수집합니다. 외부 평가기는 `POST /admin/llm/evaluations` 로 결과를 제출할 수 있고, 운영자는 trace 상세에서 사람 피드백을 남길 수 있습니다.

```bash
curl -X POST http://<host>:8080/admin/llm/evaluations \
  -H "Content-Type: application/json" \
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

```bash
curl -X POST http://<host>:8080/admin/llm/feedback \
  -H "Content-Type: application/json" \
  -d '{ "request_id": "req_xxxxxxxx", "rating": -1, "label": "hallucination", "comment": "근거 없는 답변" }'
```

---

## 4-1. MCP / Tool 관측

AI 코딩 도구(Roo Code·Cline·Cursor·Claude Desktop)가 MCP 서버나 함수 호출(tool/function calling)을 사용할 때, 게이트웨이는 어떤 서버·어떤 도구가 정의·호출·실패했는지 자동 집계합니다. 별도 설정 없이 OpenAI 호환 트래픽에서 추출됩니다.

### 수집 대상

| 종류 | 출처 |
| --- | --- |
| 정의(definition) | 요청 `tools[]` / `functions[]` 카탈로그. Responses API `{type:"mcp", server_label}` 포함 |
| 호출(call) | 응답 `tool_calls[]` (스트리밍·논스트리밍 모두), 요청 내 assistant `tool_calls` |
| 결과(result) | 요청의 `role:"tool"` 메시지. `{"isError":true}` 등은 오류로 분류 |

### MCP 서버 분류 규칙

도구 이름에서 서버 라벨을 자동 추출합니다.

- `mcp__github__create_issue` → 서버 `github`, 도구 `create_issue` (MCP)
- `mcp__korean-law__search_law` → 서버 `korean-law` (MCP)
- Responses API `{type:"mcp", server_label:"filesystem"}` → 서버 `filesystem` (MCP)
- `github.create_issue`, `fs/read_file` → 서버 추출하되 MCP 플래그는 false (일반 함수)
- `web_search` 같은 built-in tool type → 서버 `builtin`

### MCP 탭 구성

1. **요약 KPI**: tool 호출 수 / tool 오류 수(+오류율) / 고유 tool 수 / MCP 서버 수
2. **필터**: API 키 ID, 서버 라벨, "MCP만" 체크. 필터는 URL hash 에 보관되어 공유 가능
3. **MCP 서버별 표**: 서버마다 도구 종류·호출·오류·오류율·고유 키·마지막 사용. 행 클릭 시 그 서버로 필터링
4. **Tool 리더보드**: (서버, 도구) 별 정의·호출·결과·오류·오류율·고유 키. `호출`/`오류` 버튼으로 해당 도구를 사용한 요청을 모달로 drill-down
5. **에이전트 루프 의심**: 최근 24시간 동안 한 세션에서 같은 도구를 10회 이상 호출한 경우 표시. 폭주/무한루프 에이전트를 비용 사고 전에 발견. 30회 이상은 빨간색.
6. **도구 카탈로그 / 드리프트**: 서버별로 관측된 도구 목록과 최초/최근 관측 시각. 최근 24시간 내 처음 나타난 도구는 `신규` 배지로 강조(공급망 변조·권한 확대 탐지), 30일간 안 보이면 `미사용` 배지. 섹션 제목에 신규 도구 수 표시.
7. **MCP 서버 정책**: 아래 보안 절 참고

### MCP 서버 정책 (allowlist / 차단)

미승인 MCP 서버 사용을 차단해 섀도우 MCP·신뢰 경계 밖 서버 연결을 막습니다. MCP 탭의 "MCP 서버 정책" 섹션 또는 API로 관리합니다.

- **모드**: `block`(차단), `warn`(허용하되 경고 헤더·기록), `allow`(명시적 허용)
- **Allowlist 모드** 토글: 켜면 `allow` 로 등록된 서버만 통과하고 나머지 MCP 서버는 모두 차단(화이트리스트). 끄면 `block` 으로 지정한 서버만 차단(블랙리스트).
- 차단된 요청은 upstream 에 도달하기 전 `HTTP 403 + X-MCP-Blocked-Server: <서버>` 로 거부되고 호출 이력에 `blocked` provider 로 기록됩니다. `warn` 서버는 `X-MCP-Warn-Servers` 헤더를 붙여 통과시킵니다.
- 정책 변경은 5초 캐시로 모든 인스턴스에 전파됩니다.

```bash
# github MCP 서버 차단
curl -X POST http://<host>:8080/admin/mcp/policies \
  -H "Content-Type: application/json" \
  -d '{ "server_label": "github", "mode": "block", "note": "외부 PR 자동화 금지" }'

# allowlist 모드 켜기 (등록된 allow 서버만 통과)
curl -X POST http://<host>:8080/admin/mcp/policies \
  -H "Content-Type: application/json" -d '{ "allowlist_enabled": true }'

# 정책 삭제
curl -X DELETE http://<host>:8080/admin/mcp/policies/github
```

### MCP 관련 알림 / 평가

- 알림 지표(안전 탭): `tool_errors`(윈도우 내 tool 오류 수), `tool_error_rate`(오류/호출 비율), `tool_loop`(한 세션에서 한 도구의 최대 호출수 — 루프 임계), `mcp_new_tools`(윈도우 내 새로 관측된 도구 수 — 드리프트).
- 요청 상세의 LLM 평가에 `tools.no_error`(tool 결과 오류 여부), `tools.mcp_servers`(사용된 MCP 서버 수), `tools.args_no_secret`(도구 호출 인자·결과에 시크릿/PII 포함 여부)가 추가됩니다.
- 도구 호출 인자와 결과는 기존 마스킹 규칙(시크릿/PII)으로 스캔되어, 민감정보가 도구 입출력으로 새는지 `tools.args_no_secret` 평가로 감지합니다.
- 요청 상세의 trace span 에 도구마다 개별 span(`mcp`/`tool` kind)이 표시됩니다.
- Prometheus: `proxy_mcp_tool_calls_total`, `proxy_mcp_tool_errors_total`, `proxy_mcp_blocked_total`.

### API

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8080/admin/mcp/servers
curl -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:8080/admin/mcp/tools?mcp_only=1"
curl -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:8080/admin/mcp/requests?server=github&tool=create_issue&errors=1"
curl -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:8080/admin/mcp/loops?window=24h&threshold=10"
curl -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:8080/admin/mcp/catalog?server=github"
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8080/admin/mcp/policies
```

> 보안 참고: MCP 도구 결과(`role:tool`)도 프롬프트로 캡처되어 기존 `prompt.injection` 평가가 도구 응답을 통한 프롬프트 인젝션까지 스캔합니다. MCP 서버가 신뢰 경계 밖이라면 이 평가 실패를 모니터링하고, 위험 서버는 위 정책으로 차단하세요.

---

## 5. 호출 이력 / 프롬프트 검색

### 호출 이력 탭

- IP / 모델 / 언어 입력은 datalist 자동완성이 켜져 있어 운영 중인 값 중 골라 선택 가능.
- 행 좌측 체크박스로 두 행을 선택하면 상단 `[두 요청 비교]` 가 활성화 → 모달에 좌우로 펼쳐 프롬프트·토큰·비용·상태를 한눈에 비교.
- 행 본문 클릭 시 단건 상세 모달. 호출 이력 표와 상세 모달에는 첫 청크 지연과 전체 지연이 함께 표시됩니다.

### 단건 상세 모달

| 영역 | 내용 |
| --- | --- |
| 메타 | request_id, trace_id, 생성 시각(상대 + 절대), 상태, 첫 청크/전체 지연, 모델, provider, stream, IP, X-Forwarded-For, User-Agent, API 키 |
| 언어 추론 | 코드블록·파일명·키워드 기반 추정. 신뢰도 % 함께 |
| 토큰 분해 | prompt / completion / cached / reasoning / total |
| 비용 | KRW. 가격표가 설정된 모델에만 |
| 프롬프트 | 마스킹 처리된 본문. 원문이 저장된 경우(`LOG_RAW_PROMPTS=true`) 안내 메시지 |
| 응답 메타 | finish_reason, 응답 hash, (옵션) 캡처된 응답 일부 |
| **태그 · 메모 · 재실행** | 태그 콤마 구분 + 메모 + 동일 요청 재실행 버튼 |

### 프롬프트 검색 탭

- 키워드는 마스킹 텍스트 / 원문 모두 검색.
- 키워드를 `#태그명` 으로 시작하면 태그 검색 모드.
- 결과 행은 호출 이력과 동일 포맷. CSV 다운로드(BOM, Excel 한국어 호환), 저장된 필터 드롭다운.
- "현재 필터 저장" — 이름을 입력하면 현재 검색 조건을 `saved_filters` 에 보관, 이후 드롭다운에서 즉시 다시 불러올 수 있습니다.

---

## 6. 사용자 / IP

### 사용자(Proxy API 키) 목록

- 키 이름·소유자·팀·상태·총 요청·총 토큰·누적 KRW·평균 지연·마지막 호출 (상대 시간).
- 헤더 클릭 정렬, 키 행 클릭 시 상세.

### 사용자 상세

- 키 메타 (id/소유자/팀/상태)
- 고급 지표: 최근 24h 요청·토큰·KRW, 오류율, 전체/첫 청크 P95 지연, 평균 첫 청크, 토큰 분해(prompt/completion/cached/reasoning), 고유 모델/IP 수
- 일별 사용량 표 (최근 60일)
- 모델별 / IP별 / 언어별 표
- 상태 분포와 Asia/Seoul 기준 최근 30일 시간대 히트맵
- 최근 호출 100건 (필터/상세 모달 사용 가능)

### IP 목록 / 상세

같은 구조이며, IP 별 상세에는 "API 키별" 표가 함께 표시됩니다 — 한 공용 IP 에서 어떤 키들이 호출했는지 확인할 때 사용.

---

## 7. 사용 한도 (쿼터)

폭주를 방지하고 부서별 예산을 강제하는 핵심 도구.

### 추가 폼 (왼쪽부터)

| 필드 | 값 |
| --- | --- |
| 대상 | API 키 / 팀 / IP / 전체 |
| 대상 값 | "전체" 는 자동, 그 외에는 키 ID / 팀 이름 / IP |
| 주기 | 일별(매일 KST 00:00 리셋) / 월별(매월 1일 KST 00:00 리셋) |
| 토큰 한도 | 0 이면 미적용 |
| KRW 한도 | 0 이면 미적용 |
| 메모 | 운영자가 참고할 자유 텍스트 |

토큰·KRW 둘 다 채우면 둘 중 먼저 도달한 쪽에서 차단됩니다. 둘 다 0 이면 저장이 거절됩니다.

### 사용 한도 표

각 행마다 토큰 진행률 / KRW 진행률 막대가 함께 표시되고 80% 이상은 노란색, 100% 이상은 빨간색입니다. 같은 행에서 "중지"(잠깐 끄기), "삭제"(완전 제거) 가능합니다.

### 평가 흐름

요청이 들어올 때 게이트웨이는 다음 순서로 매칭되는 쿼터를 검사합니다.

1. global / `*`
2. api_key / 현재 키 ID
3. ip / 현재 클라이언트 IP
4. team / 키 소유 팀 (있을 때)

하나라도 초과되면 HTTP 429 + `Retry-After` + `X-Quota-*` 헤더 + 본문에 어떤 한도가 초과되었는지 표기됩니다.

### 월 예산 소진 예측 (Budget Burn-down)

사용 한도 탭 하단의 별도 섹션입니다. 쿼터가 "도달하면 차단"하는 **경성(hard) 한도**라면, 예산은 "이 추세면 월말에 얼마 쓸지"를 **예측·경고**하는 연성(soft) 관측 도구입니다. 차단은 하지 않습니다.

추가 폼:

| 필드 | 값 |
| --- | --- |
| 대상 | 전체 / 팀 / API 키 |
| 대상 값 | "전체"는 자동, 그 외에는 팀 이름 / 키 ID |
| 월 예산(KRW) | 이번 달 목표 상한 (양수) |
| 메모 | 자유 텍스트 |

표의 각 열:

- **이번 달 누적 / 월 예산** — 월초(KST 1일 00:00)부터 현재까지 실제 지출과 진행률 막대. 경과 일수(예: `경과 15/30일`)도 함께 표시.
- **월말 예상 지출** — 현재 일평균 소진율(누적 ÷ 경과일)을 월말까지 연장한 예측값과 예산 대비 %. 120% 이상이면 빨간색, 100% 초과면 노란색.
- **소진 예측** — `정상 추세`(예측이 예산 이하) 또는 `예산 초과 추세` 배지. 추세대로면 예산을 다 쓰는 **소진 예상일**(KST 날짜)을 함께 표시(이번 달 안에 소진될 때만).

기준 시간대는 KST(매월 1일~말일)이며 쿼터의 월별 리셋과 동일합니다.

### 예산 임박 알림 연동

안전 탭의 알림 규칙에서 지표 **"예산 소진 예측 비율(최대)"**(`budget_burn_ratio`)을 선택하면, 등록된 모든 예산 중 가장 높은 *월말 예상 / 월 예산* 비율이 임계치를 넘을 때 Webhook으로 통지됩니다. 예: 임계치 `1.0` → 어떤 예산이든 현재 추세로 월말에 예산을 초과할 것으로 예측되면 발화. `1.2`로 두면 20% 초과 추세부터 알립니다.

---

## 8. 안전 (Kill Switch + 알림)

### Kill Switch

⚠️ "모든 /v1 호출 즉시 차단" 버튼. 누른 즉시 모든 /v1/* 호출이 HTTP 503 + `Retry-After: 60` + `X-Kill-Switch: global` + `X-Kill-Reason: <사유>` 헤더로 응답합니다. 5초 캐시를 사용하므로 멀티 인스턴스 운영에서도 약 5초 안에 모든 인스턴스에 전파됩니다.

복귀는 같은 화면의 "정상 운영 재개" 버튼.

언제 사용하나요?

- 한 도구가 비용을 폭주시키는 게 확실하지만 어느 키인지 모를 때
- 릴리즈 롤백 / 보안 사고 / vendor 측 대량 장애
- 짧은 시간 안에 다시 켤 예정일 때 (몇 시간 차단은 쿼터/키 비활성화로 대체)

### 알림 규칙

| 지표 | 의미 | 예시 임계값 |
| --- | --- | --- |
| `requests` | 윈도우 안 요청 수 | 5분에 500건 |
| `errors` | 윈도우 안 4xx/5xx 비율 (0~1) | 0.10 (10%) |
| `krw` | 윈도우 안 KRW 비용 합 | 100000 (10만원) |
| `tokens` | 윈도우 안 토큰 합 | 1000000 |
| `latency_p95_ms` | 윈도우 안 전체 응답 지연 P95(ms) | 3000 |
| `first_chunk_p95_ms` | 윈도우 안 upstream 첫 응답 청크 지연 P95(ms) | 1500 |
| `llm_eval_failures` | 윈도우 안 실패한 LLM evaluation 수 | 10 |
| `llm_eval_failure_rate` | 윈도우 안 LLM evaluation 실패율 (0~1) | 0.2 |

- **윈도우(초)**: 평가 기간. 알림 평가는 1분 주기로 돌고, 발화 후에는 같은 윈도우 동안 디바운스 됩니다.
- **대상**: 전체 / API 키 / 팀 / IP / 모델 중 선택.
- **webhook URL**: Slack 호환(`text` 필드 + 컨텍스트 JSON). 비워두면 발화 이력에만 기록.

### 발화 이력

같은 탭 하단에서 최근 50개. 시각 / 규칙 / 지표 / 값 / 임계값 / 전송 성공 여부를 표시합니다.

---

## 9. 설정

### 9.1 프록시 API 키 발급

폼: 이름 / 소유자(이메일·이름) / 팀 / 시크릿(선택). 시크릿을 비우면 게이트웨이가 `pcg_...` 형식으로 자동 생성합니다.

발급 직후 한 번만 표시되는 시크릿을 사용자에게 안전한 채널(사내 메신저 1:1, 1Password 등)로 전달하세요. 다시 볼 수 없습니다.

이름 클릭 시 사용자 상세로, "비활성화" 버튼으로 즉시 차단할 수 있습니다.

### 9.2 업스트림 프로바이더

vendor API 본인의 키를 게이트웨이에 저장하는 화면입니다. 평문이 아닌 AES-GCM 으로 암호화되어 보관됩니다(키는 `GATEWAY_SECRET`).

`모델 패턴` 컬럼에 콤마 구분 글롭(`claude-*`, `anthropic/*` 등)을 넣으면, 클라이언트가 `X-Proxy-Provider` 를 지정하지 않아도 모델명만으로 라우팅됩니다.

### 9.2.1 복잡도 기반 비용 최적 라우팅 규칙

요청 복잡도(0~100)에 따라 모델을 자동 교체합니다. 예: 저복잡도(0~34)는 저가 모델로 다운그레이드, 고복잡도(70~100)는 프리미엄으로.

| 필드 | 의미 |
| --- | --- |
| 우선순위 | 낮을수록 먼저, 첫 매칭 적용 |
| 모델 패턴 | 들어온 모델에 매칭할 glob (`*`=전체) |
| 복잡도 범위 | min~max (0~100) |
| 대상 모델 | 교체할 모델 (body의 `model` 재작성) |
| 대상 provider | 선택. 비우면 자동 결정 |

- 클라이언트가 provider를 지정했거나 `X-Proxy-No-Route: 1` 헤더면 규칙 미적용.
- 교체 시 `X-Routed-Model` 헤더 + XView 설명에 "원본 → 대상" 표기. 메트릭 `proxy_routing_overrides_total`.

```bash
curl -X POST http://<host>:8080/admin/routing-rules \
  -H "Content-Type: application/json" \
  -d '{ "match_pattern":"gpt-*", "min_complexity":0, "max_complexity":34, "target_model":"gpt-4.1-mini", "priority":10 }'
```

### 9.3 데이터 보존 정책

현재 적용 중인 보존 일수와 누적 삭제 행 수를 표시합니다. "지금 정리 실행" 으로 워커를 즉시 1회 트리거할 수 있습니다(디스크가 가득 찼을 때 임시 조치).

### 9.4 Fallback 로그 재처리

DB 장애 중 fallback NDJSON 로 빠진 감사 로그를 DB 에 다시 적재합니다. 성공한 라인은 파일에서 제거되고, 깨진 JSON 이나 아직 삽입할 수 없는 라인은 남습니다. 재처리 실행은 `fallback.replay` 감사 로그로 기록됩니다.

### 9.5 관리자 변경 이력

API 키 발급/상태 변경, provider 변경, quota CRUD, kill switch, 알림 규칙, 요청 태그, 저장된 필터 등 모든 admin 동작이 append-only 로 기록됩니다.

"감사 로그 CSV 다운로드" 로 관리자 변경 + 알림 발화 이력을 한 파일에 한국어 CSV(UTF-8 BOM) 로 받을 수 있습니다 — 분기 감사 보고 / 회계 첨부용.

---

## 10. 일상 운영 체크리스트

### 매일

- [ ] 대시보드의 KPI / 상태 분포 카드에서 4xx·5xx 비율이 평소와 다른지 확인
- [ ] 시계열 차트 비용 곡선이 평소 곡선과 다른지 확인
- [ ] 안전 탭에서 발화한 알림이 있는지 확인
- [ ] (자동화 안 되어 있다면) `scripts/backup.sh` 실행

### 매주

- [ ] 사용자 탭 정렬 → 누적 비용 상위 5명 확인 → 평소와 다른 폭주가 있는지
- [ ] IP 탭에서 "고유 키 수" 가 비정상적으로 많은 IP (한 IP 에서 키 여러 개로 호출) 가 있는지
- [ ] 사용 한도가 80% 진행률을 넘은 항목이 있다면 다음 달 한도 조정 검토

### 매월

- [ ] 감사 로그 CSV 받아 보관
- [ ] 비활성화된 키 / 미사용 provider 정리
- [ ] `RETENTION_*` 값이 현재 데이터 크기와 운영 정책에 맞는지 재검토
- [ ] backup 디렉토리 용량 확인 (자동 보존 정책이 잘 작동 중인지)

---

## 11. 권한 분리

`ADMIN_READONLY_TOKEN` 을 운영자가 별도 발급하면, 회계/감사/리더는 GET/HEAD 만 가능한 읽기전용 어드민 접근권을 받을 수 있습니다.

- 대시보드 / 통계 / 검색 / CSV 다운로드 → ✅ 가능
- 키 발급 / provider 변경 / quota CRUD / kill switch / 알림 / 저장된 필터 변경 / 태그 수정 → ❌ 401

읽기전용 토큰을 분실하거나 인사 이동이 있는 경우 운영자가 `ADMIN_READONLY_TOKEN` 환경변수를 새 값으로 바꾸고 재기동하세요.

---

## 12. 자주 묻는 관리자 질문

**Q. 키 이름을 바꿀 수 있나요?**
A. 현재 PATCH 는 status 만 받습니다. 이름을 바꾸려면 같은 키 ID 로 POST 를 다시 보내거나(같은 시크릿이면 동일 ID), 비활성화 + 새 키 발급을 권장합니다.

**Q. 프롬프트 원문도 보고 싶어요.**
A. 운영 정책상 기본 OFF 입니다. 게이트웨이를 재기동할 때 `LOG_RAW_PROMPTS=true` 를 설정하면 이후 호출의 원문이 `prompt_logs.content_text` 컬럼에 저장됩니다(이전 호출은 hash 만). 동시에 `LOG_RAW_BODIES=true` 면 요청 재실행도 가능해집니다. 원문 저장은 PII / 보안 리스크가 있으니 디스크 암호화와 접근 제한을 먼저 확보하세요.

**Q. quota 가 너무 빨리 트리거되어 사용자가 불편해해요.**
A. 안전 탭의 알림 규칙으로 80% 도달 시 미리 통보하도록 해두면 한도를 미리 조정할 수 있습니다.

**Q. 새 vendor 를 추가하고 싶어요.**
A. 설정 → 프로바이더 → 폼에 이름/Base URL/key 입력 후 저장. 모델 패턴을 함께 등록하면 클라이언트 코드 변경 없이 라우팅됩니다.

**Q. 비용이 anonymous 로 잡혀요.**
A. 키 발급 전의 호출이거나, 발급된 키가 한 개도 없을 때입니다. 키를 최소 1개 발급하면 그 이후의 미인증 호출은 401 로 차단됩니다.

**Q. 운영 중 게이트웨이를 옮기려면?**
A. (1) 새 인스턴스를 같은 `GATEWAY_SECRET` 으로 띄움 (2) `data/gateway.db` 복사 (3) DNS 변경. 사용자 측 코드 변경 불필요.
