[CmdletBinding()]
param(
    [string]$Version
)

$ErrorActionPreference = "Stop"

if (-not $Version) {
    throw "Version parameter is required. Example: pwsh -File scripts/gh_release.ps1 -Version v0.1.1"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$cleanVer = $Version.TrimStart('v')

$notes = "## AI Proxy Gateway v" + $cleanVer + "`r`n`r`n"
$notes += "### 주요 변경 사항`r`n"
$notes += "- **만료·미사용 키 알림 (`v0.7.2`)**: API Key 위생 점검 — 활성 키 중 **만료 임박/만료됨/미사용/장기 유휴**를 탐지(`GET /admin/keys/health?stale_days=&expiring_days=`, 기본 30·7일). 키별 flags(expired/expiring_soon/never_used/stale_unused)·severity(high/medium)·유휴일수, request_logs로 마지막 사용 시점 산출, 위험 큰 순 정렬. My AI Home 대시보드(`/me/dashboard`)에 **본인 키 알림** 섹션 추가. read-only`r`n"
$notes += "- **내 키 패널 UI (`v0.7.1`)**: 어드민 대시보드에 **``내 키``** 탭 추가 — 로그인 주체 본인의 API Key를 화면에서 발급/회전/폐기(`/me/keys` 연동). 발급/회전 시 평문 시크릿을 1회 배너로 표시(복사용), 스코프는 비우면 본인 권한 상속·입력 시 본인 범위 내로 제한. 셀프서비스 비활성(`SELF_SERVICE_KEYS_ENABLED=false`) 또는 사용자 식별 불가 시 안내 메시지`r`n"
$notes += "- **셀프서비스 키 관리 (`v0.7.0`)**: 사용자가 **본인 소유 API Key를 직접 관리**하는 opt-in 경로(`SELF_SERVICE_KEYS_ENABLED`, 기본 off) — `GET/POST /me/keys`(본인 키 목록·발급), `POST /me/keys/{id}/rotate`(회전), `DELETE /me/keys/{id}`(폐기). 호출자는 JWT(sub) 또는 API Key(user_id)로 식별, 발급 키는 **본인 role·스코프 이내로만**(권한 상승 차단, 미지정 시 본인 스코프 상속), 타인 키는 404로 은닉. 평문 시크릿은 발급/회전 시 1회만 반환, 모든 동작 감사 로그 기록`r`n"
$notes += "- **프로필 스냅샷 추세 (drift) (`v0.6.9`)**: Personal AI Profile 스냅샷(v0.6.5)을 시점 비교해 사용 패턴 변화를 드러냄 — 최근 2개 스냅샷 간 요청수·총비용·요청당 평균비용·성공률 델타와 대표 모델/주요 작업 전환을 계산하고 `cost_up`/`cost_down`/`success_down`/`model_shift`/`task_shift` 신호 부여. 프로필 상세 응답에 `drift` 포함 + 전용 조회(`GET /admin/personalization/profiles/{user_id}/drift`), 어드민 ``개인화`` 탭 상세에 추세 카드 표시. 스냅샷 2개 미만이면 baseline 없음`r`n"
$notes += "- **추천 채택률 추적 (`v0.6.8`)**: My AI Home 추천(v0.6.6)에 대한 사용자 피드백을 기록·집계 — 사용자가 추천을 **채택/거절**(`POST /me/recommendations/feedback {id, action}`, 추천의 kind·ref에 키잉)하면 `recommendation_feedback`에 저장, 관리자는 종류별 채택/거절·distinct 채택자·채택률(adopted/(adopted+dismissed))을 조회(`GET /admin/recommendations/adoption?window=`). 추천이 실제로 행동으로 이어지는지 측정. 추천 레코드에 `ref`(추천 모델/템플릿 id) 추가`r`n"
$notes += "- **개인화 어드민 UI (`v0.6.7`)**: Personal AI Profile(v0.6.5)을 어드민 대시보드에 **새 ``개인화`` 탭**으로 노출 — 사용자별 프로필 목록(요청·총비용·성공률·대표 모델·주요 작업·요약, 정렬 가능)과 상세 화면(팀/역할, 비용 성향, 선호 작업/모델/언어, 스냅샷 이력 + ``스냅샷 생성`` 버튼). 운영자가 curl 없이 사용자 사용 패턴을 검토하고 시점 스냅샷을 남길 수 있음`r`n"
$notes += "- **My AI Home (`v0.6.6`)**: 관리자 대시보드와 별개로 **사용자 본인이 자신의 AI 사용 현황을 보는** self-service 화면(`GET /me/dashboard`, `GET /me/recommendations`) — 호출자를 JWT(sub) 또는 API Key(user_id)로 식별. 대시보드: 오늘 사용량·이번 달 비용/요청·자주 쓰는 모델·최근 실패 요청·절감 가능 금액(본인 최저비용-충분 모델로 환산)·추천 템플릿·최근 Prompt Product. 추천: 본인 사용 패턴 기반 모델 전환(절감액 포함)·표준 템플릿 채택 제안을 생성·`personal_recommendations`에 저장. 사용자가 스스로 비용·품질을 개선`r`n"
$notes += "- **Personal AI Profile (`v0.6.5`)**: 사용자별 AI 사용 프로필을 로그에서 산출하는 read-only 기능(`GET /admin/personalization/profiles`, `GET /admin/personalization/profiles/{user_id}`) — api_key→user 매핑으로 팀·역할, 요청량·총비용·요청당 평균비용, 성공/오류율, 선호 task_type·모델·언어(Top5), distinct 모델/프롬프트지문, 한 줄 요약(예: ``주로 refactor, sql_analysis를 수행하며 gpt-4.1-mini 선호, 성공률 86%``)을 집계. 상세 조회 시 최신 프로필을 `personal_profiles`에 캐시하고 `?snapshot=1`이면 `personal_profile_snapshots`에 시점 스냅샷 기록. 이후 라우팅·템플릿 추천·Text2SQL 힌트·비용 코칭의 기준점`r`n"
$notes += "- **관리자 감사 이상탐지 (`v0.6.4`)**: 관리자 감사 로그에서 의심 패턴을 탐지하는 read-only 분석(`/admin/audit/anomalies?window=&destructive=&volume=`) — admin별 **파괴적 액션 버스트**(delete/revoke/remove/hard, 기본 5건↑), **권한/스코프 변경**(scope/role/grant/permission/escalat), **업무외 시간 활동**(22:00–06:00 UTC), **고볼륨**(기본 100건↑)을 집계해 flags + severity(high/medium) 부여, 위험 큰 순 정렬. sqlite/pg 공통(시간 분석은 앱에서 수행), 강제 없음`r`n"
$notes += "- **비용센터 청구서 (`v0.6.3`)**: cost_center별 AI 사용료 **chargeback 청구서** 생성(`/admin/invoices?cost_center=&window=&format=`) — 지정 시 해당 센터의 모델별 라인아이템(요청·토큰·비용)+합계를 JSON 또는 **markdown 청구서**(`format=markdown`, 티켓·위키·Mattermost 붙여넣기용)로 반환, 미지정 시 전체 cost_center 요약 목록. 기존 비용 배부 데이터 재사용, read-only`r`n"
$notes += "- **모델 마이그레이션 어드바이저 (`v0.6.2`)**: 프롬프트 지문 클러스터별로 **지배 모델 → 더 싸고 충분히 좋은 모델** 전환을 추천하는 read-only 어드바이저(`/admin/model-migration?window=&min_requests=`) — 동일 프롬프트 형태에서 관측된 모델별 평균비용·성공률을 비교해, 최고 성공률 대비 5pp 이내이면서 더 싼 모델을 후보로 제시하고 ``클러스터 요청수×(현재−추천 평균비용)``으로 절감액 추정. 최소 요청수(기본 20) 미만 클러스터·단일 모델 클러스터는 제외, 절감액 큰 순 정렬`r`n"
$notes += "- **에러버짓 번레이트 (`v0.6.1`)**: SLA claim 정의(4xx/5xx/failover/error) 위에 **멀티윈도우 에러버짓 소진율** 산출(`/admin/insurance/burn-rate?dimension=&window=&short=&sla=`) — scope별 short(기본 1h)·long(기본 24h) 윈도우의 claim_rate를 허용치(`1-SLA`)로 나눈 burn rate, Google SRE 패턴대로 두 윈도우 모두 ``fast``(기본 14.4×, page) / long만 ``slow``(기본 3×, ticket) 분류 + 30일 버짓 기준 ``소진까지 일수``(=30/long burn) 투영. 임계값 `INSURANCE_FAST_BURN`/`INSURANCE_SLOW_BURN` 또는 `?fast=&slow=` 오버라이드. 위험 큰 순 정렬`r`n"
$notes += "- **절감 리포트 (Savings Report) (`v0.6.0`)**: 게이트웨이가 만들어낸 비용 절감을 scope별로 정량화하는 read-only 리포트(`/admin/savings?dimension=&window=`) — **라우팅 다운시프트 절감**(요청 모델보다 싼 모델로 서빙된 요청을 ``요청 모델 가격으로 환산한 baseline − 실제 비용``으로 정확 산출)과 **캐시 절감**(route_reason=cache 적중 × 동일 scope 비캐시 평균 비용으로 추정)을 합산. scope별 다운시프트 요청수·절감액·캐시 적중·캐시 절감(추정)·총 절감액 + 전체 합계. 게이트웨이 ROI를 숫자로 증명`r`n"
$notes += "- **AI 요청 보험 모드 (SLA claims) (`v0.5.9`)**: 보장 범위(scope)별 요청을 ``covered``로, 저하된 결과(4xx/5xx/failover/error)를 ``claim``으로 보고 SLA 목표 대비 위반을 드러내는 read-only 원장(`/admin/insurance/claims?dimension=&window=&sla=`) — scope별 covered·claims(+5xx/4xx/failover 진단 분해)·claim_rate·신뢰도, SLA 허용치(`(1-목표)*covered`) 대비 초과 claim(excess=위반 규모)와 sla_met 산출, 위반 큰 순 정렬. 목표는 `INSURANCE_SLA_TARGET`(기본 0.99) 또는 `?sla=` 오버라이드. 강제 없음`r`n"
$notes += "- **Prompt to Product (`v0.5.8`)**: 반복되는 chat 프롬프트(프롬프트 지문 클러스터)를 **재사용 가능한 명명된 템플릿(제품)** 으로 승격하는 전체 루프 — 후보 발굴(`GET /admin/prompt-products/candidates` : 기존 프롬프트 지문 분석 재사용, 빈도·비용·대표/최저비용 모델·샘플 + 이미 제품화 여부 표시), 승격(`POST /admin/prompt-products` : 정식 템플릿 생성 + 출처 지문·승격 시점 reach(요청수·distinct 사용자) 스냅샷 기록), 목록(채택도=템플릿 use_count·last_used 조인), 삭제. 원천 프롬프트 로그가 없어도(LOG_RAW_PROMPTS off) 관리자가 정식 템플릿 본문을 작성해 자산화. 새 의존성 없음`r`n"
$notes += "- **Golden Workflow (`v0.5.7`)**: 여러 골든 스텝을 **순서가 있는 하나의 회귀 단위**로 묶어 실행하는 1급 엔터티(`/admin/golden-workflows` CRUD, `/admin/golden-workflows/run`) — 단발 Golden Prompt나 임의 태그 그룹과 달리 워크플로우는 이름·설명·정렬된 스텝(각 prompt+expected)을 갖고, 실행 시 스텝별 통과/점수와 전체 pass_rate를 반환. `?fail_on_regression=1`+`min_pass_rate`로 CI 게이트 사용(미달 시 422). 스텝 간 출력 체이닝은 의도적으로 제외(단순 회귀 스위트). 새 의존성 없음`r`n"
$notes += "- **AI 업무지도 (Work Map) (`v0.5.6`)**: ``어떤 AI 업무가 어디서 누구에 의해 일어나는가``를 한 화면에 모으는 read-only 통합 뷰(`/admin/work-map?dimension=&window=`) — work 차원(기본 project, repo·team·service 등)별로 요청량·토큰·비용·distinct 사용자/모델·오류율·대표 모델과 **task_type(generate/refactor/debug 등) 분포**를 노드 단위로 집계. 단일 지표인 비용 배부, 신뢰도 중심의 신용점수와 달리 ``업무의 성격``까지 한눈에. 새 의존성·계약 변경 없음`r`n"
$notes += "- **Prompt Carbon Score (`v0.5.5`)**: 이미 적재된 토큰 사용량으로 요청의 **전력(Wh)·운영 탄소(gCO2e)** 를 추정하는 read-only 분석(`/admin/carbon-score?dimension=&window=`) — subject(model·project·api_key 등)별 토큰량에 모델별 에너지 계수를 적용해 에너지/배출/요청당 Wh 산출. 계수는 전부 설정값(`CARBON_WH_PER_1K_TOKENS` 기본 0.4Wh/1K, `CARBON_MODEL_WH_PER_1K`=model별 오버라이드, `CARBON_PUE` 기본 1.2, `CARBON_GRID_INTENSITY_G` 기본 475 gCO2e/kWh)이며, 공개 추정치 편차가 커 **절대값이 아닌 주체 간 상대 비교 신호**로 사용. 강제 없음`r`n"
$notes += "- **SQL Digital Twin (`v0.5.4`)**: Golden Query **결과 동등성 검증**을 운영 DB 대신 마스킹·샘플 **트윈 DB**에서 실행하는 opt-in 경로 추가 — `TEXT2SQL_TWIN_DSN`(+`TEXT2SQL_TWIN_DRIVER`, 기본 postgres) 설정 시 기대/생성 SQL 비교를 트윈에서 수행해 프로덕션 데이터 노출 없이 검증 가능, 미설정 시 기존 실행 DB로 그대로 폴백(동작 변화 없음). 트윈 커넥션은 지연 오픈·캐시(read-only 검증 전용)`r`n"
$notes += "- **사내 AI 신용점수 (`v0.5.3`)**: subject(API Key·project·model 등)별 **신용점수**(`/admin/ai-credit-score?dimension=&window=`) — 신뢰도(성공률 0.7)+비용효율(상대 cost/req 0.3) 블렌드 0~100, 표본 5건 미만은 low-confidence 표시. 안전/비용 효율이 좋은 주체를 한눈에(read-only, 강제 없음)`r`n"
$notes += "- **데이터 상품 추천 (`v0.5.2`)**: 반복 Text2SQL 질문(report candidate)에 SQL 형태 기반 **추천 산출물 분류** 추가 — 집계 쿼리→`dashboard`, 다중 JOIN→`data_mart`, 단건/목록 조회→`api`. 어드민 인사이트 표에 노출되어 반복 질문을 어떤 데이터 상품으로 만들지 판단 보조`r`n"
$notes += "- **시맨틱(임베딩) chat 캐시 (`v0.5.1`)**: 정확 캐시(temp 0/seed) miss 시 프롬프트를 임베딩해 코사인 유사도로 근사 응답을 재사용하는 opt-in 캐시 — `CACHE_CHAT_SEMANTIC_ENABLED`+`CACHE_CHAT_SEMANTIC_MODEL`(임베딩 모델) 필요, `CACHE_CHAT_SEMANTIC_THRESHOLD`(기본 0.95)·`CACHE_CHAT_SEMANTIC_MAX_CANDIDATES`(기본 200). 임베딩 호출 실패 시 정상 업스트림으로 안전 폴백, 만료 엔트리는 retention 워커가 정리. 적중 시 `X-Cache-Type: chat-semantic``r`n"
$notes += "- **Text2SQL 어드민 UI 통합 (`v0.5.0`)**: 그동안 API 전용이던 기능들을 어드민 Text2SQL 탭에 노출 — 저장 리포트(스케줄·MM 전달 상태), 인사이트 마이너(반복 질문 → **원클릭 리포트 승격** 버튼, 업무 용어 후보), 행동 이상 탐지(usage smell·팀 누적 위험·intent drift). 운영자가 코드/curl 없이 컨트롤 플레인을 다룰 수 있음`r`n"
$notes += "- **Text2SQL 관측 메트릭 (`v0.4.9`)**: Prometheus(`/metrics`)에 Text2SQL 운영 카운터 추가 — `proxy_text2sql_requests_total`, `_cache_hits_total`, `_risk_blocked_total`, `_challenge_veto_total`, `_shadow_evals_total`. 그동안 추가한 기능들(캐시·위험 차단·self-challenge·shadow)의 실제 발동량을 모니터링 가능`r`n"
$notes += "- **저장 리포트 스케줄 실행 (`v0.4.8`)**: 승격된 saved report에 스케줄(`schedule_interval` 예 24h)·on/off·Mattermost 전달 설정(`POST /admin/text2sql/reports {id,interval,enabled,deliver_mattermost}`) 추가. 백그라운드 스케줄러가 도래한 리포트를 read-only로 실행하고 결과 요약을 Mattermost(`text2sql_report` 이벤트)로 전달 — 반복 질문 자산화의 마지막 단계 완성. 실행 DB(`TEXT2SQL_EXEC_DSN`) 미설정 시 자동 비활성`r`n"
$notes += "- **정책 GitOps export/import (`v0.4.7`)**: 거버넌스 정책+룰을 portable JSON으로 내보내기(`GET /admin/policies/export`)·가져오기(`POST /admin/policies/import`). `?dry_run=1`이면 생성/수정 플랜만 반환(쓰기 없음)하여 repo 커밋·PR 리뷰·diff·롤백 기반 GitOps 운영 가능`r`n"
$notes += "- **ClickHouse 상세 Text2SQL fact 적재 (`v0.4.6`)**: 일별 rollup에 더해 **질의 단위 fact 테이블** 적재(`CLICKHOUSE_TEXT2SQL_FACT_TABLE` 설정 시) — 질문 원문/SQL은 제외(마스킹, question_chars만)하고 team·모델·모드·스키마버전·valid·executed·row_count·EXPLAIN위험·비용·지연·실패분류를 행 단위로 전송. watermark 증분(`text2sql_fact` dimension) + 자동 sink 루프 포함 + 수동 `/admin/dw/text2sql-fact`. 첫 실행은 최근 7일 백필`r`n"
$notes += "- **Text2SQL 응답 품질 강화 (`v0.4.5`)**: 검증 통과 응답에 **감사 근거 푸터**(스키마·버전·permission/glossary 지문·EXPLAIN 위험·마스킹 컬럼) 자동 첨부, 검증 거부 시 **수정 방법 안내**(사유 기반 친화 가이드) 첨부, 실행 결과 0행이면 **결과 없음 복구 제안**(기간·조건·필터 완화) 첨부`r`n"
$notes += "- **Text2SQL 질문 자산화 + 위험 단계화 (`v0.4.4`)**: 반복 질문 원클릭 **승격 API**(`/admin/text2sql/promote` — target=report/golden/glossary; 저장 리포트는 `text2sql_saved_reports` + `/admin/text2sql/reports` 목록/삭제)로 Prompt DNA·리포트 후보를 리포트·골든쿼리·업무 용어 자산으로 전환. 누적 위험 enforce를 **단계화**(감지 < `TEXT2SQL_DAILY_RISK_WARN` ≤ 경고 < `TEXT2SQL_DAILY_RISK_LIMIT` ≤ 차단) — 경고 구간은 응답에 주의 문구만 첨부하고 정상 처리, 차단 구간만 차단`r`n"
$notes += "- **Text2SQL Prompt DNA + 누적 위험 enforce 토글 (`v0.4.3`)**: 질문 지문 분석 **Prompt DNA**(`/admin/text2sql/prompt-dna` — 지문별 빈도·distinct 사용자·평균비용·거부율 집계 + repeated/high_cost/risky 라벨, read-only). 탐지→차단 강제를 위한 **누적 위험 한도 enforce** 토글(`cumulative_risk_enforce` + `TEXT2SQL_DAILY_RISK_LIMIT`, 기본 OFF) — API Key의 당일 위험 요청(거부·고위험 EXPLAIN·실패)이 한도를 넘으면 SQL 생성 전 차단`r`n"
$notes += "- **Text2SQL 기능 토글 + Self Challenge·Gateway Memory (`v0.4.2`)**: 관리자에서 런타임 온오프 가능한 기능 토글 프레임워크(`/admin/text2sql/features`, 어드민 UI 스위치, kill-switch 동일 패널) 추가. 토글로 켜는 신규 기능 — **Self Challenge Proxy**(생성 SQL을 보조 모델이 검토, preview는 의견 첨부·execute는 unsafe 판정 시 실행 보류, 기본 OFF·켜면 요청당 추가 호출), **Gateway Memory**(사용자가 자주 쓰는 테이블을 프롬프트 힌트로 보강, 기본 OFF)`r`n"
$notes += "- **Text2SQL 행동 이상 탐지 (탐지 전용) (`v0.4.1`)**: 차단 없이 운영자 가시성만 제공하는 read-only 탐지(`/admin/text2sql/anomalies`) — **AI Smell Detector**(반복 질문·권한 우회성 거부 반복·스키마 전체 요청), **누적 위험 노출**(팀별 거부·고위험 EXPLAIN·권한 탐침 가중 집계), **Intent Drift Detector**(api_key별 조회→위험/광범위 키워드 이동 감지). 모든 신호는 경고만 하며 요청을 차단하지 않음`r`n"
$notes += "- **Text2SQL 인사이트 마이너 (`v0.4.0`)**: 질문 로그에서 운영 인사이트를 자동 추출하는 read-only 마이너(`/admin/text2sql/miners`) — **Report Candidate Miner**(반복되는 질문을 빈도 집계해 대시보드·배치 리포트 후보로 추천)와 **Glossary Miner**(빈출 질문 토큰 중 스톱워드·기존 정의어를 제외하고 업무 용어 사전 후보 추출). 프록시 호출 비용·사용자 계약 변경 없음`r`n"
$notes += "- **Text2SQL 답변 근거 표시·운영 Kill Switch (`v0.3.9`)**: 응답에 **답변 근거** 섹션 추가(사용한 테이블 + WHERE 적용 조건을 비-SQL 사용자도 검토 가능), 런타임 **Kill Switch**(`/admin/text2sql/kill-switch` — 장애·비용·보안 사고 시 재배포 없이 Text2SQL 즉시 중지, 가상 모델은 안전 메시지 반환)`r`n"
$notes += "- **Text2SQL 민감도 API 보완·DW 점검 강화·비용 분리 (`v0.3.8`)**: 컬럼 민감도 API가 `aggregate_only`·`approval_required`까지 허용(기존 normal/mask/exclude만 → UI 드롭다운과 불일치 수정), Golden Query 결과 동등성 검증을 실행 DB 있을 때 **기본 적용**(`?execute=0`로 해제), ClickHouse 정합성 검증을 **dimension별**(all·model·provider·project·cost_center) 확대, 대상 테이블 **엔진/정렬키 점검 API**(`/admin/dw/table-info` — ReplacingMergeTree·dedupe 키 확인), Text2SQL 비용을 **generation/summary/shadow로 분리** 기록, Replay Bundle **보존 정책(retention GC)·secret 마스킹** 추가`r`n"
$notes += "- **Text2SQL 운영 가시성·재현성 확장 (`v0.3.7`)**: 업무 용어 사전 **충돌 탐지**(동일 용어 복수 매핑·전역/스키마 shadowing을 관리자 화면에서 경고), 위험 요청 큐 **자동 개선 제안**(기간 조건 추가·집계 변경·민감 컬럼 제외·LIMIT 축소 등 수정안 제시), **스키마 변경 영향도 리포트**(`/admin/text2sql/schema-impact` — 버전 변경 시 영향받는 golden·cache·glossary·permission 집계), **Replay Bundle**(opt-in `TEXT2SQL_REPLAY_BUNDLES` — 당시 프롬프트·스키마 컨텍스트·용어사전·권한 스냅샷을 저장해 `/admin/text2sql/replay`로 사후 재현)`r`n"
$notes += "- **Text2SQL shadow 정책 일치·검증기 집계 정확도 (`v0.3.6`)**: shadow 모델 평가가 live와 **동일한 검증 정책**(테이블 allowlist·blocked·aggregate-only)을 적용해 모델 품질 지표를 운영과 일치시킴, 검증기 aggregate-only 판정을 **중첩 괄호 균형 기반**으로 고도화(`sum(coalesce(col,0))` 등 중첩 집계 내 컬럼을 정상 허용, window `OVER(PARTITION BY col)`의 원시 참조는 차단 유지)`r`n"
$notes += "- **Text2SQL 검증 정확도·결과 보호·모델 품질 평가 강화 (`v0.3.5`)**: 컬럼 민감도(`mask`) 기반 **컬럼 단위 결과 마스킹**(선언된 컬럼만 마스킹, 미선언 시 기존 전체 마스킹), 검증기 in-tree **구조 검증**(괄호·따옴표 균형 → 생성 도중 잘린 SQL 차단), 실행 DB **read-only 헬스체크**(`/admin/text2sql/healthcheck` — 연결·read-only 트랜잭션·statement_timeout·계정 쓰기 제한 점검), Golden Query **결과 동등성 평가**(`/admin/text2sql/golden/run?execute=1` — 기대/생성 SQL을 read-only 실행해 행 집합 비교, 토큰 일치를 넘는 의미 검증), **shadow 모델 평가**(`TEXT2SQL_SHADOW_MODELS`·`TEXT2SQL_SHADOW_SAMPLE_RATE` — preview 샘플에서 후보 모델로 비동기 재생성해 모델별 품질 메트릭만 적립, 라이브 KPI 비오염)`r`n"
$notes += "- **Text2SQL 재현성·권한 안전성·DW 적재 신뢰성 강화 (`v0.3.4`)**: Text2SQL 감사 로그에 재현성 필드(schema_name·schema_version·permission_hash·glossary_hash) 추가 — 사후에 ``왜 그 SQL이 생성됐는지`` 당시 스키마·권한·용어사전 상태로 재현 가능. preview 캐시 키에 권한 효과·용어사전 해시를 포함해 **권한이 다른 사용자 간 SQL 재사용 방지**(cross-subject reuse 차단). ClickHouse Sink에 dimension별 watermark(`clickhouse_sink_state`)와 실패 재처리 큐(`clickhouse_sink_retry`) 도입 — 자동 적재 실패가 유실되지 않고 다음 주기/수동 재처리(`/admin/dw/sink-retry`)로 복구, 진행 상태는 `/admin/dw/sink-status` 로 조회`r`n"
$notes += "- **Text2SQL 백로그 완결 — 캐시·버전·민감도·샌드박스·재질문·품질 라우팅·위험 큐·용어사전 (`v0.3.3`)**: preview 결과 캐시(`text2sql_cache`, 질문·스키마·모드·스키마버전 키 + TTL, 스키마 변경 시 자동 무효화), 스키마 버전 관리(version/collected_at/source_fingerprint — 지문 변경 시 자동 증가), 민감도 정책 세분화(`approval_required` 차단 / `aggregate_only` 집계함수 내에서만 허용), 실행 샌드박스 강화(읽기 전용 트랜잭션 + `SET LOCAL statement_timeout`·`work_mem`), 자연어 재질문(clarification) 모드(모호·기간 누락 질문 게이트), 비용·품질 기반 업스트림 자동 선택(기본 모델 유효율 저하 시 정확 모델로 승격), 관리자 위험 요청 큐(`/admin/text2sql/risk-queue` — 거부·고위험 EXPLAIN·실패 분류), 업무 용어 사전(`text2sql_business_terms` — 자연어→SQL 매핑 프롬프트 주입) 추가`r`n"
$notes += "- **Text2SQL 권한·통제·DW 운영화 (`v0.3.2`)**: 권한 매트릭스(`text2sql_permissions` — 팀·API Key·사용자별 schema/table/column allow·deny), 검증기 식별자 추출 강화(quoted/schema-qualified), EXPLAIN 위험도 로그 저장(cost·risk_score), 실패 원인 표준 분류(syntax/permission/cost/timeout/unknown_column/empty), ClickHouse 자동 적재 스케줄러 + 정합성 검증(`/admin/dw/consistency`) 추가`r`n"
$notes += "- **Text2SQL 정확도·운영 통제 심화 (`v0.3.1`)**: 스키마 레지스트리 DB화(테이블/컬럼 + 업무 설명 + 민감도 normal/mask/exclude)와 팀·컬럼 단위 권한 필터, information_schema 자동 수집, 검증기 강화(문자열/주석 리터럴 스크럽), EXPLAIN 위험 점수화(seq scan·nested loop), 현업 친화 응답 포맷(해석/SQL/주의사항/실행여부/다음질문), Text2SQL 품질 평가 emit, Golden Query 자동 후보화, ClickHouse rollup sink(HTTP) 추가`r`n"
$notes += "- **Text2SQL 게이트웨이 및 로드맵 Part 2 완료 (`v0.3.0`)**: 사용자 계약 변경 없이(`/v1/chat/completions` 유지) `vibe/text2sql-*` 가상 모델을 통해 자연어→읽기전용 SQL을 생성하는 Text2SQL 파이프라인 신규 탑재 — 내부에서 실제 업스트림 모델 선택·SQL 검증(SELECT 전용·자동 LIMIT·테이블 권한)·EXPLAIN 비용 가드·결과 PII 마스킹·few-shot 골든쿼리·모델별 SQL 품질 메트릭·DB 스키마 카탈로그/런타임 프로필. 더불어 정책 시뮬레이터(차단 예상 미리보기), 모델 가격표 버전 이력+자동 시드, Mattermost 알림 연계, 팀별 예산 소진 예측, 프롬프트 템플릿 마켓 추가`r`n"
$notes += "- **로드맵 Part 1 완료 및 엔터프라이즈 거버넌스 대대적 확장 (`v0.2.0`)**: Explicit PipelineStep 리팩토링, Ops Health 대시보드 및 주간 AI 리포트 생성, 다차원 비용 할당(Repo/Branch/Project/Service/Cost-Center), CI용 골든 프롬프트 회귀 테스트 게이트, 프롬프트 인젝션 탐지 및 MCP 도구 위험등급 분류, 프로바이더 SLO 모니터링, 월말 비용 예측 및 Operational Risk Score 산출, 폐루프 자동 라우팅 강화 학습, DW 롤업 스태이징 탑재`r`n"
$notes += "- **영속적 세션 추론 및 위임 거버넌스 (`v0.1.26~v0.1.27`)**: 재기동에 안전한 세션 영속 추론 테이블 `inferred_sessions` 추가 및 자동 GC 탑재, team_admin 소속팀 API Key 한정 필터링 조회, 권한 상승(Privilege Escalation) 방지를 위한 계층형 롤/스코프 위임 거버넌스 구현 및 종합 기술 보고서 갱신`r`n"
$notes += "- **사용자 팀 매핑 및 API Key 영구 폐기 관리 (`v0.1.25`)**: 관리자 목록 내 소속 팀 정보 연동 및 패치를 통한 소속 팀 수정·탈퇴 지원, API Key의 개별 세부 권한을 어드민 UI에서 팝업으로 조절 가능한 스코프 편집기 연동, super_admin 한정 키 영구 삭제(?hard=1) 정책 도입`r`n"
$notes += "- **지능형 라우팅 및 기본 권한 보강 (`v0.1.24`)**: 클라이언트 고정(Pinned) 환경에서의 auto/auto-reasoning 모델명 rewrite 지원, PROXY_API_KEYS 및 신규 API Key 생성 시 scopes 미지정인 경우 기본 역할별 권한 자동 상속, /v1/models 익명 조회 허용`r`n"
$notes += "- **API Key 호환성 해결 (`v0.1.23`)**: AUTH_ENABLED 활성화 환경에서 기존에 스코프가 부여되지 않은 채 생성되었던 API Key들의 차단 현상(scope_denied)을 해결하고, 자동 스코프 채움 마이그레이션 적용`r`n"
$notes += "- **자동화 성능 벤치마킹 모듈 탑재 (`v0.1.22`)**: TTFT, TPS, 가속지연 등의 메트릭을 자동 측정하고 관리자 페이지에 실시간 반영 및 연동`r`n"
$notes += "- **종합 환경변수 스펙 완비 (`v0.1.21`)**: 부트스트랩 계정 정보(AUTH_ADMIN_BOOTSTRAP_*) 및 DB 폴백 DSN 등 누락되었던 42종의 시스템 설정 변수 표준화 가이드 완료`r`n"
$notes += "- **지능형 라우팅 및 다중 인증 체계 (`v0.1.19~v0.1.20`)**: 서버 상태 기반 Intelligent Routing, 다중 JWT 인증, 거버넌스 룰 엔진 탑재`r`n"
$notes += "- **VCS(Git) 비동기 역추론 엔진 완성 (`v0.1.17~v0.1.18`)**: 오프라인 제약 속 LLM 대화 트래픽에서 Git 커밋/푸시 이벤트를 추적하는 타임라인 맵 구성`r`n"
$notes += "- **3계층 세션 및 RAG 지식 베이스 연동 (`v0.1.13~v0.1.14`)**: Work-Task-Request 3단계 세션 추론 모델링 및 RAG용 KB/MCP 업스트림 기능 제공`r`n"
$notes += "- **XView 분산 산점도 및 이상 비용 탐지 (`v0.1.9~v0.1.12`)**: 대화 맥락 복잡도, 실시간 트랜잭션 APM 가시성 극대화 및 지연 요인 설명(Explain) 모달 제공`r`n"
$notes += "- **데이터베이스 엔터프라이즈 마이그레이션 (`v0.1.5~v0.1.8`)**: SQLite에서 PostgreSQL로의 무결성 마이그레이션, 42803 에러 수정 및 자동 타입 변환 패치`r`n`r`n"
$notes += "### 배포 파일`r`n"
$notes += "| 파일 | 설명 |`r`n"
$notes += "|------|------|`r`n"
$notes += "| ai-coding-proxy-gateway-v" + $cleanVer + ".tar.gz | Docker 이미지 패키지 (linux/amd64) |`r`n"
$notes += "| ai-coding-proxy-gateway-v" + $cleanVer + ".tar.gz.sha256 | SHA256 체크섬 |`r`n"
$notes += "| README-offline-v" + $cleanVer + ".md | 오프라인 배포 가이드 |`r`n"
$notes += "| AI_Proxy_Gateway_Report.pdf | AI Proxy Gateway 기능·역할 및 비즈니스 가치 종합 보고서 (v0.7.2) |`r`n`r`n"
$notes += "### 빠른 시작`r`n"
$notes += "```bash`r`n"
$notes += "# 이미지 로드`r`n"
$notes += "gunzip -c ai-coding-proxy-gateway-" + $Version + ".tar.gz | docker load`r`n`n"
$notes += "# 실행`r`n"
$notes += "docker run -d --name proxy-gateway --restart=always \`r`n"
$notes += "  -p 8080:8080 \`r`n"
$notes += "  -v /opt/proxy-gateway/data:/data \`n"
$notes += "  -e UPSTREAM_BASE_URL=https://api.openai.com \`n"
$notes += "  -e UPSTREAM_API_KEY=sk-... \`n"
$notes += "  -e ADMIN_TOKEN=change-me \`n"
$notes += "  ai-coding-proxy-gateway:" + $Version + "`r`n"
$notes += '```'

$notesPath = Join-Path $repoRoot "release\release-notes.txt"
Set-Content -Path $notesPath -Value $notes -Encoding utf8

gh release create $Version "release\ai-coding-proxy-gateway-$Version.tar.gz" "release\ai-coding-proxy-gateway-$Version.tar.gz.sha256" "release\README-offline-$Version.md" "release\AI_Proxy_Gateway_Report.pdf" --repo hkjang/vibe-coders --title "$Version - AI Proxy Gateway" --notes-file $notesPath

Remove-Item $notesPath -ErrorAction SilentlyContinue

