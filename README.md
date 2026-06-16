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
- **Text2SQL 백로그 완결** (`v0.3.3`): preview 결과 캐시(스키마 버전 키 + TTL), 스키마 버전 관리(지문 기반 자동 증가), 민감도 세분화(`approval_required`/`aggregate_only`), 실행 샌드박스(read-only tx + statement_timeout·work_mem), 자연어 재질문(clarification), 비용·품질 기반 업스트림 자동 승격, 관리자 위험 요청 큐(`/admin/text2sql/risk-queue`), 업무 용어 사전(`/admin/text2sql/glossary`)
- **재현성·권한 안전성·DW 신뢰성** (`v0.3.4`): Text2SQL 로그에 재현성 필드(`schema_name`·`schema_version`·`permission_hash`·`glossary_hash`) — 사후에 당시 스키마·권한·용어사전 상태로 SQL 생성 근거 재현. preview 캐시 키에 권한·용어사전 해시 포함 → 권한이 다른 사용자 간 SQL 재사용 방지. ClickHouse Sink에 dimension별 watermark + 실패 재처리 큐 — 실패가 유실되지 않고 `/admin/dw/sink-retry`(수동)·다음 주기(자동)로 복구, `/admin/dw/sink-status` 로 진행 상태 조회
- **검증 정확도·결과 보호·모델 품질 평가** (`v0.3.5`): 컬럼 민감도(`mask`) 기반 컬럼 단위 결과 마스킹, 검증기 in-tree 구조 검증(괄호·따옴표 균형 → 잘린 SQL 차단), 실행 DB read-only 헬스체크(`/admin/text2sql/healthcheck`), Golden Query 결과 동등성 평가(`/admin/text2sql/golden/run?execute=1`), shadow 모델 평가(`TEXT2SQL_SHADOW_MODELS`·`TEXT2SQL_SHADOW_SAMPLE_RATE`)
- **shadow 정책 일치·집계 검증 정확도** (`v0.3.6`): shadow 평가가 live와 동일한 검증 정책(allowlist·blocked·aggregate-only) 적용 → 모델 품질 지표 일관성, aggregate-only 판정을 중첩 괄호 균형 기반으로 고도화(`sum(coalesce(col,0))` 허용, window `OVER(PARTITION BY col)` 원시 참조 차단)
- **운영 가시성·재현성 확장** (`v0.3.7`): 업무 용어 사전 충돌 탐지(동일 용어 복수 매핑·전역/스키마 shadowing 경고), 위험 요청 큐 자동 개선 제안(기간 조건·집계 변경·민감 컬럼 제외·LIMIT 축소), 스키마 변경 영향도 리포트(`/admin/text2sql/schema-impact`), Replay Bundle(opt-in `TEXT2SQL_REPLAY_BUNDLES` → `/admin/text2sql/replay`)
- **민감도 API 보완·DW 점검·비용 분리** (`v0.3.8`): 컬럼 민감도 API가 `aggregate_only`·`approval_required` 허용(UI 드롭다운과 불일치 수정), Golden 결과 동등성 검증을 실행 DB 있을 때 기본 적용(`?execute=0`로 해제), ClickHouse 정합성 dimension별(all·model·provider·project·cost_center) 확대, 테이블 엔진/정렬키 점검(`/admin/dw/table-info`), Text2SQL 비용 generation/summary/shadow 분리, Replay Bundle 보존(GC)·secret 마스킹
- **답변 근거 표시·Kill Switch** (`v0.3.9`): Text2SQL 응답에 답변 근거 섹션(사용한 테이블 + WHERE 적용 조건), 런타임 Kill Switch(`/admin/text2sql/kill-switch` — 재배포 없이 Text2SQL 즉시 중지, 가상 모델은 안전 메시지 반환)
- **인사이트 마이너** (`v0.4.0`): 질문 로그 기반 read-only 마이너(`/admin/text2sql/miners`) — Report Candidate Miner(반복 질문 → 리포트 후보 추천), Glossary Miner(빈출 토큰 → 업무 용어 사전 후보 추출, 스톱워드·기존 정의어 제외)
- **행동 이상 탐지(탐지 전용)** (`v0.4.1`): 차단 없이 가시성만 제공하는 read-only 탐지(`/admin/text2sql/anomalies`) — AI Smell Detector(반복 질문·권한 우회성 거부 반복·스키마 전체 요청), 누적 위험 노출(팀별 가중 집계), Intent Drift Detector(조회→위험 키워드 이동)
- **기능 토글 + Self Challenge·Gateway Memory** (`v0.4.2`): 관리자 런타임 온오프 토글(`/admin/text2sql/features` + 어드민 UI 스위치, kill-switch 동일 패널). Self Challenge Proxy(보조 모델이 생성 SQL 검토 — preview 의견 첨부, execute unsafe 시 실행 보류; 기본 OFF), Gateway Memory(자주 쓰는 테이블 프롬프트 힌트; 기본 OFF)
- **Prompt DNA + 누적 위험 enforce** (`v0.4.3`): Prompt DNA(`/admin/text2sql/prompt-dna` — 질문 지문별 빈도·distinct 사용자·평균비용·거부율 + repeated/high_cost/risky 라벨), 누적 위험 한도 enforce 토글(`cumulative_risk_enforce` + `TEXT2SQL_DAILY_RISK_LIMIT` — API Key 당일 위험 요청이 한도 초과 시 차단; 탐지→차단 강제, 기본 OFF)
- **질문 자산화 + 위험 단계화** (`v0.4.4`): 반복 질문 원클릭 승격(`/admin/text2sql/promote` — report/golden/glossary; 저장 리포트 `/admin/text2sql/reports`). 누적 위험 단계화(감지 < `TEXT2SQL_DAILY_RISK_WARN` ≤ 경고 < `TEXT2SQL_DAILY_RISK_LIMIT` ≤ 차단) — 경고 구간은 주의 문구만 첨부하고 정상 처리
- **응답 품질 강화** (`v0.4.5`): 검증 통과 응답에 감사 근거 푸터(스키마·버전·권한/용어 지문·EXPLAIN 위험·마스킹 컬럼), 검증 거부 시 수정 방법 안내, 실행 결과 0행 시 복구 제안 자동 첨부
- **ClickHouse Text2SQL fact 적재** (`v0.4.6`): 일별 rollup에 더해 질의 단위 fact 테이블 적재(`CLICKHOUSE_TEXT2SQL_FACT_TABLE`) — 질문/SQL 원문 제외(마스킹), watermark 증분 + 자동/수동(`/admin/dw/text2sql-fact`)
- **정책 GitOps** (`v0.4.7`): 거버넌스 정책+룰 portable JSON 내보내기(`GET /admin/policies/export`)·가져오기(`POST /admin/policies/import`, `?dry_run=1`이면 생성/수정 플랜만) — repo 커밋·PR 리뷰·diff·롤백
- **저장 리포트 스케줄 실행** (`v0.4.8`): 승격된 리포트에 스케줄(`POST /admin/text2sql/reports {id,interval,enabled,deliver_mattermost}`) — 백그라운드 스케줄러가 도래분을 read-only 실행하고 Mattermost로 결과 요약 전달(실행 DB 설정 시)
- **Text2SQL 관측 메트릭** (`v0.4.9`): `/metrics`에 `proxy_text2sql_requests_total`·`_cache_hits_total`·`_risk_blocked_total`·`_challenge_veto_total`·`_shadow_evals_total` 추가
- **어드민 UI 통합** (`v0.5.0`): Text2SQL 탭에 저장 리포트(스케줄)·인사이트 마이너(원클릭 리포트 승격)·행동 이상 탐지 섹션 노출 — API 전용 기능을 운영자 화면으로
- **시맨틱 chat 캐시** (`v0.5.1`): 정확 캐시 miss 시 프롬프트 임베딩 코사인 유사도로 근사 응답 재사용(opt-in `CACHE_CHAT_SEMANTIC_ENABLED`+`CACHE_CHAT_SEMANTIC_MODEL`) — 임베딩 실패 시 정상 업스트림 폴백
- **데이터 상품 추천** (`v0.5.2`): 반복 질문(report candidate)에 SQL 형태 기반 추천 산출물(dashboard/data_mart/api) 분류 — 어드민 인사이트 표에 노출
- **사내 AI 신용점수** (`v0.5.3`): subject(API Key·project·model 등)별 신뢰도(성공률)+비용효율 블렌드 점수(`/admin/ai-credit-score`) — read-only
- **SQL Digital Twin** (`v0.5.4`): Golden 결과 동등성 검증을 운영 DB 대신 마스킹·샘플 트윈 DB에서 실행하는 opt-in 경로(`TEXT2SQL_TWIN_DSN`) — 미설정 시 execute DB 폴백(동작 변화 없음)
- **Prompt Carbon Score** (`v0.5.5`): 토큰 사용량 기반 요청 전력(Wh)·탄소(gCO2e) 추정(`/admin/carbon-score`) — 모델별 에너지 계수·PUE·그리드 강도 모두 설정값, 주체 간 상대 비교용 read-only 신호
- **AI 업무지도 (Work Map)** (`v0.5.6`): work 차원(project/repo/team 등)별 요청·토큰·비용·distinct 사용자/모델·오류율·대표 모델·task_type 분포를 모은 통합 뷰(`/admin/work-map`) — 어떤 AI 업무가 어디서 일어나는지 read-only 집계
- **Golden Workflow** (`v0.5.7`): 정렬된 골든 스텝들을 하나의 회귀 단위로 묶는 1급 엔터티(`/admin/golden-workflows` CRUD, `/admin/golden-workflows/run`) — 스텝별 통과/점수 + 전체 pass_rate, `?fail_on_regression=1`+`min_pass_rate`로 CI 게이트(스텝 간 체이닝 없음)
- **Prompt to Product** (`v0.5.8`): 반복되는 프롬프트 지문을 재사용 가능한 명명된 템플릿(제품)으로 승격하는 루프(`/admin/prompt-products` + `/candidates`) — 후보 발굴(빈도·비용·모델·제품화 여부)→승격(정식 템플릿 생성 + 출처/ reach 스냅샷)→채택도 추적
- **AI 요청 보험 모드** (`v0.5.9`): scope별 요청(covered) 대비 저하 결과(4xx/5xx/failover/error=claim)를 SLA 목표와 비교하는 read-only 원장(`/admin/insurance/claims`) — claim_rate·허용치 대비 초과 claim·sla_met, `INSURANCE_SLA_TARGET`(기본 0.99)/`?sla=`
- **절감 리포트 (Savings Report)** (`v0.6.0`): scope별 비용 절감 정량화(`/admin/savings`) — 라우팅 다운시프트 절감(요청 모델 가격 baseline−실제 비용, 정확) + 캐시 절감(적중×비캐시 평균, 추정)을 합산해 게이트웨이 ROI를 숫자로 표시
- **에러버짓 번레이트** (`v0.6.1`): SLA claim 위에 멀티윈도우 에러버짓 소진율(`/admin/insurance/burn-rate`) — short/long 윈도우 burn rate(claim_rate÷허용치)로 fast(page)/slow(ticket) 분류 + 30일 버짓 소진 일수 투영, `INSURANCE_FAST_BURN`/`INSURANCE_SLOW_BURN`
- **모델 마이그레이션 어드바이저** (`v0.6.2`): 프롬프트 지문 클러스터별 지배 모델→더 싸고 충분히 좋은(성공률 5pp 이내) 모델 전환 추천(`/admin/model-migration`) — 모델별 평균비용·성공률 비교 + `요청수×(현재−추천 비용)` 절감 추정, 절감 큰 순 정렬
- **비용센터 청구서** (`v0.6.3`): cost_center별 AI 사용료 chargeback 청구서(`/admin/invoices?cost_center=&format=markdown`) — 모델별 라인아이템+합계를 JSON/markdown으로, 미지정 시 전체 cost_center 요약
- **관리자 감사 이상탐지** (`v0.6.4`): 감사 로그에서 admin별 파괴적 버스트·권한/스코프 변경·업무외 시간·고볼륨을 탐지(`/admin/audit/anomalies`) — flags + severity(high/medium), read-only 탐지
- **Personal AI Profile** (`v0.6.5`): 사용자별 AI 사용 프로필(`/admin/personalization/profiles`, `/{user_id}`) — 팀·역할, 비용·성공률, 선호 task_type·모델·언어(Top5), 한 줄 요약. 최신 캐시 + `?snapshot=1` 시점 스냅샷, 라우팅·추천·코칭 기준점
- **My AI Home** (`v0.6.6`): 사용자 본인용 self-service 대시보드(`/me/dashboard`, `/me/recommendations`) — JWT/API Key로 호출자 식별, 오늘 사용량·이번 달 비용·자주 쓰는 모델·최근 실패·절감 가능 금액·추천 템플릿·최근 Prompt Product + 본인 패턴 기반 모델 전환/템플릿 추천
- **개인화 어드민 UI** (`v0.6.7`): 어드민 대시보드에 `개인화` 탭 추가 — Personal AI Profile 목록(정렬 가능)·상세(선호 작업/모델/언어, 비용 성향)·스냅샷 이력 및 생성 버튼
- **추천 채택률 추적** (`v0.6.8`): 추천 피드백 기록·집계 — 사용자 채택/거절(`POST /me/recommendations/feedback`)을 `recommendation_feedback`에 저장, 관리자 종류별 채택률 조회(`GET /admin/recommendations/adoption`)
- **프로필 스냅샷 추세 (drift)** (`v0.6.9`): Personal AI Profile 스냅샷 2개를 비교해 요청·비용·성공률 델타와 모델/작업 전환을 산출(`/admin/personalization/profiles/{user_id}/drift`, 상세 응답에도 포함) — cost_up/down·success_down·model_shift·task_shift 신호, 어드민 개인화 탭에 추세 카드
- **셀프서비스 키 관리** (`v0.7.0`): 사용자가 본인 API Key를 직접 관리하는 opt-in 경로(`SELF_SERVICE_KEYS_ENABLED`, 기본 off) — `GET/POST /me/keys`, `POST /me/keys/{id}/rotate`, `DELETE /me/keys/{id}`. 발급은 본인 role·스코프 이내(권한 상승 차단), 타인 키는 404, 시크릿 1회 노출 + 감사 로그
- **내 키 패널 UI** (`v0.7.1`): 어드민 대시보드 `내 키` 탭 — 본인 키 발급/회전/폐기를 화면에서(`/me/keys` 연동), 시크릿 1회 배너 표시
- **만료·미사용 키 알림** (`v0.7.2`): 활성 키의 만료 임박/만료/미사용/유휴를 탐지(`/admin/keys/health`) — flags+severity+유휴일수, My AI Home 대시보드(`/me/dashboard`)에 본인 키 알림 노출
- **개인 메뉴 (auth-user 드롭다운)** (`v0.7.3`): 사용자 칩 클릭 시 드롭다운으로 개인화·내 키·자동 새로고침·테마 전환·단축키 도움말을 모음 — 상단 nav 정리, 토큰 모드에서도 `☰ 메뉴`로 접근 가능
- **개인 메뉴 정리·콘텐츠 여백** (`v0.7.4`): 로그아웃 버튼을 개인 메뉴 내 `내 키` 아래로 이동, `내 키`·`개인화`·`사용 한도` 패널 콘텐츠에 들여쓰기 여백 적용
- **런타임 관리자 설정 — 기반** (`v0.8.0`): ClickHouse·Text2SQL 설정을 `env 기본값 + DB 관리자 오버레이`로 관리하는 기반(`/admin/settings` 조회·`/by-key/{key}` PUT/DELETE·`/validate`·`/rollback`·`/history`) — 민감값 암호화 저장 + `********` 마스킹, 변경 이력·롤백·교차 검증
- **런타임 관리자 설정 — 즉시 반영** (`v0.8.1`): 설정 저장소를 런타임 atomic 스냅샷(`s.t2sConf()`/`s.chConf()`)에 연결 — Text2SQL 모델·limit·mask·shadow·risk 및 ClickHouse DB/table/계정/fact table이 재배포 없이 다음 요청·다음 적재부터 반영
- **런타임 관리자 설정 — 커넥션 스왑·워커·테스트** (`v0.8.2`): Exec/Twin DSN 변경 시 캐시 `sql.DB` close+재오픈(swap), ClickHouse sink worker 관리형 stop/start/restart(URL·interval 변경), 연결 테스트 API(`/admin/settings/test/clickhouse`·`/text2sql-exec`·`/text2sql-twin`)
- **런타임 관리자 설정 — 어드민 UI** (`v0.8.3`): 대시보드 `런타임 설정` 탭 — 카테고리별 설정 조회·편집·저장(즉시 반영), 출처/재연결 배지, 민감값 마스킹 입력, 기본값 되돌리기·롤백·키별 이력, ClickHouse/실행 DB/Twin 연결 테스트 버튼
- **런타임 관리자 설정 — Carbon·Insurance 확장** (`v0.8.4`): 레지스트리에 `carbon.*`(wh_per_1k_tokens·pue·grid_intensity_g)·`insurance.*`(sla_target·fast_burn·slow_burn) 추가 — `s.carbonConf()`/`s.insuranceConf()` 오버레이로 탄소 점수·SLA 리포트 기준을 재배포 없이 변경(이력·롤백 포함)
- **런타임 관리자 설정 — Cache·Retention 확장** (`v0.8.5`): `cache.*`(embedding/chat/semantic 9키)는 `s.cacheConf()` 오버레이로 즉시 반영, `retention.*`(days·interval 5키)는 워커 런타임 reconfigure(일수=다음 실행, interval=ticker 재생성)로 재배포 없이 보관정책 변경
- **런타임 관리자 설정 — 일괄·내보내기/가져오기** (`v0.8.6`): `PUT /admin/settings/bulk`(원자 적용, 전체 검증 후 일괄), `GET /admin/settings/export`(비밀값 제외), `POST /admin/settings/import`(secret 키 거부) — GitOps 친화 운영
- **런타임 관리자 설정 — 역할별 권한** (`v0.8.7`): 설정 쓰기를 역할 범위로 제한(스펙 §11) — 서브 관리자 `ops_admin`(ClickHouse·Retention·Cache)·`ai_admin`(Text2SQL)·`security_admin`(masking·위험 한도·Replay·모든 secret) 추가, 키별 `permission_group`(security/ops/ai/admin) 분류. 서브 관리자는 `admin:read`만 보유하고 `/admin/settings` 하위 자기 그룹만 쓰기 가능(PUT·DELETE·bulk·import·rollback 키 단위 검증, 위반 시 403 `settings_role_denied`); `admin`/`super_admin`은 전체, `readonly_admin`은 읽기·이력만
- **런타임 관리자 설정 — 키별 상세 설명** (`v0.8.8`): 설정 화면 각 키 아래에 용도·단위·예시·재연결 영향을 작은 글씨 도움말로 표기(전 카테고리 50여 키), API 응답에도 `description` 필드 포함
- **프록시 API 키 — 팀명 표기** (`v0.8.9`): 사용자(Proxy API 키) 목록·상세에서 팀 ID(예: `team_security`)를 `auth_teams` 표시명(`Security`)으로 렌더 — `/admin/users` 응답에 `team_names`(ID→이름) 매핑 추가, UI는 이름을 크게·ID를 작은 글씨로 표시(링크·필터는 ID 유지). 셀프서비스 키가 팀 ID를 저장해 ID가 노출되던 문제 해소
- **시맨틱 캐시 — 임베딩 전용 프로바이더/URL** (`v0.9.0`): 임베딩 호출 대상을 분리하는 `cache.embedding_base_url`(직접 호출, 예: 사내 임베딩 서버)·`cache.embedding_provider`(강제 프로바이더)·`cache.embedding_api_key`(전용 키, 암호화) 추가. 미설정 시 기존 프로바이더 라우팅 그대로 폴백. 런타임 설정으로 즉시 반영
- **ClickHouse 설정·모니터링 콘솔** (`v0.9.1`): 어드민 `ClickHouse` 탭 — 연결(ping)·rollup 테이블 엔진/dedupe·자동 적재 상태·dimension별 워터마크·재처리 대기열을 한 화면에서 보고, 연결 테스트·테이블 생성·지금 적재·재처리·정합성 확인을 버튼으로 실행. `POST /admin/dw/clickhouse/bootstrap`(테이블 자동 생성, ReplacingMergeTree+정렬키), `GET /admin/dw/clickhouse/overview`(단일 상태 집계)
- **시맨틱 캐시 — 멀티턴 자동 스킵** (`v0.9.2`): 시맨틱 chat 캐시를 단발성 요청에만 적용(assistant/tool 턴·tools 선언 시 임베딩·저장 생략) — 멀티턴 대화의 무의미한 임베딩 비용·오적중 방지. 멀티턴 강제는 `cache.chat_semantic_multiturn=true`(기본 off)
- **모델 가격표 현재가 자동 시드** (`v0.9.3`): 내장 카탈로그를 현행 모델 ID(Claude 4.x·Fable 5, GPT-5.x·4o·o3, Gemini 3 등)로 갱신, 첫 기동 시 가격 테이블이 비어 있으면 자동 적용 — 시드 호출 없이 현재가로 비용 계산 동작. `/admin/pricing`·`/admin/pricing/seed?overwrite=1`로 덮어쓰기(버전 이력 유지). 가격표에 매칭 안 되는 모델은 `qwen-plus` 단가로 폴백 계산(`v0.10.7`). 폴백 모델·환율은 런타임 설정 `pricing.fallback_model`·`pricing.usd_krw`로 재배포 없이 조정(`v0.10.8`)
- **OKF 지식 기반 (Open Knowledge Format)** (`v0.9.4`): 조직 AI 컨텍스트를 문서+링크로 관리 — `okf_documents`(table/column/join_path/forbidden_query/sample_sql/model_policy/entity 등)·`okf_links`(지식그래프 엣지) + CRUD(`/admin/okf/documents`·`/admin/okf/links`), Export(`/admin/okf/export`)·Import(`/admin/okf/import`, 멱등). Text2SQL 메타지식·게이트웨이 지식그래프·자기개선 루프의 공통 저장소
- **Text2SQL OKF 메타지식 주입** (`v0.9.5`): SQL 생성 프롬프트에 허용 테이블로 스코프된 OKF 메타지식(테이블 설명·조인 경로·금지 패턴·샘플 SQL)을 주입해 정확도↑·hallucination↓. 스키마 레지스트리·골든쿼리→OKF 시드 API `POST /admin/okf/text2sql/sync`. OKF 문서 없으면 no-op
- **OKF 게이트웨이 지식그래프 + 자기개선 루프** (`v0.9.6`): `POST /admin/okf/graph/sync`로 API Key→소유자/팀, 모델→서빙 업스트림(`served_by`) 관계를 OKF 링크로 구성(라우팅 설명성). `POST /admin/okf/propose`로 반복 Text2SQL 질문을 status=proposed OKF 문서로 자동 제안 → 사람이 active로 승격(human-in-the-loop)
- **어드민 UX + API 문서** (`v0.9.7`): 요청 상세 모달 최상단에 마지막 사용자 메시지 강조 카드, 개인 메뉴에 앱 버전(단축키 도움말 아래)·세션 만료 예정 시각(로그아웃 아래)·Swagger/`openapi.json` 링크. 공개 `GET /openapi.json`·`/swagger`. `/auth/me`에 `version`·`expires_at` 추가
- **OpenAPI 전체 API 망라** (`v0.9.8`): `/openapi.json`을 전체 HTTP 서피스(135+ 경로)로 확장 — 라우트와 동기화된 카탈로그에서 코드 생성, 태그·경로 파라미터·메서드·보안 표기. Swagger UI에서 전 API 탐색
- **ClickHouse 요청 단위 fact 적재** (`v0.10.0`): 일별 rollup 유지 + **요청 1건당 1행**을 `ai_request_fact`로 비동기 배치 적재(팀·모델·provider·프로젝트·프롬프트·라우팅·토큰·비용·지연·오류). bounded 큐→batch flush(`clickhouse.batch_size`/`flush_interval`), `ReplacingMergeTree`로 멱등, 프롬프트 원문 미전송·IP 해시. 장애 시 `clickhouse_fact_retry`에 저장→`POST /admin/dw/clickhouse/fact-retry` 재처리. `clickhouse.request_fact_table` 설정 시 활성화
- **ClickHouse 세부 이벤트 fact (tool·routing·eval)** (`v0.10.1`): 같은 요청 큐에서 `ai_tool_fact`(MCP/도구 호출)·`ai_routing_fact`(라우팅 결정)·`ai_eval_fact`(LLM 평가)를 fan-out 적재. `clickhouse.tool_fact_table`·`routing_fact_table`·`eval_fact_table`로 개별 on/off, bootstrap이 DDL 생성. "위험한 MCP 도구·라우팅 절감·프롬프트 버전 품질"을 ClickHouse에서 분석
- **ClickHouse Text2SQL fact 확장** (`v0.10.2`): Text2SQL fact에 `reject_reason`·`sql_hash`(원문 미전송) 추가 — 실패 원인·SQL 형태 클러스터 분석 강화
- **ClickHouse fact 적재 상태 UI + lag/events API** (`v0.10.3`): ClickHouse 탭에 `Fact 적재 상태` 섹션(큐 깊이·드롭·request_fact lag·테이블별 행수·최근 행 보기). `GET /admin/dw/clickhouse/lag`·`/admin/dw/clickhouse/events?table=`(화이트리스트)
- **ClickHouse Materialized View** (`v0.10.4`): bootstrap이 `ai_request_fact` 위에 일별·시간별 집계 MV(`<fact>_daily`·`_hourly`, SummingMergeTree)를 생성 — 대시보드 쿼리가 원본 스캔 없이 작은 집계만 읽어 가벼움
- **ClickHouse 사람 피드백 fact** (`v0.10.5`): `/admin/llm/feedback` 기록 시 `ai_feedback_fact`(rating·label·source·created_by)를 best-effort 적재. `clickhouse.feedback_fact_table` 설정 시 활성화 — 모델/프롬프트별 피드백을 fact 조인으로 분석
- **ClickHouse 정책 결정 fact (DW 에픽 완료)** (`v0.10.6`): `ai_policy_fact`(phase·policy/rule·decision·reason·risk)를 정책 판정 시 best-effort 적재. `clickhouse.policy_fact_table` 설정 시 활성화. 요청·도구·라우팅·평가·피드백·정책·Text2SQL 전 영역이 행동 로그 DW로 적재 완료
- **Skill 레지스트리 기반** (`v0.11.0`): 재사용 가능한 AI 작업 매뉴얼을 거버넌스 대상으로 관리 — `skills`(status draft/staging/production/deprecated·risk_level·**allowed_models/allowed_tools** 정책 힌트·instructions·metadata)·`skill_runs`(실행 로그) 테이블. 공개 `GET /v1/skills`·`/v1/skills/{name}`(production만 노출), 관리 `GET/POST /admin/skills`·`GET|DELETE /admin/skills/by-name/{name}`·`GET /admin/skills/runs`. 어드민 `Skills` 탭·OpenAPI(`skills` 태그) 반영
- **Skill 정책 enforce 엔진** (`v0.12.0`): 요청이 `X-Vibe-Skill` 헤더로 Skill을 지정하면 선택된 모델·선언된 도구를 `allowed_models`/`allowed_tools`(콤마 glob)와 대조 — 파이프라인 `skill` 스텝(라우팅 직후). 모드 `skills.enforcement`(off/warn/enforce, 기본 warn): enforce 시 위반/비-production Skill은 403 `skill_policy_violation`. 판정은 `skill_runs`에 비동기 기록(blocked/ok/error). 드라이런 `POST /admin/skills/evaluate`, 추천 시드 `POST /admin/skills/seed-recommended`
- **Skill 실행·비용 관측** (`v0.13.0`): `skill_runs`를 Skill별로 집계 — `GET /admin/skills/stats?window=`(기본 30일)가 실행수·ok/error·**차단수·차단율**·총비용(₩)·평균 지연·distinct 사용자·마지막 실행을 busiest 순으로 반환. 어드민 Skills 탭 상단 `실행·비용 요약` 표
- **Skill 버저닝·승격 게이트** (`v0.14.0`): `POST /admin/skills/promote`{name,to_status,version,note}가 허용 전이(draft→staging→production, →deprecated, 롤백 등; **draft→production 직행 차단**)와 production 게이트(instructions 필수, high-risk는 note 필수)를 검증하고 `skill_promotions`에 이력 기록. 조회 `GET /admin/skills/promotions?skill=`. 어드민 Skills 탭 `승격`·`이력` 버튼
- **Skill 보안 스캐너 + production 보안 게이트** (`v0.15.0`): Skill instructions·metadata·정책을 정적 점검 — 임베딩 시크릿(타입만 보고)·프롬프트 인젝션 문구·파괴적 명령(rm -rf/DROP TABLE/`|bash`)·정책 위생(무제한 모델·도구). `GET /admin/skills/scan?name=`(단건)·`GET /admin/skills/scan`(전체). production 승격 시 high 발견 1건↑이면 422 `security_gate` 차단. 어드민 Skills 탭 `보안 스캔` 버튼
- **OKF 기반 Skill 추천** (`v0.16.0`): 반복되는 Text2SQL 질문 패턴에서 표준화 가능한 Skill 초안을 제안 — `POST /admin/skills/recommend?window=&min_count=&apply=`(기본 dry-run, `apply=1`이면 **draft 멱등 생성**, 기존 이름은 재제안 안 함). 추천은 항상 draft → 검토 후 승격 게이트·보안 스캔 거쳐 production(human-in-the-loop). 어드민 Skills 탭 `Skill 추천` 버튼. 추천→draft→승격→스캔→enforce→관측의 완결 루프
- **Skill 지침 주입** (`v0.17.0`): `X-Vibe-Skill` 헤더로 production Skill을 지정하면 그 instructions를 system 메시지로 프롬프트 맨 앞에 주입(X-Vibe-Knowledge 주입과 동일), 요청이 매뉴얼 하에 실행됨. 파이프라인 `skill` 스텝에서 정책 통과 후 body 재작성(chat 요청만, 적용 시 `X-Vibe-Skill-Applied: 1`). enforce 차단 시 미주입. Skill이 governance 객체에서 실행 가능한 능력으로 완성
- **ClickHouse Skill fact 적재** (`v0.18.0`): `skill_runs`를 ClickHouse 행동 로그 DW로 확장 — `ai_skill_fact`(skill/version/actor/model/status/tools/cost/latency)를 실행 1건당 1행 best-effort 적재(프롬프트 원문 미전송, 실패 시 retry 큐). `clickhouse.skill_fact_table` 설정 시 활성화, bootstrap DDL·lag/overview 포함. Skills 도메인이 통합 행동 로그 DW에 합류
- **Skill GitOps (Export/Import)** (`v0.19.0`): `GET /admin/skills/export?status=`(번들 `{version, skills}`)·`POST /admin/skills/import`(name 기준 멱등 업서트). Import는 검증 + 보안 게이트 보존(production으로 가져오는 Skill이 스캐너 high면 건너뜀·사유 보고). 어드민 Skills 탭 `내보내기`(JSON 다운로드)·`가져오기`(업로드) 버튼. 게이트웨이 배포 간 큐레이션 Skill 이동
- **Skill 팀 접근 제어** (`v0.20.0`): Skill에 `allowed_teams`(팀 glob, 비우면 전체) 추가 — `allowed_models`/`allowed_tools`와 대칭. `X-Vibe-Skill` 호출 시 호출자 팀을 대조해 enforce 모드에서 미허용 팀 차단(warn은 경고). 업서트/조회/Export·Import/평가(team 입력)/공개 상세에 반영, 편집기에 입력 필드. 모델·도구·팀 3차원 정책 완성
- **Skill 일일 호출 한도** (`v0.21.0`): Skill에 `daily_limit`(UTC 일 기준 최대 실행, 0=무제한) 추가 — 오늘의 실제 실행 수(ok+error)를 `skill_runs`에서 집계해 한도 도달 시 enforce는 429 `skill_rate_limited`(Retry-After), warn은 경고. 응답에 `X-Vibe-Skill-Daily-Used`/`-Limit` 헤더. 비싸거나 위험한 Skill의 폭발 반경 제한
- **예산 경보 (Budget Alerts)** (`v0.22.0`): `GET /admin/budgets/alerts?warn=&critical=&notify=&all=` — 설정된 예산을 burn/projected ratio로 ok/warn/critical 분류(기본 0.8/1.0, 예상 소진율>100%면 warn). `notify=1`이면 Mattermost로 경보 요약 푸시. 어드민 예산 카드에 `예산 경보 확인`·`경보+Mattermost 알림` 버튼
- **모델 일몰(Sunset)·폐기 정책** (`v0.23.0`): `model_deprecations`(model_glob·replacement·sunset_date·message) + `GET/POST /admin/model-deprecations`·`DELETE …/{id}`. 파이프라인 `deprecation` 스텝 — 폐기 모델 요청에 `X-Model-Deprecated`/`-Replacement`/`-Sunset` 헤더 부여, 일몰 전 경고만, 일몰 후 대체 모델 있으면 자동 재작성(`X-Model-Sunset-Rewritten`)·없으면 400 `model_sunset`. 구모델을 경고→이전→차단으로 안전 은퇴. 어드민 `모델 일몰` 탭에서 정책 목록·현재 단계 배지·추가/삭제 관리(`v0.24.0`)
- **출력 토큰 상한 가드** (`v0.25.0`): 런타임 설정 `limits.max_output_tokens`(0=비활성). >0이면 파이프라인 `limits` 스텝이 chat 요청의 `max_tokens`/`max_completion_tokens`를 상한으로 클램프(초과 시 축소, 미지정 시 주입)하고 `X-Max-Tokens-Clamped` 헤더 표기. 런어웨이 생성·비용 폭주 가드, 권한 그룹 `ops`
- **요청 본문 크기 가드** (`v0.26.0`): 런타임 설정 `limits.max_request_bytes`(0=비활성). >0이면 `limits` 스텝이 chat 요청 본문 초과 시 413 `payload_too_large`로 업스트림 호출 전 거부, `X-Request-Bytes` 헤더 표기. 대용량 프롬프트·남용 차단(입력 측 가드)
- **메시지 개수 가드** (`v0.27.0`): 런타임 설정 `limits.max_messages`(0=비활성). >0이면 `limits` 스텝이 chat `messages` 개수 초과 시 400 `too_many_messages`로 거부, `X-Message-Count` 헤더. 바이트와 무관한 컨텍스트 스터핑 차단 — limits 패밀리(출력 토큰·입력 바이트·메시지 수) 완성
- **거버넌스 스텝 관측 메트릭** (`v0.28.0`): 파이프라인 거버넌스 스텝 동작을 `/metrics`로 노출 — `proxy_skill_blocked_total`·`proxy_model_sunset_rewrites_total`·`proxy_model_sunset_blocked_total`·`proxy_limits_clamped_total`·`proxy_limits_rejected_total`. 가드 발동 빈도를 대시보드·알람으로 모니터링
- **ClickHouse DW 대시보드 (MVP)** (`v0.29.0`): 어드민 `DW 대시보드` 탭 — ClickHouse 일별 rollup 기반 장기 추세·비용 분석. `GET /admin/dw/dashboard/overview`(KPI)·`/timeseries`(일별 추이)·`/dimensions?dimension=model|provider|project|cost_center`(Top-N). `window` 필터(1d/7d/30d/90d), ReplacingMergeTree `FINAL` dedupe, `FORMAT JSON` 조회·SQL 이스케이프, ClickHouse 미설정 시 `DW 비활성`. 운영 DB=실시간 상세, ClickHouse=장기 집계 역할 분리. CSV 내보내기 `GET /admin/dw/dashboard/export.csv`(UTF-8 BOM)·DW 적재 상태(Health) 패널(watermark·실패 큐·재처리 버튼) 추가(`v0.30.0`). Text2SQL 분석 패널 `GET /admin/dw/dashboard/text2sql`(질의·valid·executed·차단율·EXPLAIN risk·모드별·실패원인 Top, 원문 미노출) 추가(`v0.31.0`). 정합성(Consistency) 패널 — `/admin/dw/consistency` 화면화로 차원별 운영 DB↔ClickHouse 적재량 차이·일치 상태 진단(`v0.32.0`). 라우팅 분석 패널 `GET /admin/dw/dashboard/routing`(자동 재작성율·fallback·complexity/risk/health·모델 재작성/결정 근거 Top)(`v0.33.0`). 성능(지연) 분석 패널 `GET /admin/dw/dashboard/latency`(`ai_request_fact`에서 P50/P95/P99·TTFB P95·스트리밍 비율·오류율·모델별 P95 Top, model/provider/project/cost_center/team 필터 조합)(`v0.34.0`). 품질 분석 패널 `GET /admin/dw/dashboard/quality`(`ai_eval_fact` 평가 수·평균 점수·통과율·카테고리별 + `ai_feedback_fact` 평점·긍정/부정·긍정 비율·label별, 두 소스 각각 선택적)(`v0.35.0`)
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
| `SELF_SERVICE_KEYS_ENABLED` | `false` | `true`면 사용자가 `/me/keys`로 본인 API Key를 직접 발급·회전·폐기(본인 스코프 이내) |
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
| `CARBON_WH_PER_1K_TOKENS` | `0.4` | Prompt Carbon Score 기본 에너지 계수(1K 토큰당 Wh) |
| `CARBON_MODEL_WH_PER_1K` | 없음 | 모델별 에너지 계수 오버라이드(`gpt-4.1=0.8,gpt-4.1-mini=0.2`) |
| `CARBON_PUE` | `1.2` | 데이터센터 PUE(전력 사용 효율) 배수 |
| `CARBON_GRID_INTENSITY_G` | `475` | 그리드 탄소 강도(gCO2e/kWh) |
| `INSURANCE_SLA_TARGET` | `0.99` | AI 요청 보험 SLA 신뢰도 목표(claim_rate 허용치=1-목표) |
| `INSURANCE_FAST_BURN` | `14.4` | 에러버짓 fast-burn(page) 임계 배수 |
| `INSURANCE_SLOW_BURN` | `3.0` | 에러버짓 slow-burn(ticket) 임계 배수 |

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

- **안전장치**: SELECT/CTE 전용(DDL·DML·스택쿼리·`SELECT INTO`·위험함수 차단, 문자열/주석 리터럴 스크럽 후 분석, **괄호·따옴표 균형 구조 검증**으로 생성 도중 잘린 SQL 차단), 자동 `LIMIT`, 테이블 allowlist + **컬럼 민감도(normal/mask/aggregate_only/approval_required/exclude)** — `exclude`·`approval_required` 컬럼은 LLM 컨텍스트에서 제외되고 참조 SQL은 차단, `aggregate_only` 컬럼은 집계함수(`count/sum/avg/min/max/…`) 내에서만 허용(원시 참조 차단), `mask` 컬럼은 **결과에서 컬럼 단위 마스킹**, PostgreSQL `EXPLAIN` **위험 점수화**(비용·seq scan·nested loop) 차단, 가상모델 비유출(업스트림엔 실제 모델만), `task_type=text2sql` + `requested_model`/`upstream_model` 감사.
- **실행 샌드박스**: execute 모드는 read-only 트랜잭션 + `SET LOCAL statement_timeout`·`work_mem`(`TEXT2SQL_STATEMENT_TIMEOUT`·`TEXT2SQL_WORK_MEM`)로 격리 실행.
- **결과 캐시**: preview 생성 결과를 `text2sql_cache`(질문·스키마·모드·**스키마 버전** 키 + TTL)에 캐시 — 스키마 버전이 바뀌면 자동 무효화(`TEXT2SQL_CACHE_ENABLED`·`TEXT2SQL_CACHE_TTL`).
- **스키마 버전 관리**: `text2sql_schemas` 에 version/collected_at/source_fingerprint — 자동 수집 시 컬럼 지문이 바뀌면 버전 자동 증가.
- **재질문(clarification)**: 모호하거나(너무 짧음) 기간 필터가 필요한데 누락된 질문은 곧바로 SQL 을 만들지 않고 보완 질문을 돌려줌(`TEXT2SQL_CLARIFY_ENABLED`·`TEXT2SQL_REQUIRE_DATE_FILTER`).
- **비용·품질 라우팅**: 기본 모델의 최근 유효율이 낮으면(충분한 표본에서) accurate 모델로 자동 승격.
- **위험 요청 큐**: `/admin/text2sql/risk-queue` — 거부·고위험 EXPLAIN·실패로 분류된 요청을 운영자가 한 화면에서 검토.
- **업무 용어 사전**: `text2sql_business_terms`(`/admin/text2sql/glossary`) — 업무 용어→테이블/컬럼/조건 매핑을 생성 프롬프트에 주입해 현업 언어로 질문 가능.
- **스키마 레지스트리**: `text2sql_schemas`(이름·팀·기본) + `text2sql_tables`/`text2sql_columns`(업무 설명·민감도)로 프롬프트 컨텍스트를 구조화 생성. `POST /admin/text2sql/collect` 로 실행 DB(`information_schema`/`sqlite_master`)에서 자동 수집(운영자 태그 보존).
- **권한 매트릭스**: `text2sql_permissions`(`/admin/text2sql/permissions`) 로 팀·API Key·사용자별 schema/table/column allow·deny 정책 — deny는 테이블/컬럼 접근 제한, allow는 민감(exclude) 컬럼 접근을 특정 주체에 부여.
- **운영 분석**: 실패 원인 표준 분류(syntax/permission/cost/timeout/unknown_column/empty)와 EXPLAIN 위험도(cost·risk_score), **재현성 필드**(schema_name·schema_version·permission_hash·glossary_hash)를 로그에 저장, ClickHouse 자동 적재 스케줄러(`CLICKHOUSE_SINK_INTERVAL`) + 정합성 검증(`/admin/dw/consistency`) + dimension별 watermark·실패 재처리 큐(`/admin/dw/sink-status`, `/admin/dw/sink-retry`).
- **few-shot · 품질**: 검증된 골든 쿼리를 질문 유사도로 생성 프롬프트에 주입하고, 성공 쿼리는 골든 자동 후보로 적립. `text2sql.sql_valid`/`executed` 평가를 LLM evaluation 파이프라인으로 emit, 모델별 SQL 품질 메트릭 제공.
- **응답 포맷**: 해석 / 생성 SQL / 결과 / 주의사항 / 실행 가능 여부 / 다음 질문 제안 섹션으로 현업 친화 구성.
- **장기 분석**: `POST /admin/dw/clickhouse` 로 일별 rollup 을 ClickHouse HTTP 인터페이스(JSONEachRow)로 적재(`CLICKHOUSE_URL` 설정 시). dimension별 마지막 성공 watermark 와 실패 재처리 큐를 영속화 — `GET /admin/dw/sink-status` 로 진행 상태 조회, `POST /admin/dw/sink-retry`(또는 `?all=1`)로 실패분 재적재. `GET /admin/dw/consistency` 정합성 검증은 dimension별(all·model·provider·project·cost_center)로 비교하며, `GET /admin/dw/table-info` 로 대상 테이블 엔진(ReplacingMergeTree)·정렬키 dedupe 키를 점검할 수 있습니다. `CLICKHOUSE_TEXT2SQL_FACT_TABLE` 설정 시 질의 단위 fact(마스킹)를 watermark 증분으로 적재(`POST /admin/dw/text2sql-fact` 수동).
- **관리**: 어드민 `Text2SQL` 탭 + `GET /admin/text2sql`(프로필·통계·로그·모델 메트릭), 스키마 카탈로그/레지스트리 `(/admin/text2sql/schemas|tables|columns|collect)`, 런타임 프로필 `(/admin/text2sql/profiles)`, 골든 쿼리 `(/admin/text2sql/golden[/run])` — `?execute=1` 시 결과 동등성 검증, 위험 요청 큐 `(/admin/text2sql/risk-queue` — 자동 개선 제안 포함), 업무 용어 사전 `(/admin/text2sql/glossary` — 충돌 탐지 포함), 실행 DB 헬스체크 `(/admin/text2sql/healthcheck)`, 스키마 영향도 `(/admin/text2sql/schema-impact)`, Replay Bundle `(/admin/text2sql/replay)`, Kill Switch `(/admin/text2sql/kill-switch)`, 인사이트 마이너 `(/admin/text2sql/miners)`, 행동 이상 탐지 `(/admin/text2sql/anomalies)`, Prompt DNA `(/admin/text2sql/prompt-dna)`, 질문 승격 `(/admin/text2sql/promote)`·저장 리포트 `(/admin/text2sql/reports)`, 기능 토글 `(/admin/text2sql/features)`.

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
| `TEXT2SQL_TWIN_DRIVER` | `postgres` | SQL Digital Twin DB 드라이버(Golden 결과 동등성 검증용) |
| `TEXT2SQL_TWIN_DSN` | 없음 | 마스킹·샘플 트윈 DB DSN(설정 시 Golden 결과 동등성 검증을 운영 DB 대신 트윈에서 실행, 미설정 시 execute DB 폴백) |
| `TEXT2SQL_CACHE_ENABLED` | `true` | preview 결과 캐시 사용 |
| `TEXT2SQL_CACHE_TTL` | `1h` | 캐시 TTL |
| `TEXT2SQL_CLARIFY_ENABLED` | `false` | 모호 질문 재질문(clarification) 모드 |
| `TEXT2SQL_REQUIRE_DATE_FILTER` | `false` | 기간 필터 누락 시 재질문 요구 |
| `TEXT2SQL_STATEMENT_TIMEOUT` | `15s` | (postgres) 실행 statement_timeout |
| `TEXT2SQL_WORK_MEM` | 없음 | (postgres) 실행 시 SET LOCAL work_mem |
| `TEXT2SQL_SHADOW_MODELS` | 없음 | shadow 평가 후보 업스트림 모델(콤마) |
| `TEXT2SQL_SHADOW_SAMPLE_RATE` | `0` | preview shadow 평가 샘플링 비율(0~1) |
| `TEXT2SQL_REPLAY_BUNDLES` | `false` | 질의별 생성 컨텍스트(프롬프트·스키마·용어·권한) 저장(감사/재현, secret 마스킹) |
| `RETENTION_TEXT2SQL_REPLAY_DAYS` | `30` | Replay Bundle 보존 일수(이후 retention 워커가 GC) |
| `TEXT2SQL_DAILY_RISK_LIMIT` | `20` | API Key 당일 위험 요청 한도(`cumulative_risk_enforce` 토글 ON 시 적용) |
| `TEXT2SQL_DAILY_RISK_WARN` | `0` | 차단 한도 이하 경고 임계(0이면 한도의 1/2 자동 적용) |
| `CLICKHOUSE_TEXT2SQL_FACT_TABLE` | 없음 | 설정 시 Text2SQL 질의 단위 fact 테이블로 행 단위 적재(마스킹) |

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
