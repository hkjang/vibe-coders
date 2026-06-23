# 관리자 가이드 (Admin Guide)

`http://<host>:8080/admin` 에 접속하는 운영 관리자를 위한 사용 설명서입니다. 한국어 UI 와 다중 탭으로 구성되어 있고, 모든 동작은 동일한 이름의 REST API 로도 자동화할 수 있습니다.

> [!NOTE]
> AI Proxy Gateway의 안전성 통제(긴급 정지, 비용 가드, 정책 엔진, 민감 정보 방화벽 등)에 관한 더욱 상세한 레벨의 스펙은 [안전 및 보안 거버넌스 운영 가이드](./SAFETY_GUIDE.md)를 참고해 주십시오.

---

## 1. 첫 접속

접속 방법은 인증 모드에 따라 둘 중 하나입니다. `/admin` 에 들어가면 UI가 모드를 자동 감지해 알맞은 화면을 띄웁니다.

**A. 계정 로그인 모드 (`AUTH_ENABLED=true`, 권장)**

1. 브라우저로 `http://<host>:8080/admin` 접속 → **이메일/비밀번호 로그인 화면이 바로 표시**됩니다.
2. 최초 1회는 부트스트랩 계정(`AUTH_ADMIN_BOOTSTRAP_EMAIL` / `AUTH_ADMIN_BOOTSTRAP_PASSWORD`)으로 로그인하세요.
3. 로그인하면 헤더에 `이메일 · 역할` 칩과 "로그아웃" 버튼이 나타나고 대시보드로 이동합니다.
4. access token 만료 시 UI가 refresh token으로 **자동 갱신(rotation)** 하므로 끊김이 없고, refresh까지 만료되면 로그인 화면으로 돌아갑니다. 토큰은 sessionStorage에만 보관됩니다(탭 닫으면 소멸).

**B. 레거시 토큰 모드 (`AUTH_ENABLED=false`, 기본)**

1. 브라우저로 `http://<host>:8080/admin` 접속
2. 상단 우측 "관리자 토큰" 입력란에 `ADMIN_TOKEN` 값 붙여넣기
3. 데이터가 보이면 정상. 401 이 나오면 토큰이 잘못된 것입니다.

### 헤더의 운영 보조 도구

| 아이콘/버튼 | 기능 |
| --- | --- |
| 자동 새로고침 드롭다운 | 끔/5/10/30/60초 마다 현재 화면 다시 로드. 세션에 보관. |
| 🌓 / ☀️ | 라이트/다크 테마 전환 (`t` 단축키 동일). |
| `?` | 단축키 도움말 오버레이. |
| 사용자 칩 · 로그아웃 | (로그인 모드) 현재 로그인한 이메일·역할 표시, 로그아웃 시 세션/refresh token 폐기 후 로그인 화면으로. |
| 관리자 토큰 | (레거시 모드에만 표시) 입력값은 sessionStorage 에만 저장되고, 다른 탭/세션에는 공유되지 않습니다. |

### 키보드 단축키

- `?` 도움말, `/` 검색 입력 포커스, `t` 테마, `r` 새로고침, `Esc` 모달 닫기
- `g` 후 한 글자: `d`(대시보드), `x`(XView), `w`(Waterfall), `l`(LLM 관측), `c`(MCP), `e`(에이전트), `v`(VCS), `r`(호출 이력), `p`(프롬프트 검색), `u`(사용자), `m`(팀), `i`(IP), `q`(사용 한도), `a`(안전), `s`(설정)

---

## 2. 탭 한눈에 보기

| 탭 | 무엇을 할까 |
| --- | --- |
| 대시보드 | 총 요청·토큰·KRW·평균 지연·첫 청크 지연, 24h/7d/30d 시계열 차트, 상위 사용자, 상태 분포, 이상 징후, 시간대 히트맵, 최근 20건 |
| XView | 요청 1건=점 1개의 응답시간 분포(스캐터)로 이상치를 발견하고, 점을 클릭하면 그 요청이 **왜** 그렇게 처리됐는지(라우팅·폴백·캐시·안전·비용·세션) 설명하는 eXplainability View |
| Waterfall | 한 세션의 트랜잭션(요청)들을 시간순 간트 막대로 펼쳐, 첫 응답 대기(TTFB)·스트리밍 수신 구간과 요청 사이의 대기(생각) 시간을 보고 LLM 처리시간(busy) vs 대기시간(idle)을 분해 |
| LLM 관측 | Datadog LLM Observability 대응 Trace/Span/Session/Prompt/Patterns/Insights/Feedback/Evaluation 화면 |
| MCP | MCP/tool 서버·도구 리더보드, 호출/오류 집계, 오류 호출 drill-down |
| 라우팅 | Intelligent Routing 학습 루프, routing preview/decision 조회, Provider Health ranking/degradation/trend 운영 화면 |
| 에이전트 | 코딩 에이전트(Claude Code/Cursor/Roo/Qwen…)별 성공률·평균 비용·지연·도구 오류율 리더보드 (User-Agent 기반) |
| VCS | GitLab/Bitbucket 커밋·MR 을 세션·사용자에 연결한 목록(Prompt→Commit→MR 상관). 저장소/세션/키/유형 필터 |
| 호출 이력 | IP/모델/언어 필터로 검색, 두 행 선택 후 비교, 행 클릭 시 상세 모달 |
| 프롬프트 검색 | 키워드/언어/IP/키/기간으로 마스킹 프롬프트 검색, CSV 다운로드, 저장된 필터 |
| 사용자 | Proxy API 키별 사용량·비용 + **AI 활용지수**(요청·활동일·커밋·머지MR·성공률 기반), 키 클릭 시 상세 drill-down |
| 팀 | **팀 벤치마크**(월비용 × 생산성 점수) + 팀별 사용량, 팀 클릭 시 API 키/모델/IP/LLM trend drill-down |
| IP | 호출 IP 별 사용량, IP 클릭 시 일별·모델별·키별 상세 |
| 사용 한도 | API 키/팀/IP/전체 단위 일별·월별 토큰·KRW 한도 |
| 안전 | Kill Switch + **AI Incident(프로바이더 장애 감지)** + 비용 가드 + AI 정책 엔진 + Secret Firewall 이벤트 + 승인 큐 + 정책 판단 이벤트 + 알림 규칙 + 발화 이력 |
| 설정 | Proxy API 키 발급/비활성화, **로그인 계정·팀 관리(RBAC)**, 업스트림 provider, 보존 정책, 변경 이력 + 감사 CSV |

## 2-1. 인증 / RBAC

기본 운영은 기존 호환 모드(`AUTH_ENABLED=false`)입니다. `AUTH_ENABLED=true` 로 켜면 Admin API는 `/auth/login` 으로 받은 JWT access token이 필요하고, refresh token은 `/auth/refresh` 호출마다 rotation 됩니다. `/auth/logout` 은 세션/refresh token을 폐기합니다. **어드민 UI는 이 모드에서 `/admin` 진입 즉시 이메일/비밀번호 로그인 화면을 띄우고**, 토큰 만료 시 자동 갱신, 만료 실패 시 재로그인을 유도합니다(1장 참고).

역할은 `super_admin`, `admin`, `team_admin`, `developer`, `viewer`, `service_account` 를 지원합니다. API key는 원문을 저장하지 않고 hash만 저장하며, `expires_at`, `revoked_at`, `allowed_ips`, `scopes`, `allowed_models`/`denied_models`, `allowed_providers`/`denied_providers`, `budget_limit_krw` 정책을 검사합니다. Scope는 `chat:completion`, `embeddings:create`, `models:read`, `admin:read`, `admin:write`, `routing:read`, `routing:write`, `observability:read`, `costs:read`, `security:read`, `mcp:use`, `mcp:admin` 입니다.

인증/정책 이벤트는 `GET /admin/audit/auth-events` 에 기록됩니다. 기록 대상은 `login_success`, `login_failed`, `api_key_created`, `api_key_revoked`, `api_key_denied`, `ip_denied`, `scope_denied`, `model_denied`, `budget_denied`, `role_changed` 입니다.

### 계정 · 팀 관리 (설정 탭 → "로그인 계정 · 팀 (RBAC)")

| 동작 | 방법 | 비고 |
| --- | --- | --- |
| 계정 생성 | 폼: 이메일·초기 비밀번호·이름·역할·팀 | `POST /admin/users`. team_admin 은 자기 팀 계정만 생성 가능하며 자기 역할보다 높은 역할은 지정 불가 |
| 역할 변경 | 표의 역할 드롭다운 선택 | `PATCH /admin/users/{usr_id}` `{"role":"…"}`. `role_changed` 감사 기록. 자기 역할 이상으로 승격하거나 자기보다 높은 역할 계정 수정은 차단. team_admin 불가 |
| **팀 변경** | 표의 팀 드롭다운 선택 | `PATCH … {"team_id":"…"}` (빈 값 = 팀 해제). 존재하지 않는 팀은 400. 멤버십이 교체됩니다 |
| 비활성화/활성화 | 표의 버튼 | `PATCH … {"status":"disabled"}`. **비활성화 즉시 그 계정의 모든 세션·refresh token 폐기** → 발급된 access token도 바로 거부됩니다 |
| 팀 생성/조회 | 팀 폼 또는 팀 목록 | `POST /admin/teams` / `GET /admin/teams`. team_admin 은 팀 생성 불가, 자기 팀만 조회 가능 |
| 인증 이벤트 확인 | 같은 섹션 하단 표 | 실패 계열(login_failed/scope_denied/…)은 빨간 배지 |

### API 키 스코프 편집 · 영구 삭제

- **스코프 편집**: 설정 탭 프록시 API 키 표의 "스코프" 버튼 → 12개 스코프 체크박스 모달 → 저장(`PATCH /admin/api-keys/{id}` `{"scopes":[…]}`). 스코프 밖 호출은 403 + `scope_denied` 감사 기록. 로그인 모드에서 team_admin 은 자기 팀 키만 볼 수 있고, 자기 역할에 없는 스코프나 높은 역할은 API 키에 부여할 수 없습니다.
- **영구 삭제**: 같은 표의 "삭제" 버튼(`DELETE /admin/api-keys/{id}?hard=1`). 비활성화(soft)와 달리 키 행을 제거하며 되돌릴 수 없습니다. **`AUTH_ENABLED=true` 에서는 super_admin 전용**(그 외 역할 403), 레거시 모드에서는 전권 관리자 토큰으로 가능. 과거 사용 이력 통계는 보존됩니다(이후 external 표시). `api_key.delete` 관리자 감사 + `api_key_revoked(hard_delete)` 인증 이벤트 기록.

`AUTH_ENABLED=false` 상태에서도 섹션은 보이지만(사전 준비용), 로그인 모드가 꺼져 있다는 경고 배너가 표시됩니다.

## 2-2. Governance Layer

거버넌스 레이어는 요청을 upstream으로 보내기 전에 정책, secret, 승인, MCP tool 위험도를 평가합니다. 정책은 안전 탭의 "AI 정책 엔진" 또는 `GET/POST /admin/policies` 로 관리하며 rule은 `conditions`와 `actions` JSON을 사용합니다. 예: `{ "contains_secret": true, "block": true }`, `{ "risk_score": ">80", "require_approval": true }`, `{ "team": "security", "allow_models": ["gpt-5", "claude-sonnet"] }`. `team` 조건은 팀 ID와 팀명을 모두 매칭하며, 엄격히 구분하려면 `team_id` 또는 `team_name` 을 사용할 수 있습니다.

Secret Firewall은 API key, JWT, private key, password, AWS secret, DB connection string, access token을 탐지하고 정책에 따라 `detect`, `mask`, `block`으로 처리합니다. 탐지 이벤트는 안전 탭의 "Secret Firewall 이벤트" 또는 `GET /admin/security/secrets` 에서 확인합니다. `/admin/security/secrets` 는 `request_id`, `action`, `secret_type`, `team_id`, `api_key_id`, `user_id`, `location`, `matched_hash`, `window`, `since`, `limit` 필터를 지원합니다. 정책 판단 이벤트는 안전 탭의 "정책 판단 이벤트", `GET /admin/policies/decisions`, 요청별 XView/요청 상세의 Governance 패널에서 확인합니다. 매칭 규칙이 없는 정상 허용 경로도 감사 추적을 위해 `decision=default` 이벤트를 남깁니다. 다만 운영 화면의 실질 판단 수(`policy_decision_count`)는 `default`를 제외하고, 원시 감사 이벤트 수는 `policy_decision_total` 로 별도 노출합니다. `/admin/policies/decisions` 는 `request_id`, `decision`, `policy_id`, `rule_id`, `team_id`, `api_key_id`, `user_id`, `endpoint`, `phase`, `model`, `provider`, `window`, `since`, `limit` 필터를 지원합니다. 승인 필요 요청은 `pending` approval을 만들고 `X-Governance-Approval-ID` 헤더를 반환합니다. 운영자는 안전 탭의 "승인 큐" 또는 `GET /admin/approvals` 로 승인 항목을 조회하고, `POST /admin/approvals/{id}/approve` / `/reject` 로 결정합니다. `/admin/approvals` 는 `id`, `request_id`, `status`, `team_id`, `api_key_id`, `user_id`, `subject_type`, `subject_id`, `decided_by`, `reason`, `window`, `since`, `limit` 필터를 지원합니다. 클라이언트는 승인된 ID를 같은 헤더로 재전송합니다.

MCP Security Center는 MCP 탭 또는 `GET/POST /admin/mcp/tools` 에서 tool별 `low|medium|high|critical` risk와 `allow|require_approval|block` action을 관리합니다. `/admin/mcp/tools` 는 `server`, `tool`, `api_key_id`, `mcp_only`, `risk_level`, `action`, `configured`, `window`, `limit` 필터를 지원하며, UI에서는 tool 행에서 risk/action/note를 바로 저장할 수 있습니다. `/admin/anomalies` 는 기존 모델 이상탐지에 더해 비용 anomaly event 뷰를 반환하며, replay/golden/context 운영 API는 `/admin/replay`, `/admin/golden-prompts`, `/admin/contexts` 입니다.

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
| 🧭 라우팅 | 선택된 provider·모델, 라우팅 근거 코드(`route_reason`: 헤더 지정/쿼리/모델 패턴 자동/기본/auto router 등), 매칭된 패턴, **복잡도 점수(0~100)와 티어**(simple/standard/complex/reasoning), risk score, provider health score, fallback chain, 사람이 읽는 decision reason |
| 🔁 폴백 | 폴백 발생 여부, 최초→대체 provider, 사유(전송 실패 등) |
| 🟢 캐시 | 캐시 히트 여부, cached 토큰, **절감액**(전체 캐시 / 프롬프트 캐시) |
| 🛡 안전 | 차단 여부, 마스킹 적용, 실패한 안전·보안 평가(PII/인젝션/독성/도구 인자 시크릿) |
| 💰 비용 | 실제 비용 vs 정가(캐시 미적용 시), **절감액**, 토큰 분해(prompt/completion/cached/reasoning) |
| 🧵 세션 | 세션 타임라인 링크, 스트리밍 여부, 원문 상세 링크 |

복잡도 점수는 프롬프트 토큰·대화 깊이·도구 수 기반 휴리스틱 추정치이며(모델 산출값 아님) UI에 그 사실이 명시됩니다.

API: `GET /admin/requests/{id}/explain` → `{routing, fallback, cache, safety, cost, session}`. `routing` 에는 `chosen_model`, `chosen_provider`, `complexity`, `risk_score`, `health_score`, `fallback_path`, `route_reason`, `decision_reason` 이 포함됩니다. `GET /admin/requests/{id}/links` 는 요청 상세·XView·Waterfall·MCP Waterfall·Text2SQL Timeline·라우팅 결정 연결 정보와 카운트를 한 번에 반환합니다. 이때 `policy_decision_count` 는 `decision=default` 를 제외한 실질 거버넌스 판단 수이고, `policy_decision_total` 은 원시 감사 이벤트 수입니다.

Intelligent Routing Engine API:

- `POST /admin/routing/preview` — 실제 upstream 호출 없이 `auto` / `vibe/auto` / `vibe-coders/auto` 라우팅 결과 미리보기. 응답에는 자동화·필터링용 `route_reason` 과 사람이 읽는 `decision_reason` 이 함께 포함됩니다. body에 `api_key_id` 를 넣으면 해당 API 키의 allowed/denied model/provider 정책까지 반영합니다(team_admin은 자기 팀 키만 가능)
- `GET /admin/routing/decisions` / `GET /admin/routing/decisions/{id}` — 요청별 selected model/provider, complexity/risk/health, fallback path, decision reason 조회
- `GET /admin/routing/health` — 최근 latency/p95/timeout/429/5xx/fallback rate 기반 provider health score 조회. 응답에는 provider 원본 점수와 함께 `ranking`, `degraded`, `alerts`, `trend` 가 포함됩니다. 관리자 화면은 라우팅 탭의 `Provider Health` 하위 화면(`#/routing/health`)에서 같은 데이터를 표시합니다.

`auto` 계열 모델 별칭은 일반 라우팅 규칙보다 우선합니다. `X-Proxy-Provider` 또는 `?provider=` 로 provider 를 고정해도 auto 모델 rewrite 는 계속 수행되고, provider 선택만 클라이언트 지정값을 따릅니다. Provider `model_patterns` 가 `vibe/*` 처럼 alias 기준으로 등록되어 있으면, 선택된 실제 모델 패턴이 없을 때 요청 alias 기준 provider도 후보로 사용합니다. `GET /v1/models` 는 SDK 호환성을 위해 인증 모드에서도 공개 조회로 처리합니다.

---

## 3-2. Waterfall (트랜잭션 타임라인)

XView가 "요청 분포"를, 세션 비용 타임라인이 "누적 비용 곡선"을 본다면, **Waterfall은 한 세션 안에서 시간이 어디로 흘렀는지**를 봅니다. 분산 트레이싱 도구(Jaeger·크롬 네트워크 워터폴)와 같은 간트 막대 표현입니다.

### 세션은 어떻게 묶이나 (명시적 + 추론)

Waterfall·세션 비용 타임라인·LLM Session Explorer·에이전트 루프 탐지는 모두 `session_id` 로 요청을 묶습니다. 세션은 2단계로 정해집니다.

1. **명시적**: 클라이언트가 보낸 값(헤더 `X-Session-ID`/`X-Vibe-Session-ID`/`X-Conversation-ID` 또는 바디 `session_id`/`chat_id`/`conversation_id`/`thread_id`/`metadata.*`). Langflow·OpenWebUI 등이 해당.
2. **추론**: 명시적 세션이 없으면(Claude Code·Cursor·Roo·Qwen 등 대부분의 코딩 툴) `api_key + IP + User-Agent`(+ 옵션 `X-Vibe-Repo`/`X-Vibe-Branch`) 신원과 **슬라이딩 비활성 윈도우**로 자동 생성. ID는 `sess_<12hex>`. 같은 클라이언트의 연속 호출은 한 세션이 되고, `SESSION_IDLE_TIMEOUT`(기본 30분) 이상 비활성이면 새 세션이 시작됩니다.

`SESSION_INFERENCE_ENABLED=false` 로 두면 추론을 끄고 요청별(`trace:<id>`)로 분리됩니다(세션 묶음 없음). 추론 세션은 DB의 `inferred_sessions` 테이블에도 저장되므로 게이트웨이 재시작 후에도 idle window 안에 들어온 같은 클라이언트는 기존 `sess_<12hex>` 를 복구합니다. `SESSION_IDLE_TIMEOUT` 을 지난 추론 세션은 새 세션으로 분리되고, 오래된 복구 상태는 자동 정리됩니다. 세션 헤더가 전혀 없던 레거시 요청은 `no-session` 으로 묶입니다.

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
3. **MCP 서버별 표**: 서버마다 도구 종류·호출·오류·오류율·고유 키·**호출 IP(고유 IP 수 + 예시 IP)**·마지막 사용. 행 클릭 시 그 서버로 필터링. 서버 라벨이 `(none)`(일반 function tool, 서버 정보 없음)이어도 호출 IP·고유 키로 출처를 식별할 수 있습니다.
4. **Tool 리더보드**: (서버, 도구) 별 정의·호출·결과·오류·오류율·고유 키·**호출 IP**. `호출`/`오류` 버튼으로 해당 도구를 사용한 요청을 모달로 drill-down(요청별 IP·키 확인)
5. **에이전트 루프 의심**: 최근 24시간 동안 한 세션에서 같은 도구를 10회 이상 호출한 경우 표시. 폭주/무한루프 에이전트를 비용 사고 전에 발견. 30회 이상은 빨간색.
6. **도구 카탈로그 / 드리프트**: 서버별로 관측된 도구 목록과 최초/최근 관측 시각. 최근 24시간 내 처음 나타난 도구는 `신규` 배지로 강조(공급망 변조·권한 확대 탐지), 30일간 안 보이면 `미사용` 배지. 섹션 제목에 신규 도구 수 표시.
7. **MCP Gateway 업스트림**: 아래 게이트웨이 절 참고
8. **MCP 서버 정책**: 아래 보안 절 참고

### MCP Gateway — 업스트림 서버 집약 (단일 /mcp)

vibe-coders 는 LLM 게이트웨이이자 **MCP 게이트웨이**입니다. 여러 업스트림 MCP 서버를 한 곳(`/mcp`, JSON-RPC 2.0 Streamable HTTP)에 모아, 클라이언트는 게이트웨이 하나만 연결하면 모든 서버의 도구를 씁니다.

- **등록 폼**: 이름(네임스페이스), Streamable HTTP MCP URL, Bearer 토큰(선택, 암호화 저장). ID는 이름에서 슬러그로 자동 생성되며 도구 접두사로 쓰입니다(`<id>__`).
- **표**: 이름/ID·URL·인증 여부·상태(사용/중지)·동작. 업스트림 도구 탐색에 실패하면 `탐색 오류` 배지(마우스 오버 시 사유).
- **등록 확인(중요)**: 각 행의 **"테스트/도구"** 버튼 → 그 업스트림에 **즉시 라이브 연결**(initialize+tools/resources/prompts list)하여 성공 여부와 노출되는 도구·리소스·프롬프트 목록(게이트웨이 네임스페이스 이름 포함)을 모달로 보여줍니다. 실패 시 사유 표시. API: `GET /admin/mcp/upstreams/{id}/probe`.
- **게이트웨이 호출 검증(curl)**:
  ```bash
  # 집약된 도구 목록
  curl -s http://<host>:8080/mcp -H "Authorization: Bearer <발급키>" \
    -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  # 특정 도구 호출 (네임스페이스 이름 사용)
  curl -s http://<host>:8080/mcp -H "Authorization: Bearer <발급키>" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"<업스트림ID>__<도구>","arguments":{}}}'
  ```
  호출 후 MCP 탭의 서버/도구 표·관측에 해당 업스트림 이름으로 집계가 쌓입니다.
- **동작 원리**: 세 가지 MCP 1차 객체를 모두 집약합니다(30초 캐시).
  - **도구**: `tools/list` 를 합쳐 `<id>__<도구>` 로 노출, `tools/call` 은 네임스페이스로 라우팅.
  - **프롬프트**: `prompts/list` 를 `<id>__<프롬프트>` 로 노출, `prompts/get` 은 네임스페이스를 떼어 해당 업스트림으로 라우팅.
  - **리소스**: `resources/list`·`resources/templates/list` 를 집약(원본 URI 보존), `resources/read` 는 URI로 소유 업스트림에 라우팅. (URI 충돌 시 먼저 등록된 업스트림 우선)
  모든 호출은 위의 MCP 서버 정책(allowlist/차단, 서버 라벨=업스트림 이름)과 사용자 귀속·MCP 관측에 통합 기록됩니다. `initialize` 응답은 tools+resources+prompts capability 를 광고합니다.
- **클라이언트 설정**: MCP 서버 URL 을 `http://<gateway>:8080/mcp` 하나로. 인증은 `/v1` 과 동일한 proxy key(`Authorization: Bearer …`).
- API: `GET|POST /admin/mcp/upstreams`, `PATCH|DELETE /admin/mcp/upstreams/{id}`. 메트릭은 기존 `proxy_mcp_tool_calls_total`/`proxy_mcp_tool_errors_total` 에 합산.

> 현재 Streamable HTTP 업스트림을 지원합니다(JSON 및 SSE 응답 모두 처리). 라우팅은 목록에 노출된 도구·프롬프트·리소스 대상입니다(템플릿으로 동적 생성된 미등록 URI 읽기는 미지원). stdio 서브프로세스 MCP 서버 연결은 향후 과제입니다.

### Gateway MCP — 게이트웨이 자체 기능 (`/mcp/gateway`)

`/mcp` (업스트림 집약)과 **별개로**, 게이트웨이 자신의 기능을 MCP 도구로 노출하는 두 번째 엔드포인트입니다. 헷갈리기 쉬우니 운영자는 차이를 명확히 안내하세요.

| | `/mcp` | `/mcp/gateway` |
|---|---|---|
| 노출 대상 | 등록된 **외부 업스트림 MCP 서버**의 도구 | **게이트웨이 자체 기능**(chat·라우팅·사용량·쿼터·Text2SQL·앱/워크플로 실행) |
| 도구 이름 | `<업스트림ID>__<이름>` | `gateway_*` (예: `gateway_chat`, `gateway_run_workflow`) |
| 업스트림 등록 | 필요 | **불필요**(내장 tool 집합) |
| 실행 안전성 | 업스트림이 부수효과 수행 | 실행형 tool 은 `/v1` 파이프라인 재생(거버넌스·쿼터·정책·로깅 동일), 읽기형은 미실행 미리보기 |

- **카탈로그 확인**: 어드민 MCP 탭에 Gateway MCP 카탈로그(tools/resources/prompts)와 연결 설정이 표시됩니다. API: `GET /admin/gateway-mcp/info`.
- **무클라이언트 검증**: `POST /admin/mcp/gateway/test` 로 외부 MCP 클라이언트 없이 tool 을 name+arguments 로 직접 호출해 검증할 수 있습니다(읽기 진단).
- **인증·귀속**: `/v1` 과 동일한 proxy key. 모든 호출은 호출자 권한·쿼터·정책·MCP 관측에 통합됩니다.

### MCP Tool Contract Registry (`/mcp/gateway` tool 계약·드리프트)

`/mcp/gateway` 가 노출하는 tool 의 입력/출력 스키마·위험등급(low/medium/high)·타임아웃·허용 역할·비용 정책·소유자를 **계약**으로 고정하고, 실제 노출 스키마와의 드리프트를 탐지합니다. MCP 탭 하단의 "MCP Tool Contract Registry" 섹션 또는 API로 관리합니다.

- `GET|POST|DELETE /admin/mcp/contracts` — 계약 목록/등록/삭제(등록 시 스키마 JSON 유효성·risk_level 검증).
- `POST /admin/mcp/contracts/validate` — 등록 계약과 실제 게이트웨이 tool 집합을 비교해 `missing`(tool 소실)·`drift`(입력 스키마 속성 차이: `declared_only`/`live_only`)를 보고합니다. `gateway` 외 namespace 는 자동 비교 대상이 아닙니다(`not_checkable`). 속성 키 집합 비교이며 타입 심층 비교는 아닙니다.
- 활용: 게이트웨이 버전업으로 tool 시그니처가 바뀌면 드리프트로 조기에 드러나므로, 계약을 갱신하거나 클라이언트 영향도를 점검하는 운영 신호로 사용하세요.

### MCP Discovery 가상 모델

`/v1/chat/completions` 에서 `vibe/grounded`, `vibe/research`, `vibe/all-mcp`(별칭 `vibe/all_mcp`)를 모델명으로 호출하면 MCP Discovery 경로가 동작합니다. 후보 MCP는 설명·도메인·도구명·health를 기반으로 정렬되지만, agentic 경로에서는 selector 점수가 hard gate가 아니라 **백킹 LLM에게 넘길 후보 순위 가중치**로만 사용됩니다. 백킹 LLM이 직접 tool call 여부를 결정하고, 백킹 모델을 사용할 수 없을 때만 정적 fallback이 관련성 gate를 적용합니다.

백킹 Chat 모델은 `MCP_AGENTIC_MODEL` 환경변수 또는 어드민 `설정 > 런타임 설정`의 `mcp.agentic_model`에서 지정합니다. 비워두면 기존 auto-router가 정책 기반으로 선택합니다. 예를 들어 `qwen-plus`, `claude-sonnet-4`, `gpt-4.1`처럼 provider model pattern에 등록된 실제 모델명을 넣으면 다음 MCP Discovery 요청부터 즉시 반영됩니다.

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

## 4-2. 에이전트 성능 분석 (Agent Performance)

어떤 코딩 에이전트가 가장 잘 동작하고, 가장 비싸고, 도구 오류가 많은지 비교하는 리더보드입니다. 요청 **User-Agent**로 에이전트(Claude Code/Cursor/Roo Code/Cline/Qwen Code/Continue/…)를 분류하고 chat 호출을 집계합니다.

| 열 | 의미 |
| --- | --- |
| 에이전트 | User-Agent 키워드로 분류(미상은 UA 앞 토큰). 행에 마우스를 올리면 예시 원본 UA |
| 요청 / 토큰 | 윈도우 내 chat 호출 수와 누적 토큰 |
| 성공률 | 2xx · 오류 없음 · 폴백 없음 비율. ≥90% 녹색 · ≥75% 노랑 · 그 외 빨강 |
| 폴백률 | 업스트림 폴백 발생 비율 |
| 평균/누적 비용 | 요청당 평균 KRW와 합계 |
| 평균 지연 / 첫 청크 | 전체 지연과 TTFB 평균 |
| 도구 오류율 | tool 오류 / tool 호출 (오류율 ≥10% 빨강) |

상단 KPI: 에이전트 수, 총 요청, **가중 성공률**(요청수 가중), 누적 비용. 윈도우(24h/7d/30d) 토글. API: `GET /admin/agents?window=7d` → `{agents[]}`.

> 에이전트가 정확히 분리되려면 클라이언트가 식별 가능한 User-Agent를 보내야 합니다. 같은 UA를 쓰는 도구는 한 버킷으로 합쳐집니다.

---

## 4-3. VCS 상관 (Prompt → Commit → MR → Merge)

프롬프트가 실제 코드/MR 로 이어졌는지 추적합니다. **GitLab·Bitbucket(Server/Cloud)·범용** 수집을 지원하며 오프라인망에서 동작합니다(외부 의존성 없음).

### 활성화 (필수: `VCS_WEBHOOK_SECRET`)

이 환경변수를 설정해야 `/vcs/*` 수집 엔드포인트가 켜집니다(미설정 시 403).

| 소스 | 설정 |
| --- | --- |
| GitLab | 프로젝트 → 설정 → 웹훅. URL `http://<gateway>:8080/vcs/webhook/gitlab`, **Secret Token** = `VCS_WEBHOOK_SECRET`, 트리거: Push events, Merge request events |
| Bitbucket | 웹훅 URL `http://<gateway>:8080/vcs/webhook/bitbucket?token=<VCS_WEBHOOK_SECRET>`. Server `pr:*`/`repo:refs_changed`, Cloud `pullrequest:*`/`repo:push` |
| 범용 / CI · git 훅 | `POST http://<gateway>:8080/vcs/events`, 헤더 `X-Vibe-VCS-Secret: <secret>`, 바디 `{provider,kind,repo,branch,sha,title,session_id?}` 또는 `{events:[...]}` |

### 세션·사용자 연결

- 커밋 메시지 · MR 제목 · 브랜치에 **`Vibe-Session: <세션ID>`**(또는 `[vibe:<세션ID>]`) 마커가 있으면 그 세션에 연결됩니다. (개발자 commit template / `commit-msg` 훅으로 자동 삽입 권장)
- 연결된 세션의 **주 사용자(api_key)** 가 자동으로 함께 연결되어, 어느 개발자의 프롬프트가 이 커밋/MR 로 이어졌는지 추적됩니다.
- 범용 수집은 `session_id` 를 직접 지정할 수 있어, 마커 없이 CI 가 빌드 컨텍스트로 연결할 수 있습니다.

### 보기

두 곳에서 봅니다: **(1) `VCS` 탭** — 전체 커밋·MR 목록(저장소/세션/키/유형 필터, 세션·사용자 링크로 드릴다운). **(2) 세션 타임라인 모달** — 그 세션에 연결된 커밋/MR 표(유형 + MR 상태 배지, 제목 링크, 저장소·브랜치, 작성자, 시각). API: `GET /admin/vcs/events?session_id=&repo=&api_key_id=&kind=`.

> 현재 라우팅/표시는 마커로 연결된 이벤트 중심입니다. Bitbucket Server push 웹훅은 커밋 메시지를 포함하지 않으므로(레퍼런스 변경만), 그 경우 마커 연결은 MR 제목 또는 범용 수집(git 훅)으로 보완하세요.

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

### 프롬프트 지문 (Prompt Fingerprint)

검색 폼 아래의 별도 카드입니다. 의미적으로 유사한 작업 프롬프트를 **어휘 지문**(`fp_…`)으로 묶어 "반복되는 작업 유형"을 드러냅니다. 지문은 ① 붙여넣은 코드(``` 블록·인라인 코드) 제거 → ② 핵심 키워드 추출(필러/일반 동사 stopword 제거, 한국어 조사·어미 정규화) → ③ 작업유형 + 상위 키워드를 해시. **의미 임베딩이 아니라 결정적 어휘 휴리스틱**이므로(문서에 명시), 같은 템플릿·반복 작업은 잘 묶지만 표현이 크게 다른 동일 의도는 못 묶을 수 있습니다.

| 열 | 의미 |
| --- | --- |
| 예시 프롬프트 | 그 클러스터의 대표 요청에서 가져온 마스킹 프롬프트(축약) + 지문 ID |
| 유형 / 건수 | 작업유형, 윈도우 내 호출 수 |
| 성공률 | 2xx · 오류 없음 · 폴백 없음 |
| 평균/누적 비용 · 평균 토큰 | 클러스터 비용 프로파일 |
| 모델 수 | 이 작업에 쓰인 distinct 모델 수 |
| 최다/최저가 모델 | 최다 사용 모델, 그리고 **최고 성공률 대비 5%p 이내에서 가장 저렴한** 모델(비용 최적 후보) |

윈도우(24h/7d/30d) 토글. API: `GET /admin/prompts/fingerprints?window=7d&limit=100`. 활용: "이 반복 작업은 비싼 모델을 쓰는데 최저가 모델도 성공률이 비슷하다 → 다운그레이드", 또는 Knowledge Cache 후보(반복 정형 프롬프트) 식별.

---

## 6. 사용자 / IP

### 사용자(Proxy API 키) 목록

- 키 이름·소유자·팀·상태·총 요청·총 토큰·누적 KRW·평균 지연·마지막 호출 (상대 시간).
- 헤더 클릭 정렬, 키 행 클릭 시 상세.

#### 사용자 식별 상태 (active / external / anonymous)

게이트웨이는 키의 **해시만** 저장하므로, 들어온 Bearer 키는 등록 여부에 따라 다음으로 귀속됩니다.

| 상태 | 의미 |
| --- | --- |
| `active` | 등록된 proxy key(`PROXY_API_KEYS` 또는 "API 키 발급"). 정확한 사용자/팀/쿼터 통제 대상. |
| `external` | 등록 안 된 키. **키 지문으로 사용자별 자동 분리**됩니다(ID는 발급 키와 동일하게 `key_<해시16>`, 차이는 **상태**뿐). 같은 키=같은 사용자. 클라이언트가 `X-Vibe-User`/`X-Vibe-Team` 헤더를 보내면 이름·팀이 채워집니다. |
| `anonymous` | 키가 없고 등록 키도 없는 호출. |

"사용자별 이력이 전부 `passthrough`/`anonymous`" 로 보인다면, 그 사용자들이 **등록되지 않은 동일 키 또는 키 없음**으로 호출하고 있다는 뜻입니다. 해결: ① 사용자별로 키를 **발급**(권장 — 쿼터·팀 강제 가능), 또는 ② 사용자별로 **다른 키**를 보내게 하면 상태 `external` 로 자동 분리됩니다(`ATTRIBUTE_EXTERNAL_KEYS=true`, 기본). `ATTRIBUTE_EXTERNAL_KEYS=false` 면 구버전처럼 모두 `passthrough` 단일 버킷으로 묶입니다.

> 식별자 prefix 안내: 모든 사용자 식별자는 이제 `key_<해시16>` 로 통일되고, **등록 여부는 prefix 가 아니라 상태(active/external)** 로 구분합니다. (구버전의 `ext_…` 식별자는 게이트웨이 시작 시 자동으로 `key_…` 로 이관되며 과거 이력도 함께 이동합니다.)

#### "등록한 키인데 ext_/passthrough 로 로깅되거나 사용자 상세가 0건이에요"

핵심 원칙: **클라이언트가 실제로 보내는 키 문자열이 곧 사용자 식별자**이고, 게이트웨이는 그 키의 **해시**로만 매칭합니다. 발급한 `key_xxxx` 의 지표가 0이라면, 거의 항상 **클라이언트가 그 키를 정확히 보내고 있지 않은 것**입니다(오타·공백·옛 키·`Bearer ` 값 오기재, 또는 발급 화면에서 한 번 표시된 `pcg_…` 시크릿을 클라이언트에 넣지 않음).

**바로 확인하는 법**: `/v1` 응답 헤더 **`X-Api-Key-Id`** 에 게이트웨이가 인식한 식별자가 담깁니다.

```bash
curl -i http://<host>:8080/v1/chat/completions -H "Authorization: Bearer <발급키>" \
  -H "Content-Type: application/json" -d '{"model":"gpt-4.1-mini","messages":[{"role":"user","content":"hi"}]}' | grep -i x-api-key-id
```

여기에 발급한 `key_xxxx` 가 보이면 정상, `passthrough`/다른 `key_` 가 보이면 클라이언트가 다른 키를 보내는 것입니다.

확인·복구 절차:

1. **사용자 목록**에서 어디에 트래픽이 쌓였는지 확인 — 같은 클라이언트가 미등록 키를 쓰면 상태 `external` 항목으로 잡혀 있습니다.
2. 그 `external` 행의 **"관리 등록"** 버튼(또는 사용자 상세의 동일 버튼)으로 이름·팀을 부여하고 active 로 **승격**합니다. 게이트웨이가 이미 그 키의 해시를 저장해 두었으므로 **plaintext 없이** 승격되며, **클라이언트 재설정도 필요 없습니다** — 그 클라이언트가 계속 보내는 키가 이제 정식 사용자로 집계되고 과거 이력도 그대로 그 식별자에 남습니다.
3. 또는 클라이언트가 보내는 키를 **발급한 키와 글자 단위로 일치**시키세요(발급 시 표시된 `pcg_…` 시크릿을 그대로 사용).

> 승격은 `PATCH /admin/api-keys/{id}` 에 `{"status":"active","name":"…","team":"…"}` 를 보내는 것과 동일합니다. 이름/팀만 바꾸려면 status 를 생략하세요. 키 해시는 항상 보존됩니다.

> 주의: `passthrough`·`anonymous` 는 키 해시가 없는 합산 버킷이라 승격할 수 없습니다(과거 트래픽은 소급 분리 불가). 분리가 필요하면 지금부터 사용자별로 다른 키를 쓰게 하세요.

### 사용자 상세

- 키 메타 (id/소유자/팀/상태)
- 고급 지표: 최근 24h 요청·토큰·KRW, 오류율, 전체/첫 청크 P95 지연, 평균 첫 청크, 토큰 분해(prompt/completion/cached/reasoning), 고유 모델/IP 수
- 일별 사용량 표 (최근 60일)
- 모델별 / IP별 / 언어별 표
- 상태 분포와 Asia/Seoul 기준 최근 30일 시간대 히트맵
- 최근 호출 100건 (필터/상세 모달 사용 가능)

### IP 목록 / 상세

같은 구조이며, IP 별 상세에는 "API 키별" 표가 함께 표시됩니다 — 한 공용 IP 에서 어떤 키들이 호출했는지 확인할 때 사용.

### 팀 벤치마크 / AI 활용지수 / AI Incident

| 화면 | 내용 | API |
| --- | --- | --- |
| 팀 탭 상단 "팀 벤치마크" | 팀별 활성 인원·요청·**월비용(30d)**·성공률·커밋·머지 MR·**생산성 점수**(멤버 점수의 요청 가중 평균) | `GET /admin/benchmark/teams?window=30d` |
| 사용자 탭 하단 "AI 활용지수" | 사용자별 Prompt 수·세션·활동일·커밋·머지 MR·도구 호출·성공률·비용·**활용지수(0~100)** | `GET /admin/benchmark/users?window=30d&limit=100` |
| 안전 탭 "AI Incident" | 프로바이더별 **폴백/5xx 급증(시간당 ≥ 5건)** 을 장애로 추정, 연속 시간대 병합, 폴백·5xx·**영향 사용자 수**·진행 중 여부 | `GET /admin/incidents?window=7d&min_events=5` |

## 12. 거버넌스 · 운영 신규 도구 (v0.64~v0.74)

아래는 코드 검증·세션 관측·정책 롤아웃·자산 거버넌스 관련으로 추가된 관리자 화면/엔드포인트입니다. 모두 RBAC(`admin:read` 또는 `security:read`)이며 원문 prompt/코드는 저장·노출하지 않고 메타데이터만 다룹니다.

### AI 코드 출력 검증 게이트
- 모델 응답의 코드블록을 언어별 정적 점검(위험 API·파괴적 명령·하드코딩 시크릿·구문 균형)해 위험도/테스트 가능성을 산출. 폐쇄망·외부 컴파일러 미사용.
- `POST /admin/code-verify {text}` — 임의 텍스트 즉시 검증(무상태). `GET /admin/code-verify/stats?days=` — 영속된 verdict의 모델별 위험 리더보드.
- Chat 테스트 멀티런에 "코드 검증" 버튼, 단일 Chat 응답 "실행 요약"에 코드 검증 섹션, 자동 평가(rubric) safety 점수에 반영. /v1 응답 verdict는 응답 텍스트 캡처(`LOG_RESPONSE_TEXT`/캐시) 시 영속되어 요청 상세·트레이스에 노출.

### Agent Session Flight Recorder (세션 비행기록)
- "세션 비행기록" 탭: 최근 코딩 세션(클라이언트 `session_id`) 목록 → 세션별 시간순 타임라인(요청·종류·모델·지연·토큰·비용·도구) + 위험 오버레이(시크릿/정책 차단/위험 코드) + 규칙 기반 RCA 요약(정상/주의/위험).
- `GET /admin/sessions?days=`, `GET /admin/sessions/{session_id}/flight-recorder`. 요청 상세 모달의 Session 행 "비행기록" 링크에서도 진입.

### Policy Canary & Shadow Enforce
- 정책 어드바이저의 추천 카드 "섀도우 영향" 버튼: 최근 트래픽에 시뮬레이션해 차단 예상·영향 사용자/팀·**오탐 후보(과거 2xx였으나 차단될 요청)**·차단 비용(절감 추정)을 표시(`POST /admin/policies/simulate`의 `shadow` 블록).
- 정책에 `rollout_percent`(canary): 1~99면 결정적 트래픽 슬라이스에만 enforce, 슬라이스 밖은 `canary_shadow` 결정으로 기록만. `GET /admin/policies/canary-status` + 어드바이저 "Canary 롤아웃 현황" 카드에서 실집행 vs 섀도우 비교 후 "N%로 상향".

### AI 자산 SBOM
- "AI 자산 SBOM" 탭 / `GET /admin/sbom?type=`: 스킬·워크플로·앱·모델계약·프롬프트 자산의 소유권·의존성·상태를 통합 명세로 보여주고 거버넌스 공백("owner 없음", high 위험 production, 적합성 검증 미흡)을 표시. JSON 내보내기.

### Journey Probe (개발도구 연결 합성 점검)
- "Journey Probe" 탭 / `POST /admin/journey-probe {proxy_key, clients?}`: Cursor·Roo·Cline·OpenAI SDK 등 도구별 실제 연결 journey(모델 목록·MCP initialize/tools-list)를 supplied Proxy API Key로 합성 점검(비용 발생 chat 호출 없음). "서버는 살아있는데 Cursor만 안 됨"을 분리.

### 파드 운영 맵 / 프라이버시 원장 / AI 업무성과 / 온보딩 점검
- "파드 운영 맵" 탭 / `GET /admin/pods`: 멀티 파드 하트비트·빌드·런타임 설정 수렴(applied vs current token) 상태. live/stale·설정 최신 여부.
- "프라이버시 원장" 탭(security) / `GET /admin/privacy-ledger?dimension=team|model|provider&days=`: 민감정보 탐지/마스킹/차단량 + 외부 provider 전송 요청·토큰을 차원별 감사 원장으로 집계. `?format=csv` 내보내기.
- "AI 업무성과" 탭 / `GET /admin/productivity?days=`: `X-Vibe-Repo` 귀속 AI 사용량과 VCS commit/merge_request를 repo별로 상관, 머지당 비용 산출.
- 온보딩 준비 점검: `POST /admin/apps/onboarding-check`(AI 앱), `POST /admin/mcp/onboarding-check`(MCP 업스트림) — 등록 전 owner·접근범위·문서·(고위험 MCP는)승인 게이트 등 required/recommended 체크리스트로 SBOM 공백을 생성 시점에 예방.

### 개발자 오버레이
- `GET /me/overlay`(사용자): 현재 모델·예산 사용/한도/남음·액션 항목·추천을 한 번에 폴링하는 컴팩트 상태(IDE 확장/패널용). CLI `vibe status [--table]`로도 확인.

활용지수 공식(관측 기반 휴리스틱, **인사평가 지표 아님** — 도입 현황 파악용): `요청량 30% + 활동일수 20% + 커밋 20% + 머지 MR 15% + 성공률 15%` (포화 상한: 요청 300, 활동일 20, 커밋 30, MR 10 / 30일 기준). 커밋·MR 은 VCS 상관(웹훅 또는 추론)으로 사용자에 연결된 것만 집계됩니다 — VCS 연동이 없으면 해당 컬럼은 0으로 나오고 나머지 요소만으로 점수가 계산됩니다.

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

### 비용 가드 / 예측 (Cost Guard)

호출을 업스트림에 보내기 **전에** 입력/출력 토큰·KRW 비용·지연을 예측하고, 예상 비용이 임계값을 넘으면 차단합니다(쿼터가 *누적 사용량*을 막는다면, 비용 가드는 *단일 호출*의 예상 비용을 막습니다).

- **가드 사용 + 임계값(KRW)**: 켜면 예상 비용 > 임계값인 chat 호출을 `HTTP 402` + `X-Cost-Guard: blocked` 로 차단. 클라이언트가 `X-Cost-Approve: 1` 헤더를 보내면 승인되어 통과합니다(대형 작업 의도적 실행). 메트릭 `proxy_cost_guard_blocked_total`.
- **응답 헤더**: 모든 chat 응답에 `X-Estimated-Input-Tokens / X-Estimated-Output-Tokens / X-Estimated-Cost-KRW / X-Estimated-Latency-MS`.
- **예측 근거**: 출력 토큰은 모델별 최근 7일 평균(표본 ≥5), 없으면 요청 `max_tokens`, 그것도 없으면 기본 600. 비용은 모델 가격표 기준(가격 미설정 모델은 차단하지 않음).
- **비용 예측기(dry-run)**: 같은 카드에서 모델·입력 토큰·max_tokens 를 넣어 즉시 예상 비용을 확인. API `POST /admin/cost/predict`. 가드 설정 API `GET|POST /admin/cost {enabled, threshold_krw}`.

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

### 9.2.2 라우팅 학습 추천 (Routing Learning Engine)

위 규칙이 **사람이 정한 고정 규칙**이라면, 학습 추천은 **실측 결과로 최적 모델을 제안**하는 학습 계층입니다. 게이트웨이는 모든 chat 호출에 **작업유형**(프롬프트 키워드 추정: 리팩토링/생성/디버그/설명/테스트/변환/문서/리뷰)과 **복잡도 버킷**(낮음 0–33 / 중간 34–66 / 높음 67–100)을 기록하고, 모델별 성공률·비용·지연·피드백을 누적합니다.

설정 탭의 **"라우팅 학습 추천"** 표:

| 열 | 의미 |
| --- | --- |
| 작업유형 / 복잡도 | 학습 셀 키 |
| 추천 모델 | 표본이 충분한(기본 `min_samples=20`) 모델 중 **성공률 최고(동률 시 저비용)**. `저신뢰` 배지 = 비교 대상 중 표본 부족 모델 존재 |
| 성공률 / 평균 비용 / 표본 | 추천 모델의 실측치. 성공 = 2xx · 오류 없음 · 폴백 없음 |
| 현재 최다 사용 | 그 셀에서 실제로 가장 많이 쓰인 모델과 성공률(추천과 다르면 노란 배지) |
| 동작 | **"규칙으로 적용"** → 해당 복잡도 구간을 추천 모델로 바꾸는 라우팅 규칙 생성 |

"상세 매트릭스"를 펼치면 (작업유형 × 복잡도 × 모델) 셀별 요청 수·성공률·폴백률·비용·지연·피드백을 모두 볼 수 있습니다.

- API: `GET /admin/routing/learning?window=7d&min_samples=20` → `{cells[], recommendations[]}`.
- **human-in-the-loop**: 추천은 자동 적용되지 않습니다. 운영자가 "규칙으로 적용"을 눌러야 9.2.1 규칙으로 반영됩니다. 적용 규칙은 **복잡도 구간 단위**로 동작하므로(작업유형은 참고용), 같은 구간에서 작업유형별 추천이 갈리면 운영자가 판단해 적용하세요.
- 작업유형·복잡도는 프롬프트 기반 휴리스틱 추정치입니다(모델 산출값 아님).

### 9.2.3 Knowledge Cache (반복 규칙 중앙 등록)

매 호출에 반복 전송되는 사내 코딩 규칙·시스템 프롬프트를 한 번 등록해 두고, 클라이언트가 짧은 참조만 보내면 게이트웨이가 업스트림 전송 시 전체 텍스트로 확장합니다.

- 등록 폼: 이름, ID(slug, 비우면 이름에서 자동 생성), 본문. 토큰 추정치는 자동 계산. 표에서 사용 횟수·최근 사용·참조 문자열(`{{kb:ID}}`)·사용/중지·삭제.
- 클라이언트 참조 방법(둘 중 하나):
  - 메시지 본문 플레이스홀더 `{{kb:ID}}`
  - 헤더 `X-Vibe-Knowledge: ID1,ID2` → 시스템 메시지로 맨 앞에 주입
- 확장된 응답에는 `X-Knowledge-Expanded: <id,...>` 헤더. 메트릭 `proxy_knowledge_expansions_total`, `proxy_knowledge_tokens_total`. 5초 캐시로 변경이 약 5초 내 전파.
- **감사 로그에는 확장 전 짧은 참조가 그대로 보존**되고(저장 절감), 모델에는 전체 본문이 전달됩니다. 프롬프트 지문에서 발견한 반복 정형 프롬프트를 여기에 등록하는 워크플로가 자연스럽습니다.

| 효과 | 설명 |
| --- | --- |
| 거버넌스 | 규칙을 한 곳에서 고치면 모든 호출에 즉시 반영 (클라이언트 수정 불필요) |
| 페이로드·저장 | 클라이언트→게이트웨이 본문과 프롬프트 로그가 짧아짐 |
| 업스트림 비용 | provider 프리픽스 캐싱(cached 토큰)과 결합될 때 절감 — 게이트웨이가 안정적 프리픽스로 주입 |

API: `GET /admin/knowledge`, `POST /admin/knowledge`(`{name, id?, content, enabled?}`), `PATCH|DELETE /admin/knowledge/{id}`.

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
