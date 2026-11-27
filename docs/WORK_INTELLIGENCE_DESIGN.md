# AI 업무 활용 인텔리전스 — Gap 분석과 설계

기존 사용량·비용 통계(호출 수, 토큰, 모델)를 **업무 중심** 분석으로 확장한다. 이 문서는 구현 전에 확정한
기존 기능 분석, Gap, 데이터 모델, API 계약이며 구현과 테스트는 이 계약을 따른다.

## 1. 기존 기능 분석 (재사용 대상)

| 영역 | 이미 있는 것 | 위치 |
| --- | --- | --- |
| 요청 로그 | `request_logs`(session_id, trace_id, api_key_id, model, provider, endpoint, user_agent, status_code, latency_ms, complexity, `task_type`, `prompt_fingerprint`, created_at, `ingested_at`), `token_usage`, `language_stats`, `tool_invocations`(server_label, tool_name, is_mcp), `prompt_logs.redacted_text` | `internal/store/sqlstore.go:554~`, `types.go:198` |
| 프롬프트 보관 | 기본은 `audit.Redact` 처리된 `redacted_text`만 저장(원문은 `LOG_RAW_PROMPTS`). 프롬프트 30일·요청 90일 보존 | `proxy/server.go:2939`, `config.go:463~472` |
| 코딩 작업 유형 | 키워드 기반 `classifyTaskType`(debug/test/refactor/translate/docs/review/explain/generate/other) — 요청 경로에서 동기 계산 | `proxy/tooling.go:278` |
| 프롬프트 지문 | `promptFingerprint`(작업 유형 + 핵심 키워드 해시) → 반복 프롬프트 묶음 | `tooling.go`, `store/prompt_fingerprint.go` |
| 복잡도·위험 | `analyzeComplexity`(simple/standard/complex/reasoning), `analyzeRisk` | `proxy/intelligent_routing.go` |
| 언어 추론 | `audit.InferLanguages` → `language_stats` | `internal/audit/language.go` |
| 세션 | 헤더·본문의 명시적 세션 ID → 없으면 `sessionInferer`(키·IP·UA·repo 기준 30분 유휴) `sess_…` → 추론 끄면 `trace:<id>` | `proxy/llm_observability.go:40`, `session_inferer.go` |
| 클라이언트 | `classifyAgent(user_agent)`(Claude Code, Cursor, Cline …) | `store/agent_analytics.go:38` |
| 조직 | `api_keys.team`·`user_id`, `requestTeamExpr`. 부서 계층·정원 정보는 없음 | `store/queries.go:17` |
| 일간 집계 | `analytics_daily`(all/model/provider/project/cost_center), 서울 날짜 기준 `seoulDayExpr` | `store/analytics_rollup.go`, `day_bucket.go` |
| 업무 지도 | `/admin/work-map`: 프로젝트·팀별 요약 + task_type 분포(조회 시 원본 스캔) | `store/work_map.go` |
| 증분 커서 | `(ingested_at, id)` 인덱스 `idx_request_logs_ingested_cursor` | `sqlstore.go:654`, `store/scatter.go:217` |
| 백그라운드 작업 | `AnomalyWorker`(Start/Stop), 임대 방식 작업 테이블(`clickhouse_sink_runs`) | `proxy/anomaly_worker.go`, `store/clickhouse_sink_runs.go` |
| 내부 LLM 호출 | `runGovernanceChat`/`postUpstreamChat`(합성 `*http.Request`로 Provider 선택 재사용) | `proxy/governance_runner.go:43` |
| 설정 | 자체 완결 모듈 패턴(`trackingSettingDefs`, `reloadTrackingRuntime`) — 재시작 없이 반영 | `proxy/tracking.go:48~122` |
| 권한·팀 범위 | `/admin/*` GET=admin:read·그 외 admin:write, `requestTeamScopeForCallerChecked`, `canViewRawPrompts`, `maskRecentRequests` | `proxy/server.go:2532`, `admin_request_readability.go:106`, `admin_roles.go` |
| 편집 충돌 보호 | 문서 1건 + `expected_revision` CAS(409) | `store/dlp.go:74` |
| 미리보기→확정 작업 | DW 재처리 검토(HMAC revision, 5분 만료, 단일 실행, 임대·진행률) | `proxy/clickhouse_retry_review.go` |
| 감사·CSV | `auditAdmin`, `csvTextCell`(수식 주입 방지), BOM·no-store | `server.go:2380`, `csv_text.go` |
| DLP 재검사 | `dlp.Engine.Redact`, `audit.Redact` | `internal/dlp/scan.go` |
| 콘솔 | StatCard/StatGrid, SectionCard, Tabs, DataTable(서버 페이지), `useSearchState`, `TimeSeriesChart`, `ScatterPlot`, 막대(`DwTrendPanel`), 표 히트맵 | `web/src/shared`, `features/observability/charts.tsx` |

## 2. Gap 분석

| 요구 | 현재 | Gap → 조치 |
| --- | --- | --- |
| 계층형 업무 분류 체계 | 코딩 작업 9종 고정 | 12개 대분류 + 중·소분류, 관리자 편집, 버전·이력 **신규** |
| 하이브리드 분류(규칙+LLM) | 동기 키워드 1종 | 요청 경로 밖 **비동기 분류 워커** 신규. 규칙은 기존 task_type·언어·MCP 도구·지문을 입력으로 재사용, LLM은 기본 꺼짐 |
| 분류 캐시 | 없음 | 지문·팀·정책 버전 키의 캐시 **신규** (임베딩 유사도는 후속 과제) |
| 업무 세션 | 세션 요약은 조회 시 계산 | 세션×업무 구간 집계 테이블 **신규**(명시/추론/trace 구분) |
| 업무별 일간·조직·모델 집계 | `analytics_daily`에 업무 차원 없음 | 업무 차원 일간 집계 **신규**(증분, 재생성 가능) |
| 대시보드 | DW 대시보드·work-map | 업무 활용 분석 화면 **신규**, 도넛·트리맵·누적 영역·히트맵·Sankey·버블 차트 신규(SVG 직접 구현) |
| 분류 관리 콘솔 | 없음 | 카테고리·규칙·정책 배포/롤백·검토·보정·재분류 **신규** |
| 트렌드·자동화 후보·인사이트 | 없음 | 집계 기반 주기 작업 **신규** (LLM 문장화는 선택) |
| 소수 집계 보호 | 없음 | 최소 그룹 크기 가림 **신규** |
| 조직 정원 | 없음 | 활성 사용자 수를 분모로 쓰고 의미를 화면에 명시 |
| 부서 계층 | 팀 1단계뿐 | 팀 단위로 제공(계층은 후속 과제) |

중복 방지: `/admin/work-map`과 `task_type`은 그대로 두고, 새 기능은 그 결과를 **입력**으로만 쓴다. 새 서비스·새 큐
인프라는 만들지 않는다(DB 커서 폴링).

## 3. 성능 원칙 (요청 경로 무변경)

- 프록시 요청 경로에는 **코드 한 줄도 추가하지 않는다.** 분류 워커는 `request_logs`를 `(ingested_at, id)` 커서로
  읽는 독립 고루틴이다. 워커·분류 모델이 죽어도 요청 처리와 SSE에는 영향이 없다.
- 워커는 주기(기본 15초)마다 최대 `batch`(기본 200)건을 한 트랜잭션으로 처리한다: 분류 결과 삽입 → 그 배치의
  증분만 집계 upsert → 커서 전진. 같은 트랜잭션이라 중복 집계가 없고 중단 후 그대로 재개된다.
- 다중 인스턴스: 상태 행의 임대(`worker_token`, `lease_until`)를 잡은 인스턴스만 처리한다.
- LLM 분류는 동시 실행·분당 호출 상한을 두고, 배치 트랜잭션 밖에서 호출한 뒤 결과만 반영한다. 한 주기에서 새 호출을
  시작하는 시간은 주기 길이로 제한하므로(이미 시작한 호출은 제한 시간까지 기다림) 느린 모델이 주기를 붙잡지 못한다.
  실패한 요청은 규칙 결과로 저장해 두고 1분·4분 뒤 다시 시도하며(최대 3회), 호출이 연속 5회 실패하면 1분간 호출을
  멈춘다. 멈춘 동안의 요청은 시도 횟수를 쓰지 않고 대기한다.
- 분류 대상은 생성 요청(`…completions`, `/responses`, `/messages`)뿐이다. 모델 목록·임베딩 요청은 커서만 지나간다.
- 대시보드는 집계 테이블만 읽는다. 원본 `request_logs` 전체 스캔 없음. 목록은 서버 페이지네이션.
- 보정·재분류는 해당 날짜의 집계를 `DELETE + INSERT … SELECT`로 재생성해 통계 불일치를 막는다. 분류를 바꾸는
  트랜잭션이 영향받은 날짜·세션을 `work_intel_dirty`에 함께 기록하고 재생성이 그 표시를 지우므로, 둘 사이에 프로세스가
  죽어도 다음 재생성(워커는 1분에 한 번)이 이어서 처리한다.
- 집계를 쓰는 모든 경로(배치 반영, 재할당, 재생성)는 먼저 `work_intel_state` 행을 잠근다. 여러 인스턴스에서도 서로
  끼어들지 않는다. 배치 반영은 커서가 읽은 값 그대로일 때만 성공한다(임대가 만료된 워커의 중복 반영 방지).

## 4. 데이터 모델

명명은 기존 규칙(snake_case, TEXT 시각 RFC3339Nano UTC, 날짜는 서울 기준 `YYYY-MM-DD`).

| 테이블 | 용도 | 키·주요 컬럼 |
| --- | --- | --- |
| `work_intel_policy` | 편집 중 정책 초안(문서 1건) | id='draft', config_json, revision, updated_by, updated_at |
| `work_intel_policy_versions` | 배포된 정책 스냅샷(분류 정책 버전) | version PK, config_json, note, published_by, published_at |
| `work_classifications` | 업무 분류 Fact(요청 1건=1행) | request_id PK, created_at, ingested_at, day, session_id, session_kind, team, user_key, api_key_id, model, provider, client, endpoint, category_id, top_category_id, action_type, difficulty, confidence, method, classifier_model, policy_version, status, tags, technologies, target_system, work_title, new_category_hint, language, fingerprint, tokens_in, tokens_out, cost_krw, latency_ms, is_error, is_retry, mcp_calls, tool_sig, policy_flags, needs_llm, llm_attempts, corrected_by, corrected_at, updated_at |
| `work_sessions` | 업무 세션 머리(세션×팀 = 1행, 세션 전체에 대한 사실) | (session_id, team) PK, session_kind, user_key, client, day, first_at, last_at, requests, mcp_calls, tokens_in, tokens_out, cost_krw, latency_ms, errors, retries, models, model_switches, last_model, last_fingerprint, last_error, last_ingested_at, policy_flags, positive_feedback, completion, category_counts, primary_category_id, primary_top_category_id, updated_at |
| `work_session_segments` | 업무 구간(세션×팀×업무×날짜) | (session_id, team, category_id, day) PK, top_category_id, user_key, client, first_at, last_at, requests, tokens_in, tokens_out, cost_krw, mcp_calls, errors, latency_ms |
| `work_daily` | 업무별·조직별·모델별 일간 집계 | (day, category_id, action_type, team, model, provider, client) PK, top_category_id, requests, tokens_in, tokens_out, cost_krw, mcp_calls, errors, retries, latency_ms, lat_b0…lat_b7, m_rule, m_llm, m_cache, m_manual, s_review, s_unclassified, s_failed, conf_b0…conf_b4 |
| `work_daily_users` | 고유 사용자 집합 | (day, category_id, team, user_key) PK, top_category_id |
| `work_class_cache` | 분류 캐시 | cache_key PK(정책 버전+팀+지문의 SHA-256), policy_version, team, category_id, action_type, confidence, status, tags, technologies, target_system, work_title, new_category_hint, classifier_model, hits, created_at, last_hit_at |
| `work_corrections` | 관리자 보정 이력(검증 데이터) | id PK, request_id, from_category_id, to_category_id, from_action, to_action, from_method, from_confidence, policy_version, actor, reason, created_at |
| `work_intel_jobs` | 재분류 작업(임대·진행률) | id PK, kind, status, actor, worker_token, lease_until, params_json, progress_json, error, created_at, updated_at, finished_at |
| `work_intel_state` | 워커 상태·커서 | id='classifier', cursor_ingested_at, cursor_id, worker_token, lease_until, stats_json, facts_purged_before, periodic_at, updated_at |
| `work_intel_dirty` | 재생성 대기(분류가 바뀐 날짜·세션) | (kind, ref) PK — kind는 `day`·`session`, marked_at |
| `work_automation_candidates` | 자동화 후보 | id PK(지문+업무), payload_json, review_status, review_note, reviewed_by, reviewed_at, computed_at |
| `work_insights` | 인사이트와 근거 | id PK, kind, severity, title, body, evidence_json, link_json, period_from, period_to, created_at |

- 이 테이블들의 시각은 `request_logs.ingested_at`과 같은 고정 폭 UTC 형식(`2006-01-02T15:04:05.000000000Z`)으로 쓴다.
  문자열 비교가 곧 시간순이라 MIN/MAX·범위 조건을 그대로 쓸 수 있다.
- **업무 세션 수**는 `work_session_segments`의 `COUNT(DISTINCT session_id)`다. 구간 키에 날짜가 들어 있어, 며칠에 걸친
  세션은 활동한 날마다 한 번씩 세고 기간 합계에서는 한 번만 센다(시작한 날에만 세면 오래 쓰는 세션이 추이에서 사라진다).
  세션 상세에서 업무별 구간을 보여 줄 때는 `category_id`로 묶어 합친다.
- 세션 ID는 클라이언트가 정하므로 두 팀이 같은 값을 쓸 수 있다. 머리와 구간의 키에 팀을 넣어, 한 행에 두 팀의 수치가
  섞이지 않게 한다(팀 범위 관리자에게 다른 팀 수치가 새지 않는다). 세션 ID가 비어 있는 요청은 세션 집계에 넣지 않는다.
- `team`은 API 키의 팀(없으면 `unassigned`), `user_key`는 키의 사용자(없으면 키 ID, 키도 없으면 `anonymous`),
  `client`는 User-Agent에서 얻은 클라이언트 이름이다.
- `is_error`는 상태 코드 400 이상. `is_retry`는 같은 세션의 직전 요청이 실패했고 프롬프트 지문이 같을 때다. Fact를
  넣을 때 한 번 정하며, 분류가 바뀌어도 그대로다.
- `mcp_calls`는 MCP 도구 호출 수(`tool_invocations`의 `source='call'`·`is_mcp=1`). 분류 특징에는 호출했거나 결과가
  돌아온 도구만 쓴다(선언만 된 도구는 제외). `tool_sig`는 호출한 도구 이름을 정렬해 이은 값이다.
- `policy_flags`: DLP가 걸렸으면 `dlp`, 비밀 방화벽이 비밀을 찾았으면 `secret`(쉼표로 이음).
- `needs_llm`·`llm_attempts`: 규칙으로 확정하지 못해 LLM을 기다리는 행과 실패한 시도 횟수.
- `category_counts`는 세션의 업무별 요청 수(JSON), `primary_category_id`는 그중 가장 많은 업무다.
- `work_sessions.day`는 세션이 시작한 날이다. 기간으로 세션 목록을 고를 때는 `last_at`·`first_at`으로 겹침을 본다.
- `session_kind`: `explicit`(클라이언트가 준 ID) / `inferred`(`sess_` 접두) / `trace`(`trace:` 접두).
- `status`: `classified` / `review`(낮은 신뢰도) / `unclassified` / `failed`(LLM 실패 후 규칙 결과도 없음). 대기는 커서 뒤의
  미처리 건수로 표현한다(별도 행 없음).
- `method`: `rule` / `llm` / `cache` / `manual`.
- `completion`: `unknown`(기본) / `ended_with_error`(마지막 요청 실패) / `confirmed`(긍정 피드백 존재). API 성공을 완료로 보지 않는다.
  피드백은 요청이 분류된 뒤에 들어오는 것이 보통이라, 워커가 1분에 한 번 새 긍정 피드백을 찾아 세션을 `confirmed`로 바꾼다.
- 지연 히스토그램 `lat_b*` 경계(ms): 500, 1000, 2000, 5000, 10000, 30000, 60000, 그 이상. P50/P95는 히스토그램에서 추정.
- 신뢰도 구간 `conf_b*`: <0.5, <0.6, <0.75, <0.9, ≥0.9.
- 보존: `work_classifications`·`work_corrections`는 요청과 함께 삭제(`PurgeOlderThan`). 내용이 없는 집계·세션은
  `WORK_INTEL_RETENTION_DAYS`(기본 400일)로 따로 정리.
- 요청 보존 기간이 지나 Fact가 지워진 날짜는 Fact로 다시 셀 수 없다. 지운 시점을 `facts_purged_before`에 적어 두고,
  그보다 앞에서 시작하는 날짜·세션의 재생성은 건너뛴다(이미 맞게 집계된 값을 남은 Fact만으로 줄이지 않는다).
- 카테고리 병합은 정책의 `merged_into`로 표현하고, 조회 시 대표 ID로 접어 합산한다(과거 행은 원래 ID와 정책 버전을 유지).

### 정책 문서(`config_json`)

```jsonc
{
  "categories": [{
    "id": "dev.codegen",            // 불변 slug. 대분류는 점 없음, 중분류 a.b, 소분류 a.b.c
    "parent_id": "dev",             // 대분류는 ""
    "name": "코드 생성", "description": "…", "examples": ["…"],
    "enabled": true, "merged_into": "",
    "rules": { "keywords": ["…"], "mcp_servers": ["…"], "mcp_tools": ["…"], "languages": ["go"],
               "task_types": ["generate"], "clients": ["Claude Code"], "weight": 1.0 }
  }],
  "action_types": [{ "id": "create", "name": "생성", "keywords": ["만들어", "create"] }],
  "thresholds": { "accept": 0.72, "review_below": 0.5, "min_evidence": 2, "min_group_size": 3 },
  "llm": { "system_prompt": "…", "max_input_chars": 1500 },
  "baselines": [{ "category_id": "dev", "manual_minutes": 60, "ai_minutes": 15, "hourly_cost_krw": 50000, "note": "…" }]
}
```

기본 대분류 ID: `dev`(소프트웨어 개발), `infra`(IT 인프라 운영), `itsm`(IT 서비스 운영), `security`(정보보호),
`data`(데이터 분석), `office`(일반 사무), `planning`(경영 및 기획), `support`(고객 지원), `knowledge`(지식 관리),
`ai`(AI 개발), `automation`(업무 자동화), `other`(기타 및 미분류). 작업 유형 ID: `read`(조회), `analyze`(분석),
`create`(생성), `modify`(수정), `delete`(삭제), `verify`(검증), `plan`(계획), `automate`(자동화), `unknown`.

## 5. 분류 엔진

1. **규칙**: 가린 최신 사용자 프롬프트(최대 1,500자) + task_type + 언어 + MCP 서버·도구 + 클라이언트 + 모델을 특징으로
   카테고리별 점수를 낸다. 키워드 1개만으로는 확정하지 않는다(`min_evidence`). 1·2위 대분류가 근접하면 복합 업무로
   보고 2위를 태그에 남긴 뒤 LLM 또는 검토 대상으로 넘긴다.
2. **캐시**: 규칙으로 확정되지 않으면 `정책 버전+팀+지문` 키로 이전 결과를 재사용한다. DLP·비밀 정책이 적용된 요청은 캐시하지 않는다.
3. **LLM**(기본 꺼짐): 별도 설정한 분류 모델에 등록된 카테고리 ID 목록과 가린 텍스트를 보내고, JSON 응답을 스키마로
   검증한다. 등록되지 않은 ID는 버리고 `other`로 처리하며 `new_category_hint`만 남긴다. 외부 Provider 전송은
   `WORK_INTEL_LLM_ALLOW_EXTERNAL`이 켜져 있을 때만 허용(기본은 사설망·루프백 주소의 Provider만).
4. **신뢰도 보정**: LLM의 자기보고 신뢰도는 그대로 쓰지 않는다. 관리자 보정 이력으로 구한 방식별 정확도(표본 30건 이상일 때)를
   곱해 보정한다.
5. **재검사**: `work_title`·태그는 `audit.Redact`와 DLP `Redact`로 다시 가린 뒤 저장한다.

## 6. 설정 (런타임, 재시작 불필요)

설정 화면의 키는 소문자 점 표기(`work_intel.classify_enabled`, `work_intel.llm_max_per_minute` …)이고 범주는
`업무 활용 분석`이다. 아래 이름은 같은 값의 환경 변수이며 관리자가 화면에서 바꾸기 전까지의 기본값을 정한다. 각 키의
설명에 환경 변수 이름이 들어 있어 `WORK_INTEL`로 검색하면 모두 나온다.

| 키 | 기본 | 설명 |
| --- | --- | --- |
| `WORK_INTEL_CLASSIFY_ENABLED` | true | 분류 엔진(워커) 사용 |
| `WORK_INTEL_ANALYTICS_ENABLED` | true | 분석 API·화면 사용 |
| `WORK_INTEL_INTERVAL` | 15s | 워커 주기 |
| `WORK_INTEL_BATCH_SIZE` | 200 | 주기당 최대 처리 건수(1~500). 묶음이 가득 차면 다음 주기를 기다리지 않고 바로 이어서 처리 |
| `WORK_INTEL_BACKFILL_DAYS` | 7 | 처음 켤 때 과거 며칠부터 분류할지 |
| `WORK_INTEL_LLM_ENABLED` | false | LLM 의미 분류 사용 |
| `WORK_INTEL_LLM_MODEL` / `_PROVIDER` | (없음) | 분류 모델·Provider(운영 모델과 분리) |
| `WORK_INTEL_LLM_ALLOW_EXTERNAL` | false | 외부 Provider로 분류 텍스트 전송 허용 |
| `WORK_INTEL_LLM_CONCURRENCY` / `_MAX_PER_MINUTE` / `_TIMEOUT` | 2 / 60 / 20s | LLM 호출 제한 |
| `WORK_INTEL_INSIGHT_ENABLED` / `_INTERVAL` | true / 6h | 트렌드·자동화 후보·인사이트 주기 작업 |
| `WORK_INTEL_INSIGHT_LLM_ENABLED` | false | 인사이트 문장을 LLM으로 다듬기(집계 수치만 전달) |
| `WORK_INTEL_RETENTION_DAYS` | 400 | 집계·세션 보존 |

## 7. API 계약 (`/admin/work-intel/*`)

권한: GET은 `admin:read`, 변경은 `admin:write`(기존 규칙). 팀 범위 관리자는 자기 팀만(`requestTeamScopeForCallerChecked`).
원문 열람 권한이 없는 호출자에게는 사용자 식별자를 가명으로 바꾸고, 고유 사용자 수가 `min_group_size` 미만인 묶음은
모든 지표를 `null`로 내리고 `suppressed: true`를 붙인다(자세한 규칙은 아래 "구현에서 정해진 세부 사항"). 모든 변경은
`auditAdmin`으로 기록한다.

### 공통 조회 매개변수(분석)

`from`, `to`(서울 날짜 `YYYY-MM-DD`, 기본 최근 30일), `compare`(`prev`|`none`, 기본 `prev`), `team`, `user`, `category`
(어느 단계든), `action`, `model`, `provider`, `client`, `tool`, `status`, `metric`
(`sessions`|`requests`|`users`|`tokens`|`cost`|`mcp_calls`, 기본 `sessions`), `limit`, `offset`.

모든 분석 응답에 포함:

```ts
scope: { from: string; to: string; prev_from: string; prev_to: string; team_scoped: boolean;
         min_group_size: number; data_through: string; backlog: number; classify_enabled: boolean; policy_version: number }
type Metrics = { sessions: number | null; requests: number | null; users: number | null; tokens: number | null;
                 cost_krw: number | null; mcp_calls: number | null; suppressed: boolean }  // 가리면 여섯 값이 함께 null
type CategoryRef = { id: string; name: string; level: number; parent_id: string; top_id: string; enabled: boolean }
```

| 메서드·경로 | 응답 |
| --- | --- |
| `GET /overview` | `{ scope, current: Metrics & { teams: number; active_categories: number; classified_rate: number; new_categories: number; automation_candidates: number }, previous: 같은 형태 \| null, growth_rate: number \| null, confidence: { bucket: string; requests: number }[], methods: { method: string; requests: number }[], statuses: { status: string; requests: number }[] }` |
| `GET /categories?parent=<id>` | `{ scope, parent: CategoryRef \| null, rows: { category: CategoryRef; current: Metrics; previous: Metrics \| null; share: number; delta: number \| null; has_children: boolean; suppressed: boolean }[], unclassified: Metrics, failed: Metrics, total: Metrics }` — parent 없으면 대분류 |
| `GET /trend?bucket=day\|week&top=8` | `{ scope, buckets: string[], series: { category: CategoryRef; values: number[] }[], other: number[], total: number[] }` (metric 기준) |
| `GET /matrix?top=12` | `{ scope, categories: CategoryRef[], rows: { team: string; total: Metrics; cells: { category_id: string; value: number \| null; users: number \| null; suppressed: boolean }[] }[] }` (metric 기준, 조직×업무 히트맵) |
| `GET /flow?top=6` | `{ scope, nodes: { id: string; kind: "team"\|"category"\|"model"; name: string; value: number }[], links: { source: string; target: string; value: number }[] }` |
| `GET /teams` | `{ scope, rows: { team: string; current: Metrics; previous: Metrics \| null; sessions_per_user: number \| null; diversity: number; top_categories: { category: CategoryRef; value: number; share: number }[]; rising: { category: CategoryRef; delta: number }[]; deviation: { category: CategoryRef; team_share: number; overall_share: number }[]; suppressed: boolean }[], denominators: "active_users" }` |
| `GET /models` | `{ scope, rows: { category: CategoryRef; model: string; provider: string; requests: number; sessions: number; share: number; tokens_per_session: number; cost_per_session: number; latency_p50_ms: number; latency_p95_ms: number; error_rate: number; retry_rate: number; model_switch_rate: number; feedback_positive: number; feedback_negative: number; low_sample: boolean }[], suggestions: { category: CategoryRef; from_model: string; to_model: string; basis: string; sample: number; est_saving_krw: number }[] }` |
| `GET /trends` | `{ scope, signals: { kind: "rising_7d"\|"rising_30d"\|"new"\|"declining"\|"cost_spike"\|"model_dependence"\|"team_concentrated"\|"spreading"; category: CategoryRef; team: string; model: string; current: number; previous: number; change_abs: number; change_rate: number \| null; users_current: number \| null; users_previous: number \| null; sample: number; note: string }[], thresholds: { min_sample: number; min_change_abs: number; min_change_rate: number } }` |
| `GET /automation?status=` | `{ scope, rows: { id: string; title: string; category: CategoryRef; teams: string[]; repeats: number; users: number \| null; sessions: number; cost_krw: number; avg_latency_ms: number; recommended: "prompt_template"\|"skill"\|"mcp_tool"\|"workflow"\|"agent"\|"batch"; feasibility: number; mcp_tools: string[]; risk: "low"\|"medium"\|"high"; needs_approval: boolean; effect: { basis: string; est_minutes_saved: number \| null; est_cost_saved_krw: number \| null }; review_status: "new"\|"reviewing"\|"accepted"\|"dismissed"; computed_at: string }[], count: number }` |
| `POST /automation/{id}/review` | 본문 `{ review_status, note }` → 갱신된 행. 자동 등록·실행은 하지 않는다 |
| `GET /insights` | `{ scope, rows: { id: string; kind: string; severity: "info"\|"notice"\|"warning"; title: string; body: string; evidence: { period: string; compare: string; sample: number; metrics: Record<string, number> }; link: Record<string, string>; created_at: string }[], generated_at: string, llm_used: boolean }` |
| `POST /insights/run` | `{ generated: number, generated_at: string }` |
| `GET /sessions?sort=&session_status=` | `{ scope, rows: { session_id: string; session_kind: string; team: string; user: string; client: string; primary: CategoryRef; secondary: CategoryRef[]; first_at: string; last_at: string; requests: number; mcp_calls: number; tokens_in: number; tokens_out: number; cost_krw: number; duration_ms: number; model_time_ms: number; errors: number; retries: number; models: string[]; model_switches: number; policy_flags: string[]; completion: string }[], count: number, limit: number, offset: number }` |
| `GET /sessions/{id}` | `{ session: 위 행, segments: { category: CategoryRef; requests: number; cost_krw: number; first_at: string; last_at: string }[], requests: 요청 행[] (최대 200) }` |
| `GET /requests?min_conf=&max_conf=&method=` | `{ scope, rows: { request_id: string; created_at: string; session_id: string; team: string; user: string; client: string; model: string; category: CategoryRef; action_type: string; confidence: number; method: string; status: string; work_title: string; tags: string[]; technologies: string[]; tokens: number; cost_krw: number; latency_ms: number; is_error: boolean; policy_version: number }[], count: number, limit: number, offset: number }` |
| `GET /productivity` | `{ scope, rows: { category: CategoryRef; sessions: number; confirmed_sessions: number; model_time_ms: number; baseline: { manual_minutes: number; ai_minutes: number; hourly_cost_krw: number } \| null; est_minutes_saved: number \| null; est_cost_saved_krw: number \| null; reason: string }[] }` — 기준값·완료 근거가 없으면 추정치는 `null` |
| `GET /export.csv?view=categories\|teams\|models\|sessions\|requests` | CSV(BOM, no-store, 수식 주입 방지, 팀 범위·가림 적용, 감사 기록) |
| `GET /status` | `{ classify_enabled, analytics_enabled, llm_enabled, llm_model, llm_external_allowed, policy_version, cursor_at, lag_seconds, backlog, last_run_at, last_error, processed_total, processed_24h, by_method: Record<string, number>, failures_24h, llm_calls_24h, llm_tokens_24h, llm_cost_krw_24h, cache_hits_24h, worker_active }` |

### 분류 관리

| 메서드·경로 | 설명 |
| --- | --- |
| `GET /policy` | `{ config, revision, updated_by, updated_at, published_version, published_at, dirty: boolean, defaults: { action_types, thresholds } }` |
| `PUT /policy` | 본문 `{ config, expected_revision, reason }` → 저장된 초안. `409 work_policy_conflict`, `422 work_policy_invalid` + `issues[{path,message}]` |
| `GET /policy/versions` | `{ versions: { version, note, published_by, published_at, categories: number, changes: { added: string[]; removed: string[]; renamed: string[]; merged: string[]; rules_changed: string[] } }[] }` |
| `GET /policy/versions/{version}` | `{ version, config, note, published_by, published_at }` |
| `POST /policy/publish` | 본문 `{ expected_revision, note }` → `{ version, published_at, impact: { categories_removed: number; affected_requests: number } }` |
| `POST /policy/rollback` | 본문 `{ version, note }` → 그 버전 내용을 새 버전으로 배포하고 초안에도 반영 |
| `POST /policy/test` | 본문 `{ text, task_type?, languages?, mcp_tools?, client?, model?, use_draft: boolean, use_llm: boolean }` → `{ result: 분류 결과, candidates: { category: CategoryRef; score: number; evidence: string[] }[], llm: { used: boolean; error: string } }` |
| `POST /policy/evaluate` | 본문 `{ use_draft: boolean, limit }` → `{ sample: number, accuracy: number \| null, top_accuracy: number \| null, by_category: { category: CategoryRef; total: number; correct: number }[], confusions: { expected: string; got: string; count: number }[], note: string }` (보정 이력을 정답으로 사용) |
| `GET /review?status=&category=&max_conf=` | 요청 행 목록(위 `/requests`와 같은 행) + `count`, `limit`, `offset`, `summary: { review, unclassified, failed, new_category_hints: { hint: string; count: number }[] }` |
| `POST /review/correct` | 본문 `{ request_ids: string[] (≤500), category_id, action_type?, reason }` → `{ corrected: number, days_rebuilt: string[] }` |
| `GET /reclassify?from=&to=&status=&category=&method=` | 미리보기 `{ revision, reviewed_at, expires_at, total: number, by_status: Record<string, number>, by_method: Record<string, number>, manual_kept: number, est_llm_calls: number, days: number, active_job: 작업 \| null }` |
| `POST /reclassify?reviewed=1` | 본문 `{ revision, reviewed_at, reason }` → 작업. `409 work_reclassify_expired`·`work_reclassify_conflict`·`work_job_active` |
| `GET /reclassify/jobs/{id}` | `{ id, status: "queued"\|"running"\|"succeeded"\|"failed"\|"interrupted", actor, created_at, updated_at, progress: { total, done, changed, failed, days_rebuilt, cursor } }` |
| `POST /rebuild` | 본문 `{ from, to, reason }` → 그 기간 집계를 분류 Fact에서 다시 만든다(불일치 복구용) |

### 구현에서 정해진 세부 사항

위 표에 더해 구현이 정한 동작이다. 콘솔 스키마는 추가 키를 허용(`looseObject`)하므로 아래 추가 키는 호환된다.

- **권한**: `POST /policy/test`, `/policy/evaluate`도 `admin:write`다. 팀 범위 관리자는 조직 전체에 영향을 주는 정책
  저장·배포·되돌리기, `/rebuild`, `/insights/run`에서 `403`을 받는다. 그 밖의 오류 코드: `403 work_intel_team_forbidden`
  (자기 팀 밖의 `team`), `403 work_intel_user_filter_forbidden`(원문 열람 권한 없이 `user` 필터), `403 work_job_denied`
  (남의 작업 조회), `409 work_reclassify_empty`, `400 work_reclassify_review_required`, `422 work_action_unknown`,
  알 수 없는 세션·작업·버전·후보는 `404`.
- **재분류 `revision`**: `<base64url 선택 조건>.<HMAC 64자>`. 확인 요청 본문에 조건이 없으므로 선택 조건이 revision 안에
  실려 가고, 서버 비밀값으로 서명해 위조·다른 조건 재사용을 막는다. 콘솔에는 불투명한 문자열이다.
- **프롬프트 텍스트가 지워진 요청**(프롬프트 보존 기간 경과): 재분류해도 기존 분류를 유지한다. 이미 `unclassified`·
  `failed`인 행만 메타데이터 규칙으로 다시 보고, 분류 모델에는 보내지 않는다. 미리보기 `no_text_kept`, 작업
  `progress.kept_no_text`로 센다. `/policy/evaluate`는 텍스트가 남은 보정만 쓰고 건너뛴 수를 `skipped_no_text`로 준다.
  분류 모델이 분류했던 행은 규칙이 확정하지 못하고 지금 모델을 부를 수 없으면 그대로 둔다(강등하지 않음).
- **추가 키**: 작업 `progress.cursor`·`error`, 보정 `skipped`, 재집계 `sessions_rebuilt`, `insights/run`의
  `candidates`·`llm_used`.
- **`/categories`**: 행은 분류됨·검토 상태 요청만 담아 행 합 + `unclassified` + `failed` = `total`(가산 지표). 이전 기간에만
  쓰인 카테고리는 0으로 남는다. 상위 카테고리 자체로 분류된 요청은 상위 ID와 "(세부 분류 없음)" 이름의 행으로 보인다.
- **`/flow`**: 지표가 세션·사용자면 업무→모델 링크는 그 업무의 값을 모델별 요청 비중으로 나눈다(세션 집계에 모델이
  없음). 노드 값은 링크 합이다.
- **소수 집단 보호**(`work_intel_guard.go`): 원문 열람 권한이 없는 호출자에게, 고유 사용자 1~(k-1)명인 묶음은 통째로 가린다.
  `Metrics`의 여섯 지표를 모두 `null`로 내리고 `suppressed: true`를 붙이며, 그 묶음에서 나온 비중·증감·비율·다양성도
  `null`이다. 형제 항목과 그 합계(다른 엔드포인트에서 보이는 조직 합계 포함)를 한 "줄"로 보고, 줄에 작은 항목이
  있으면 가린 항목 중에 사용자 k명 이상인 묶음이 들어 있거나 합계가 가려졌을 때만 끝난 것으로 본다. 아니면 보이는
  항목을 하나 더 가린다(안정될 때까지 반복). 추가로 가릴 항목은 지표 선택과 무관하게 사용자 수 → 요청 수 → ID가
  작은 순으로 고른다. 가린 행은 크기가 드러나지 않도록 보이는 행 뒤에 ID 순으로 둔다. 범위 전체가 작으면(예: 한
  사람뿐인 팀으로 거른 경우) 어떤 업무·모델을 썼는지도 드러나지 않게 행을 비우고 `suppressed: true`를 준다
  (`/categories`는 빈 `rows`와 가린 합계, `/trend`·`/flow`·`/models`·`/productivity`는 최상위 `suppressed`). 작은 팀의
  히트맵 행은 0인 칸까지 모두 가린다. `/overview`의 `statuses`·`methods`·`confidence` 분포는 이런 호출자에게 늘 빈
  배열이고, `scope.small_groups_withheld: true`로 알린다. 자동화 후보는 k명 미만인 팀 몫을 `teams`와 합계에서 빼고
  남은 팀 몫만 더하며, 다른 팀·모델 가운데 k명 미만인 곳이 있으면 집중·의존·모델 구성 신호와 인사이트를 내지 않는다. 엔드포인트별: `/categories`는 행+미분류+실패 대 합계(두 기간),
  `/teams`·`/matrix`는 팀×업무 격자(행·열·조직 합계 줄, 작은 업무는 히트맵 열에서 뺌), `/trend`는 구간별·계열별(작은
  업무는 계열 없이 `other`), `/flow`는 작은 팀·업무·모델을 열마다 `기타` 노드로 접고 작은 링크는 빼며 `suppressed_links`로
  센다, `/models`·`/productivity` 행은 `suppressed`, `/overview`는 작은 기간을 통째로 가린다(`classified_rate`·
  `active_categories`·`new_categories` null, 분포 배열은 빈 배열, 두 기간 중 하나라도 가리면 `growth_rate` null).
  인구가 k 미만인 신호·인사이트·자동화 후보는 빼고, 이런 호출자에게는 저장된 생성 결과 대신 즉석 계산한 인사이트만
  준다(`llm_used: false`). CSV는 JSON에서 `null`인 칸을 비운다(`models` 보기에는 `suppressed` 열 추가).
- **계약 변경**: `Metrics`의 여섯 지표는 모두 `number | null`(함께 null)과 `suppressed: boolean`. `/categories`의 `share`,
  `/teams`의 `diversity`는 `number | null`이고 가린 항목은 `top_categories`·`rising`·`deviation`에서 빠진다. `/trend`의
  `values`·`other`·`total`은 `(number | null)[]`. 흐름 노드 값은 보이는 링크의 합이다.
- **목록과 프롬프트 파생 텍스트**: 원문 열람 권한이 없는 호출자에게는 요청·검토·세션 상세의 `work_title`을 빈 문자열,
  `tags`·`technologies`를 빈 배열로, `/review`의 `new_category_hints`를 빈 배열로 준다(모두 프롬프트에서 뽑은 텍스트).
  세션·요청 목록 자체는 기존 요청 탐색기와 같은 범위로 보인다. 이 역할들은 요청 탐색기에서 개별 요청(가린 프롬프트
  포함)을 이미 열 수 있으므로, 소수 집단 보호는 접근 경계가 아니라 집계 화면이 소수의 업무 내역을 드러내지 않게 하는
  장치다. 보장하는 범위는 "한 응답, 또는 같은 엔드포인트를 두 번 읽은 값의 뺄셈으로 k명 미만 묶음의 수치를 얻을 수
  없다"까지다. 여러 엔드포인트·필터(`parent`·`bucket`·`top` 바꾸기, 보완으로 가린 칸을 필터로 다시 읽기, 행·열 합을
  연립해 풀기)의 값을 모아 푸는 추론은 막지 않는다(독립 리뷰의 선형 연립 스윕에서 재현됨). 가릴 칸을 정하려고 고유
  사용자 수를 더 세므로, 원문 열람 권한이 없는 호출자에게는 `/flow`·`/trend`가 분류 5만 건에서 약 90ms, `/models`
  (60일, PostgreSQL)가 약 270ms로 늘어난다.
- **가명 키**: 게이트웨이 비밀값이 기본값이 아니면 그 값, 아니면 기본값이 아닌 JWT 비밀값으로 HMAC을 만든다. 둘 다
  기본값이면 사용자 표시를 빈 문자열로 내리고, 가명 필터는 아무것도 고르지 않는다.
- **목록 `offset`** 은 100,000까지다. 넘으면 `400 work_intel_offset_too_large`.
- **세션 경로**: `/admin/work-intel/sessions/`는 ServeMux가 경로를 정리(`..`·`//`)하기 전에 받아 이스케이프된 경로를
  `url.PathUnescape`로 풀어 쓴다(`team/one` 같은 ID도 `%2F`로 조회).
- **자동화 후보 검토**: 팀 범위 관리자는 후보에 걸린 팀이 모두 자기 범위일 때만 검토 상태를 바꾼다(아니면
  `403 work_intel_team_forbidden`). 팀 범위 보기는 도구·행위·시간대·점수를 자기 팀 것만으로 다시 계산한다.
- **분류 모델 호출**: 분류·인사이트 다듬기 호출은 리디렉션을 따르지 않는 클라이언트를 쓴다(내부 Provider 확인 우회
  방지). 분당 호출 예산은 워커·재분류 작업·`/policy/test`가 함께 쓰며, 다 쓰면 `/policy/test`는 규칙 결과와
  `llm.code: "llm_budget_exhausted"`를 준다. 인사이트 다듬기 결과는 원래 제목·본문과 숫자가 같은 순서로 모두 같아야
  받아들인다.
- **재분류 확인**: revision은 요청자·선택 조건·`reviewed_at`·정책 버전·팀 범위를 서명한다(건수는 서명하지 않음). 미리보기
  뒤 워커가 건드린 행은 작업에서 빼고, 미리보기 건수는 `progress.previewed`로 남긴다. `409 work_reclassify_conflict`는
  정책·요청자·선택 조건이 달라진 경우다. 텍스트 없는 행 확인은 미리보기에서만 최대 50,000건까지 세고, 상한에 걸리면
  `no_text_capped: true`(하한값)를 준다.
- **`/insights`**: 팀 범위 호출자이거나 `team`·`category` 필터가 있으면 즉석 계산하고, 필터 없는 조직 전체 조회만
  저장된 생성 결과를 쓴다. `/trends`는 항상 즉석 계산이다. `previous.automation_candidates`는 이력이 없어 현재 값과 같다.
- **문서화하지 않은 선택 매개변수**: `GET /sessions/{id}?team=`(같은 ID를 두 팀이 쓸 때), `GET /review?from=&to=`(기본 최근
  30일), `/export.csv`의 `parent`·`sort`·`session_status`. 알 수 없는 `category` 필터는 `other`로 바꾸지 않고 아무것도
  고르지 않는다. 목록 `count`는 100,000에서 멈춘다.

## 8. 콘솔

- 새 그룹 **업무 활용 분석**: `insights.usage` → `/app/insights/usage`(admin:read), `insights.classification` →
  `/app/insights/classification`(admin:read, 변경은 admin:write).
- `업무 활용 분석` 탭: 요약 / 업무 유형 / 조직 / 모델 / 트렌드·자동화 / 세션·요청 / 생산성. 요약 탭은 요구된 순서
  (요약 지표 → 업무 비중 → 증감 추이 → 조직 히트맵 → 모델·비용 → 신규·급증 → 자동화 후보 → 인사이트).
- 공통 필터 막대(기간·비교·팀·업무·작업 유형·모델·클라이언트·지표)는 URL과 동기화한다.
- 차트는 SVG 직접 구현(도넛, 트리맵, 누적 영역, Sankey, 버블) + 기존 시계열·막대·표 히트맵 재사용. 모든 차트는
  `표로 보기`를 제공하고 클릭하면 하위 단계나 상세 목록으로 이동한다.
- `업무 분류 관리` 탭: 상태 / 카테고리 / 정책·버전 / 테스트 / 검토 / 재분류 / 기준값.

## 9. 관측

`/metrics`에 추가: `proxy_work_intel_processed_total{method}`, `proxy_work_intel_failures_total`,
`proxy_work_intel_llm_calls_total`, `proxy_work_intel_cache_hits_total`, `proxy_work_intel_backlog`,
`proxy_work_intel_lag_seconds`, `proxy_work_intel_batch_seconds_sum`/`_count`.

카운터는 워커 임대를 가진 인스턴스에서만 오른다(나머지는 0). 미처리 건수와 지연은 모든 인스턴스가 주기마다 직접 세어
보고하며, `/metrics` 요청이 DB를 읽지는 않는다. 미처리 건수는 100,000에서 멈춘다. `/status`는 워커가 주기마다
`work_intel_state.stats_json`에 남기는 통계(누계와 최근 25시간의 시간대별 값)를 읽으므로 어느 인스턴스에서나 같다.

## 10. 제한과 후속 과제

- 임베딩 기반 유사 분류는 넣지 않았다(지문 기반 캐시만). 부서 계층·정원 연동, 세션 내 시간순 구간 분할(현재는
  세션×업무×날짜 단위), 분류 모델 비용의 정밀 추적은 후속 과제다.
