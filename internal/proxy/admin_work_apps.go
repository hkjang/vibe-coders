package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// validateAppComponent resolves one component reference, returning whether it exists + a detail
// note + any allowed models it contributes.
func (s *Server) validateAppComponent(r *http.Request, c store.AppComponent) (bool, string, []string) {
	ref := strings.TrimSpace(c.Ref)
	switch c.Kind {
	case "skill":
		sk, found, _ := s.db.GetSkill(r.Context(), ref)
		if !found {
			return false, "스킬을 찾을 수 없음: " + ref, nil
		}
		models := []string{}
		if strings.TrimSpace(sk.AllowedModels) != "" {
			for _, m := range strings.Split(sk.AllowedModels, ",") {
				if m = strings.TrimSpace(m); m != "" {
					models = append(models, m)
				}
			}
		}
		return true, "스킬 상태=" + sk.Status, models
	case "text2sql_report":
		_, found, _ := s.db.GetText2SQLSavedReport(r.Context(), ref)
		if !found {
			return false, "저장 리포트를 찾을 수 없음: " + ref, nil
		}
		return true, "Text2SQL 저장 리포트", nil
	case "prompt_product":
		if list, err := s.db.ListPromptProducts(r.Context()); err == nil {
			for _, p := range list {
				if p.ID == ref || p.Name == ref {
					return true, "프롬프트 상품", nil
				}
			}
		}
		return false, "프롬프트 상품을 찾을 수 없음: " + ref, nil
	case "model":
		return true, "추천 모델", []string{ref}
	case "mcp_tool":
		return true, "MCP 도구(런타임 검증)", nil
	default:
		return false, "알 수 없는 컴포넌트 종류: " + c.Kind, nil
	}
}

// handleAdminApps lists or creates AI work apps. GET/POST /admin/apps
func (s *Server) handleAdminApps(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		apps, err := s.db.ListWorkApps(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"apps": apps})
	case http.MethodPost:
		var p store.WorkApp
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil || strings.TrimSpace(p.Title) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "title is required", "invalid_request_error", "bad_request")
			return
		}
		p.ID = newID("app")
		p.Owner = s.skillActor(r)
		if p.Components == nil {
			p.Components = []store.AppComponent{}
		}
		if err := s.db.CreateWorkApp(r.Context(), p); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "create_failed")
			return
		}
		s.auditAdmin(r, "work_app.create", p.ID, auditJSON(map[string]any{"title": p.Title, "components": len(p.Components)}))
		writeJSON(w, http.StatusCreated, p)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleAdminAppByID serves GET/PATCH/DELETE /admin/apps/{id} and POST /admin/apps/{id}/validate.
func (s *Server) handleAdminAppByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/admin/apps/")
	id, action := rest, ""
	if idx := strings.Index(rest, "/"); idx >= 0 {
		id, action = rest[:idx], rest[idx+1:]
	}
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "app id required", "invalid_request_error", "bad_request")
		return
	}
	app, found, err := s.db.GetWorkApp(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "get_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "app not found", "invalid_request_error", "not_found")
		return
	}
	if action == "validate" && r.Method == http.MethodPost {
		s.handleAppValidate(w, r, app)
		return
	}
	// Lifecycle: publish (snapshot a version + make active) / deprecate (hide) / versions (history).
	if action == "publish" && r.Method == http.MethodPost {
		var p struct {
			Note string `json:"note"`
		}
		_ = json.NewDecoder(r.Body).Decode(&p)
		version, err := s.db.PublishWorkAppVersion(r.Context(), app, adminID(r), strings.TrimSpace(p.Note))
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "publish_failed")
			return
		}
		s.auditAdmin(r, "work_app.publish", id, auditJSON(map[string]any{"version": version}))
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "version": version, "status": "active", "published": true})
		return
	}
	if action == "deprecate" && r.Method == http.MethodPost {
		app.Status = "archived"
		if err := s.db.UpdateWorkApp(r.Context(), app); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "deprecate_failed")
			return
		}
		s.auditAdmin(r, "work_app.deprecate", id, "")
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": "archived", "deprecated": true})
		return
	}
	if action == "versions" && r.Method == http.MethodGet {
		versions, err := s.db.ListWorkAppVersions(r.Context(), id)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "versions_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"app_id": id, "versions": versions})
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, app)
	case http.MethodPatch, http.MethodPut:
		var p store.WorkApp
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "bad_request")
			return
		}
		// Preserve identity/owner; overlay editable fields.
		p.ID = app.ID
		p.Owner = app.Owner
		if strings.TrimSpace(p.Title) == "" {
			p.Title = app.Title
		}
		if p.Status == "" {
			p.Status = app.Status
		}
		if p.Components == nil {
			p.Components = app.Components
		}
		if err := s.db.UpdateWorkApp(r.Context(), p); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "update_failed")
			return
		}
		writeJSON(w, http.StatusOK, p)
	case http.MethodDelete:
		if err := s.db.DeleteWorkApp(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "delete_failed")
			return
		}
		s.auditAdmin(r, "work_app.delete", id, "")
		writeJSON(w, http.StatusOK, map[string]any{"status": "deleted"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleAppValidate checks an app's component references, permissions, and collects the union
// of allowed models. POST /admin/apps/{id}/validate
func (s *Server) handleAppValidate(w http.ResponseWriter, r *http.Request, app store.WorkApp) {
	checks := []map[string]any{}
	allModels := map[string]bool{}
	allOK := true
	for _, c := range app.Components {
		ok, detail, models := s.validateAppComponent(r, c)
		if !ok {
			allOK = false
		}
		for _, m := range models {
			allModels[m] = true
		}
		checks = append(checks, map[string]any{"kind": c.Kind, "ref": c.Ref, "label": c.Label, "resolved": ok, "detail": detail})
	}
	models := make([]string, 0, len(allModels))
	for m := range allModels {
		models = append(models, m)
	}
	warnings := []string{}
	if len(app.Components) == 0 {
		warnings = append(warnings, "컴포넌트가 없습니다")
	}
	if strings.TrimSpace(app.AllowedTeams) == "" && strings.TrimSpace(app.AllowedRoles) == "" {
		warnings = append(warnings, "팀/역할 제한이 없어 모든 사용자에게 노출됩니다")
	}
	s.auditAdmin(r, "work_app.validate", app.ID, auditJSON(map[string]any{"ok": allOK}))
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": allOK, "checks": checks, "allowed_models": models, "warnings": warnings,
	})
}

// appVisibleTo reports whether a caller may see/run an app, given its team/role gates. Admins
// (admin:read) always see all apps.
func appVisibleTo(app store.WorkApp, claims accessClaims) bool {
	if app.Status != "active" && !hasScope(claims.Scopes, "admin:read") {
		return false
	}
	if hasScope(claims.Scopes, "admin:read") {
		return true
	}
	if teams := splitCSV(app.AllowedTeams); len(teams) > 0 {
		if !containsFold(teams, claims.TeamID) {
			return false
		}
	}
	if roles := splitCSV(app.AllowedRoles); len(roles) > 0 {
		if !containsFold(roles, claims.Role) {
			return false
		}
	}
	return true
}

func splitCSV(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func containsFold(list []string, v string) bool {
	for _, x := range list {
		if strings.EqualFold(x, v) {
			return true
		}
	}
	return false
}

// handleUserApps lists the AI work apps the caller may run (team/role-filtered). GET /v1/apps
func (s *Server) handleUserApps(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.currentAccessClaims(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	all, err := s.db.ListWorkApps(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
		return
	}
	visible := []store.WorkApp{}
	for _, a := range all {
		if appVisibleTo(a, claims) {
			visible = append(visible, a)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"apps": visible})
}

// handleUserAppByID returns one app's detail (with resolved components) if the caller may see
// it. GET /v1/apps/{id}
func (s *Server) handleUserAppByID(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.currentAccessClaims(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/v1/apps/")
	id, action := rest, ""
	if idx := strings.Index(rest, "/"); idx >= 0 {
		id, action = rest[:idx], rest[idx+1:]
	}
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "app id required", "invalid_request_error", "bad_request")
		return
	}
	app, found, err := s.db.GetWorkApp(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "get_failed")
		return
	}
	if !found || !appVisibleTo(app, claims) {
		writeOpenAIError(w, http.StatusNotFound, "app not found", "invalid_request_error", "not_found")
		return
	}
	if action == "run" && r.Method == http.MethodPost {
		s.handleUserAppRun(w, r, app, claims)
		return
	}
	if action != "" {
		writeOpenAIError(w, http.StatusNotFound, "unknown action", "invalid_request_error", "not_found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"app": app})
}

// appComponentStep maps one component to a concrete next action the caller can take.
func appComponentStep(c store.AppComponent) map[string]any {
	step := map[string]any{"kind": c.Kind, "ref": c.Ref, "label": c.Label}
	switch c.Kind {
	case "skill":
		step["action"] = "chat"
		step["endpoint"] = "/v1/chat/completions"
		step["hint"] = "X-Skill: " + c.Ref + " 헤더로 채팅 호출"
	case "prompt_product":
		step["action"] = "chat"
		step["endpoint"] = "/v1/chat/completions"
		step["hint"] = "프롬프트 상품 템플릿으로 채팅"
	case "text2sql_report":
		step["action"] = "text2sql_report"
		step["endpoint"] = "/admin/text2sql/saved-reports/" + c.Ref
		step["hint"] = "저장된 Text2SQL 리포트 실행"
	case "mcp_tool":
		step["action"] = "mcp"
		step["hint"] = "MCP 가상 모델(vibe/grounded 등)로 도구 호출"
	case "model":
		step["action"] = "model"
		step["hint"] = "추천 모델: " + c.Ref
	default:
		step["action"] = "unknown"
	}
	return step
}

// handleUserAppRun returns a validated execution plan for an app — resolved components mapped to
// the endpoint each one is invoked through. (Heterogeneous server-side execution is a follow-up;
// this gives the caller an actionable, permission-checked plan and records the run.)
// POST /v1/apps/{id}/run
func (s *Server) handleUserAppRun(w http.ResponseWriter, r *http.Request, app store.WorkApp, claims accessClaims) {
	if len(app.Components) == 0 {
		writeOpenAIError(w, http.StatusUnprocessableEntity, "app has no components to run", "invalid_request_error", "empty_app")
		return
	}
	start := time.Now()
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	plan := make([]map[string]any, 0, len(app.Components))
	allResolved := true
	for _, c := range app.Components {
		ok, detail, _ := s.validateAppComponent(r, c)
		if !ok {
			allResolved = false
		}
		step := appComponentStep(c)
		step["resolved"] = ok
		step["detail"] = detail
		plan = append(plan, step)
	}
	// Persist the run with safe metadata only (input hashed, no raw input/output stored).
	status := "planned"
	errClass := ""
	if !allResolved {
		errClass = "component_unresolved"
	}
	runID := newID("apprun")
	inputHash := ""
	if len(body) > 0 {
		inputHash = audit.HashText(string(body))
	}
	_ = s.db.RecordAIAppRun(r.Context(), store.AIAppRun{
		ID: runID, AppID: app.ID, UserID: claims.Subject, Team: claims.TeamID, Status: status,
		InputHash: inputHash, OutputSummary: itoaProxy(len(app.Components)) + " components planned", ErrorClass: errClass,
		LatencyMS: time.Since(start).Milliseconds(),
	})
	s.auditAuthEvent(r.Context(), "work_app_run", claims.Subject, "", claims.TeamID, "app="+app.ID)
	writeJSON(w, http.StatusOK, map[string]any{
		"run_id": runID, "app_id": app.ID, "title": app.Title, "status": status, "plan": plan,
		"note": "각 step의 endpoint로 호출해 앱을 실행하세요. 실행 이력은 /me/app-runs에서 확인할 수 있습니다.",
	})
}

// handleMyAppRuns lists the caller's own AI work-app run history (safe metadata only).
// GET /me/app-runs[?app_id=&limit=]
func (s *Server) handleMyAppRuns(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.meUserID(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	runs, err := s.db.ListAIAppRuns(r.Context(), userID, strings.TrimSpace(r.URL.Query().Get("app_id")), intQuery(r, "limit", 50))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": runs})
}
