package proxy

import (
	"net/http"
	"strings"
)

// Capability is a curated catalog entry describing one major gateway feature and everything
// it touches — APIs, UI tabs, scopes, runtime setting keys, DB tables, background workers, and
// docs. It is the "map" that lets a new operator/developer understand where a feature lives.
//
// This is intentionally a code-defined registry (not a DB table): it is static system metadata
// that ships with the binary and is kept honest by living next to the code it describes.
type Capability struct {
	Key         string   `json:"key"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Group       string   `json:"group"`
	APIs        []string `json:"apis"`
	UITabs      []string `json:"ui_tabs"`
	Scopes      []string `json:"scopes"`
	SettingKeys []string `json:"setting_keys"`
	Tables      []string `json:"tables"`
	Workers     []string `json:"workers"`
	Docs        []string `json:"docs"`
}

// capabilityRegistry is the ordered catalog of gateway capabilities.
var capabilityRegistry = []Capability{
	{
		Key: "chat_proxy", Name: "Chat 프록시", Group: "core",
		Description: "OpenAI 호환 채팅/모델/임베딩 중계 + 사용량·토큰·비용 추적.",
		APIs:        []string{"POST /v1/chat/completions", "GET /v1/models", "POST /v1/embeddings"},
		UITabs:      []string{"requests", "llm", "chat-test"},
		Scopes:      []string{"admin:read"},
		Tables:      []string{"request_logs", "token_usage", "prompt_logs", "response_logs"},
		Workers:     []string{"async_logger"},
	},
	{
		Key: "routing", Name: "라우팅", Group: "core",
		Description: "vibe/auto 등 가상 모델의 복잡도·위험·헬스 기반 업스트림 선택 + 학습 루프.",
		APIs:        []string{"GET /admin/routing/decisions", "GET /admin/routing/health"},
		UITabs:      []string{"routing"},
		Scopes:      []string{"admin:read"},
		Tables:      []string{"routing_decisions"},
	},
	{
		Key: "mcp_gateway", Name: "MCP Gateway", Group: "core",
		Description: "단일 /mcp로 여러 MCP 업스트림 통합 + vibe/grounded·research·all-mcp agentic discovery.",
		APIs:        []string{"POST /mcp", "GET /admin/mcp/agentic-runs"},
		UITabs:      []string{"mcp"},
		Scopes:      []string{"admin:read"},
		Tables:      []string{"tool_invocations", "mcp_route_decisions", "domain_routing_decisions", "domain_routing_signals"},
	},
	{
		Key: "text2sql", Name: "Text2SQL", Group: "data",
		Description: "vibe/text2sql-* 가상 모델: 자연어→SQL 생성·검증·실행·마스킹·골든·위험 큐.",
		APIs:        []string{"POST /v1/chat/completions (vibe/text2sql-*)", "GET /admin/text2sql/*"},
		UITabs:      []string{"text2sql"},
		Scopes:      []string{"admin:read"},
		SettingKeys: []string{"text2sql.*"},
		Tables:      []string{"text2sql_query_logs", "text2sql_saved_reports", "text2sql_permissions", "text2sql_spans"},
		Workers:     []string{"text2sql_report_scheduler"},
	},
	{
		Key: "governance", Name: "거버넌스", Group: "security",
		Description: "정책 결정, 시크릿 탐지, 승인 큐, 이상 탐지 — 요청 단위 차단/경고/승인.",
		APIs:        []string{"GET /admin/governance/*", "POST /admin/policies/*"},
		UITabs:      []string{"safety", "security"},
		Scopes:      []string{"security:read"},
		Tables:      []string{"policy_decisions", "secret_events", "approvals", "anomaly_events"},
	},
	{
		Key: "skill_studio", Name: "Skill Studio", Group: "assets",
		Description: "Skill 등록·정책 enforce·보안 스캔·승격 게이트(모델 적합성 포함)·후보 추천.",
		APIs:        []string{"GET/POST /admin/skills", "POST /admin/skills/promote", "GET /admin/skill-studio/readiness", "GET/POST /admin/skills/fitness"},
		UITabs:      []string{"skills", "skill-studio"},
		Scopes:      []string{"admin:read"},
		Tables:      []string{"skills", "skill_runs", "skill_promotions", "skill_fitness_evidence"},
	},
	{
		Key: "prompt_assets", Name: "프롬프트 자산", Group: "assets",
		Description: "프롬프트 템플릿·버전·A/B·골든 연결·상품(Prompt Product)·자산 관리소.",
		APIs:        []string{"GET/POST /admin/prompt-templates", "GET /admin/prompt-products"},
		UITabs:      []string{"prompts", "prompt-assets"},
		Scopes:      []string{"admin:read"},
		Tables:      []string{"prompt_templates", "prompt_template_history", "prompt_products"},
	},
	{
		Key: "prompt_lab", Name: "Prompt Lab", Group: "assets",
		Description: "실험·테스트케이스·출력계약·rubric로 프롬프트를 재사용 가능한 검증 자산으로 전환.",
		APIs:        []string{"GET/POST /admin/prompt-lab/experiments", "POST /admin/prompt-lab/test-cases/{id}/run"},
		UITabs:      []string{"prompt-lab"},
		Scopes:      []string{"admin:read"},
		Tables:      []string{"prompt_experiments", "prompt_test_cases", "prompt_rubrics", "prompt_contracts", "prompt_test_case_runs"},
	},
	{
		Key: "multimodel_console", Name: "멀티 모델 콘솔", Group: "assets",
		Description: "동일 프롬프트 N개 모델 병렬 비교·Diff·rubric 자동평가·Golden 승격·리더보드.",
		APIs:        []string{"POST /admin/chat-test/multi-run", "POST .../judge", "GET .../runs/{id}/diff", "GET .../leaderboard"},
		UITabs:      []string{"chat-test"},
		Scopes:      []string{"admin:read"},
		Tables:      []string{"multi_model_test_runs", "multi_model_test_results", "multi_model_test_judgements", "model_usage_tags"},
	},
	{
		Key: "clickhouse_dw", Name: "ClickHouse DW", Group: "data",
		Description: "요청·tool·routing·eval·feedback·policy·skill·multimodel fact 적재 + 지표 사전.",
		APIs:        []string{"GET /admin/dw/*", "GET/POST /admin/dw/metrics"},
		UITabs:      []string{"dwdashboard", "dwmetrics"},
		Scopes:      []string{"admin:read"},
		SettingKeys: []string{"clickhouse.*"},
		Tables:      []string{"metric_catalog", "clickhouse_fact_retry", "clickhouse_sink_state"},
		Workers:     []string{"clickhouse_fact_queue", "clickhouse_sink", "clickhouse_fact_retry"},
	},
	{
		Key: "okf", Name: "OKF 지식", Group: "data",
		Description: "조직 지식 프레임(Org Knowledge Frame): Text2SQL/게이트웨이 지식 주입 + 자기개선 루프.",
		APIs:        []string{"GET/POST /admin/okf/*"},
		UITabs:      []string{"okf"},
		Scopes:      []string{"admin:read"},
		Tables:      []string{"okf_frames", "okf_entries"},
	},
	{
		Key: "personalization", Name: "개인화", Group: "users",
		Description: "Personal AI Profile·My AI Home·추천·모델/MCP affinity·코칭·내 추천 모델.",
		APIs:        []string{"GET /me/dashboard", "GET /me/recommended-models", "GET /me/report", "GET /admin/personalization/*"},
		UITabs:      []string{"me", "personalization"},
		Scopes:      []string{"self"},
		Tables:      []string{"personal_profiles", "personalization_recommendations"},
	},
	{
		Key: "work_apps", Name: "AI 업무 앱", Group: "users",
		Description: "Skill·프롬프트 상품·Text2SQL 리포트·MCP·추천 모델을 묶은 사용자용 업무 앱.",
		APIs:        []string{"GET/POST /admin/apps", "GET /v1/apps", "POST /v1/apps/{id}/run"},
		UITabs:      []string{"apps"},
		Scopes:      []string{"admin:read"},
		Tables:      []string{"work_apps"},
	},
	{
		Key: "runtime_settings", Name: "런타임 설정", Group: "ops",
		Description: "env 위에 admin 오버레이로 런타임 설정·역할별 권한·import/export·effective view·Change Set.",
		APIs:        []string{"GET/PUT /admin/settings", "POST /admin/settings/bulk", "GET/POST /admin/change-sets"},
		UITabs:      []string{"settings", "runtimesettings", "changesets"},
		Scopes:      []string{"admin:write"},
		Tables:      []string{"admin_settings", "admin_settings_history", "change_sets"},
	},
	{
		Key: "sso", Name: "Keycloak SSO", Group: "security",
		Description: "OIDC Auth Code+PKCE 로그인·API Bearer·back/front-channel logout·DB provider config·role 매핑.",
		APIs:        []string{"GET /auth/keycloak/login", "GET /auth/keycloak/callback", "GET/PUT /admin/sso/keycloak/config"},
		UITabs:      []string{"settings"},
		Scopes:      []string{"admin:write"},
		SettingKeys: []string{"SSO_KEYCLOAK_*"},
		Tables:      []string{"auth_identities", "sso_provider_config", "auth_sessions"},
	},
	{
		Key: "ops_visibility", Name: "운영 가시성", Group: "ops",
		Description: "Flow Map·MCP Agentic Timeline·운영 홈·워커 상태판으로 요청·워커·우선순위를 한눈에.",
		APIs:        []string{"GET /admin/flow-map", "GET /admin/ops/home", "GET /admin/ops/workers", "GET /admin/capabilities"},
		UITabs:      []string{"ops-home"},
		Scopes:      []string{"admin:read"},
	},
}

// handleCapabilities lists the capability catalog. GET /admin/capabilities
func (s *Server) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	// Group counts for the UI.
	groups := map[string]int{}
	for _, c := range capabilityRegistry {
		groups[c.Group]++
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"capabilities": capabilityRegistry,
		"count":        len(capabilityRegistry),
		"groups":       groups,
		"note":         "코드 정의 레지스트리(시스템 메타데이터). 기능 추가 시 capabilities.go에 항목을 더하세요.",
	})
}

// handleCapabilityByKey returns one capability. GET /admin/capabilities/{key}
func (s *Server) handleCapabilityByKey(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	key := strings.TrimPrefix(r.URL.Path, "/admin/capabilities/")
	for _, c := range capabilityRegistry {
		if c.Key == key {
			writeJSON(w, http.StatusOK, c)
			return
		}
	}
	writeOpenAIError(w, http.StatusNotFound, "capability not found: "+key, "invalid_request_error", "not_found")
}
