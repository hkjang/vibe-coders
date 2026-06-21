package proxy

import (
	"encoding/json"
	"net/http"
	"strings"

	"vibe-coders/internal/store"
)

// appTemplate is a curated starter pattern for an AI work app. Code-defined (like the capability
// registry) — instantiating one creates a real, editable WorkApp from its components.
type appTemplate struct {
	Key         string               `json:"key"`
	Title       string               `json:"title"`
	Description string               `json:"description"`
	Icon        string               `json:"icon"`
	Category    string               `json:"category"`
	Components  []store.AppComponent `json:"components"`
}

// appTemplateCatalog are the built-in work-app starter templates. Components reference building
// blocks by conventional name; after instantiation the admin edits refs to match their deployment.
var appTemplateCatalog = []appTemplate{
	{
		Key: "code-review", Title: "코드 리뷰 어시스턴트", Icon: "🔍", Category: "개발",
		Description: "PR/디프를 표준 기준으로 리뷰하고 위험·개선점을 요약하는 업무 앱.",
		Components: []store.AppComponent{
			{Kind: "skill", Ref: "code-review", Label: "코드 리뷰 Skill"},
			{Kind: "model", Ref: "", Label: "추천 모델(코딩 품질 상위)"},
			{Kind: "prompt_product", Ref: "", Label: "리뷰 체크리스트 프롬프트"},
		},
	},
	{
		Key: "data-insight", Title: "데이터 질의 콘솔", Icon: "📊", Category: "데이터",
		Description: "자연어로 질문하면 검증된 SQL로 사내 데이터를 조회하는 업무 앱.",
		Components: []store.AppComponent{
			{Kind: "text2sql_report", Ref: "", Label: "자주 쓰는 저장 리포트"},
			{Kind: "skill", Ref: "", Label: "데이터 요약 Skill"},
		},
	},
	{
		Key: "doc-drafting", Title: "문서 작성 도우미", Icon: "📝", Category: "생산성",
		Description: "보고서·공지·릴리즈 노트를 사내 톤으로 초안 작성하는 업무 앱.",
		Components: []store.AppComponent{
			{Kind: "prompt_product", Ref: "", Label: "문서 템플릿 프롬프트"},
			{Kind: "model", Ref: "", Label: "추천 모델(작문)"},
		},
	},
	{
		Key: "incident-triage", Title: "장애 분류 어시스턴트", Icon: "🚨", Category: "운영",
		Description: "장애 신호를 모아 원인 후보와 조치를 제안하는 운영 업무 앱.",
		Components: []store.AppComponent{
			{Kind: "skill", Ref: "", Label: "로그 분석 Skill"},
			{Kind: "mcp_tool", Ref: "", Label: "운영 조회 MCP 도구"},
		},
	},
	{
		Key: "pr-summary", Title: "PR 요약·릴리즈 노트", Icon: "🧾", Category: "개발",
		Description: "머지된 변경을 모아 릴리즈 노트와 변경 요약을 생성하는 업무 앱.",
		Components: []store.AppComponent{
			{Kind: "prompt_product", Ref: "", Label: "릴리즈 노트 프롬프트"},
			{Kind: "skill", Ref: "", Label: "변경 요약 Skill"},
		},
	},
}

// handleAppTemplates lists the built-in app template catalog. GET /admin/app-templates
func (s *Server) handleAppTemplates(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"templates": appTemplateCatalog,
		"note":      "내장 업무 앱 시작 템플릿입니다. instantiate로 편집 가능한 AI 업무 앱을 생성한 뒤 구성 요소의 ref를 환경에 맞게 지정하세요.",
	})
}

// handleAppTemplateInstantiate creates a WorkApp from a catalog template (status=active so it
// shows up immediately; the admin then edits component refs). POST /admin/app-templates/instantiate
// {key, title?, allowed_teams?, allowed_roles?}
func (s *Server) handleAppTemplateInstantiate(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		Key          string `json:"key"`
		Title        string `json:"title"`
		AllowedTeams string `json:"allowed_teams"`
		AllowedRoles string `json:"allowed_roles"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	tpl := findAppTemplate(strings.TrimSpace(p.Key))
	if tpl == nil {
		writeOpenAIError(w, http.StatusNotFound, "template not found", "invalid_request_error", "not_found")
		return
	}
	app := store.WorkApp{
		ID: newID("app"), Title: firstNonEmpty(strings.TrimSpace(p.Title), tpl.Title),
		Description: tpl.Description, Icon: tpl.Icon, Components: tpl.Components,
		AllowedTeams: strings.TrimSpace(p.AllowedTeams), AllowedRoles: strings.TrimSpace(p.AllowedRoles),
		Status: "active", Owner: adminID(r),
	}
	if err := s.db.CreateWorkApp(r.Context(), app); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "create_failed")
		return
	}
	s.auditAdmin(r, "app_template_instantiate", tpl.Key, auditJSON(map[string]any{"app_id": app.ID, "title": app.Title}))
	writeJSON(w, http.StatusCreated, map[string]any{"app_id": app.ID, "template": tpl.Key,
		"note": "업무 앱이 생성되었습니다. AI 업무 앱 화면에서 구성 요소 ref를 환경에 맞게 편집하세요."})
}

func findAppTemplate(key string) *appTemplate {
	for i := range appTemplateCatalog {
		if appTemplateCatalog[i].Key == key {
			return &appTemplateCatalog[i]
		}
	}
	return nil
}
