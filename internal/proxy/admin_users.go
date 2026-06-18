package proxy

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// teamNameByID maps auth team IDs to their display names. API keys store a team identifier
// (self-service keys carry the user's team ID, e.g. "team_security"); this lets the UI show
// the friendly name ("Security") while keeping the ID for links/filtering. Free-form team
// strings with no matching auth team are simply absent from the map.
func (s *Server) teamNameByID(r *http.Request) map[string]string {
	out := map[string]string{}
	teams, err := s.db.ListAuthTeams(r.Context())
	if err != nil {
		return out
	}
	for _, t := range teams {
		if strings.TrimSpace(t.Name) != "" {
			out[t.ID] = t.Name
		}
	}
	return out
}

func (s *Server) handleUsers(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		users, err := s.db.ListUsers(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "users_failed")
			return
		}
		if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" {
			filtered := users[:0]
			for _, u := range users {
				if u.Team == claims.TeamID {
					filtered = append(filtered, u)
				}
			}
			users = filtered
		}
		authUsers, _ := s.db.ListAuthUsers(r.Context())
		enriched := make([]map[string]any, 0, len(authUsers))
		for _, u := range authUsers {
			teamID, _ := s.db.PrimaryTeamForUser(r.Context(), u.ID)
			if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" && teamID != claims.TeamID {
				continue
			}
			enriched = append(enriched, map[string]any{
				"id": u.ID, "email": u.Email, "name": u.Name, "role": u.Role,
				"status": u.Status, "team_id": teamID, "created_at": u.CreatedAt,
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"users": users, "auth_users": enriched, "team_names": s.teamNameByID(r)})
	case http.MethodPost:
		var p struct {
			Email    string `json:"email"`
			Password string `json:"password"`
			Name     string `json:"name"`
			Role     string `json:"role"`
			TeamID   string `json:"team_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		email := strings.ToLower(strings.TrimSpace(p.Email))
		if email == "" || p.Password == "" {
			writeOpenAIError(w, http.StatusBadRequest, "email and password are required", "invalid_request_error", "missing_user_fields")
			return
		}
		role := strings.TrimSpace(p.Role)
		if role == "" {
			role = "developer"
		}
		if !validRole(role) {
			writeOpenAIError(w, http.StatusBadRequest, "invalid role", "invalid_request_error", "invalid_role")
			return
		}
		if !s.canAssignRole(r, role) {
			s.auditAuthEvent(r.Context(), "role_denied", "", "", "", "create user role "+role)
			writeOpenAIError(w, http.StatusForbidden, "cannot assign role at or above your role", "permission_error", "role_escalation_denied")
			return
		}
		teamID := strings.TrimSpace(p.TeamID)
		if teamID != "" {
			team, found, terr := s.db.AuthTeamByIDOrName(r.Context(), teamID)
			if terr != nil || !found {
				writeOpenAIError(w, http.StatusBadRequest, "unknown team", "invalid_request_error", "unknown_team")
				return
			}
			teamID = team.ID
		}
		if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" {
			if teamID == "" || teamID != claims.TeamID {
				writeOpenAIError(w, http.StatusForbidden, "team_admin can only manage own team", "permission_error", "team_scope_denied")
				return
			}
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(p.Password), bcrypt.DefaultCost)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "password_hash_failed")
			return
		}
		user := store.AuthUser{
			ID:           "usr_" + audit.HashText(email)[:16],
			Email:        email,
			PasswordHash: string(hash),
			Name:         strings.TrimSpace(p.Name),
			Role:         role,
			Status:       "active",
		}
		if err := s.db.CreateAuthUser(r.Context(), user); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "user_create_failed")
			return
		}
		if teamID != "" {
			_ = s.db.UpsertMembership(r.Context(), store.UserTeamMembership{UserID: user.ID, TeamID: teamID, Role: role, CreatedAt: time.Now().UTC()})
		}
		if role != "" {
			_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "role_changed", ActorUserID: user.ID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: role, CreatedAt: time.Now().UTC()})
		}
		writeJSON(w, http.StatusCreated, map[string]any{"user": user})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleTeams(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		teams, err := s.db.ListTeams(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "teams_failed")
			return
		}
		authTeams, _ := s.db.ListAuthTeams(r.Context())
		if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" {
			filteredTeams := teams[:0]
			for _, team := range teams {
				if s.claimsTeamMatches(r, claims, team.Team) {
					filteredTeams = append(filteredTeams, team)
				}
			}
			teams = filteredTeams
			filteredAuthTeams := authTeams[:0]
			for _, team := range authTeams {
				if team.ID == claims.TeamID {
					filteredAuthTeams = append(filteredAuthTeams, team)
				}
			}
			authTeams = filteredAuthTeams
		}
		writeJSON(w, http.StatusOK, map[string]any{"teams": teams, "auth_teams": authTeams})
	case http.MethodPost:
		var p struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		name := strings.TrimSpace(p.Name)
		if name == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name is required", "invalid_request_error", "missing_name")
			return
		}
		id := strings.TrimSpace(p.ID)
		if id == "" {
			id = "team_" + audit.HashText(name)[:16]
		}
		if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" && id != claims.TeamID {
			writeOpenAIError(w, http.StatusForbidden, "team_admin can only manage own team", "permission_error", "team_scope_denied")
			return
		}
		team := store.AuthTeam{ID: id, Name: name}
		if err := s.db.UpsertAuthTeam(r.Context(), team); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "team_create_failed")
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"team": team})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleTeamDetail(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	team := strings.TrimPrefix(r.URL.Path, "/admin/teams/")
	if team == "" || strings.Contains(team, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid team", "invalid_request_error", "invalid_team")
		return
	}
	if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" && !s.claimsTeamMatches(r, claims, team) {
		writeOpenAIError(w, http.StatusForbidden, "team_admin can only access own team", "permission_error", "team_scope_denied")
		return
	}
	detail, err := s.db.GetTeamDetail(r.Context(), team, recentLimit(r))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "team not found", "invalid_request_error", "team_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "team_detail_failed")
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) handleUserDetail(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/users/")
	// /admin/users/{id}/report — per-user weekly coding report.
	if idx := strings.Index(id, "/"); idx >= 0 {
		sub := id[idx+1:]
		id = id[:idx]
		if sub == "report" {
			s.handleUserReport(w, r, id)
			return
		}
		writeOpenAIError(w, http.StatusNotFound, "not found", "invalid_request_error", "not_found")
		return
	}
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid user id", "invalid_request_error", "invalid_user_id")
		return
	}
	if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" && r.Method != http.MethodPatch && !s.subjectBelongsToTeam(r, id, claims.TeamID) {
		writeOpenAIError(w, http.StatusForbidden, "team_admin can only access own team users", "permission_error", "team_scope_denied")
		return
	}
	// usr_ ids are login accounts: PATCH updates role/status (admin only).
	if r.Method == http.MethodPatch && strings.HasPrefix(id, "usr_") {
		s.handleAuthUserUpdate(w, r, id)
		return
	}
	detail, err := s.db.GetUserDetail(r.Context(), id, recentLimit(r))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "user not found", "invalid_request_error", "user_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "user_detail_failed")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		*store.UserDetail
		TeamNames map[string]string `json:"team_names"`
	}{&detail, s.teamNameByID(r)})
}

// handleUserReport returns a per-user AI coding report over a window (default 7d):
// request volume, cost, error rate, top models/languages, daily trend, and the
// wall-clock time the user's sessions span.
func (s *Server) handleUserReport(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid user id", "invalid_request_error", "invalid_user_id")
		return
	}
	if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" && !s.subjectBelongsToTeam(r, id, claims.TeamID) {
		writeOpenAIError(w, http.StatusForbidden, "team_admin can only access own team users", "permission_error", "team_scope_denied")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	report, err := s.db.UserCodingReportSince(r.Context(), id, since)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "user not found", "invalid_request_error", "user_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "user_report_failed")
		return
	}
	writeJSON(w, http.StatusOK, report)
}

func (s *Server) claimsTeamMatches(r *http.Request, claims accessClaims, team string) bool {
	team = strings.TrimSpace(team)
	if team == "" {
		return false
	}
	if team == claims.TeamID {
		return true
	}
	authTeam, found, err := s.db.AuthTeamByIDOrName(r.Context(), team)
	return err == nil && found && authTeam.ID == claims.TeamID
}

func (s *Server) subjectBelongsToTeam(r *http.Request, id, teamID string) bool {
	if teamID == "" {
		return false
	}
	if strings.HasPrefix(id, "usr_") {
		primary, _ := s.db.PrimaryTeamForUser(r.Context(), id)
		return primary == teamID
	}
	key, found, err := s.db.GetAPIKey(r.Context(), id)
	return err == nil && found && key.Team == teamID
}

// handleAuthUserUpdate applies a role/status change to a login account.
// team_admin may not change roles or deactivate accounts (privilege escalation
// guard) — only admin/super_admin scopes pass authorizeAdmin for PATCH anyway,
// but team_admin gets an /admin/users bypass for its own team, so re-check here.
func (s *Server) handleAuthUserUpdate(w http.ResponseWriter, r *http.Request, id string) {
	if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" {
		writeOpenAIError(w, http.StatusForbidden, "team_admin cannot change roles or account status", "permission_error", "role_change_denied")
		return
	}
	var p struct {
		Role   *string `json:"role"`
		Status *string `json:"status"`
		TeamID *string `json:"team_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	user, found, err := s.db.AuthUserByID(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "user_lookup_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "user not found", "invalid_request_error", "user_not_found")
		return
	}
	if !s.canModifySubjectRole(r, user.Role) {
		s.auditAuthEvent(r.Context(), "role_denied", id, "", "", "modify user role "+user.Role)
		writeOpenAIError(w, http.StatusForbidden, "cannot modify a user at or above your role", "permission_error", "role_escalation_denied")
		return
	}
	role, status := "", ""
	if p.Role != nil {
		role = strings.TrimSpace(*p.Role)
		if _, ok := roleScopes[role]; role != "" && !ok {
			writeOpenAIError(w, http.StatusBadRequest, "invalid role", "invalid_request_error", "invalid_role")
			return
		}
		if role != "" && !s.canAssignRole(r, role) {
			s.auditAuthEvent(r.Context(), "role_denied", id, "", "", "assign user role "+role)
			writeOpenAIError(w, http.StatusForbidden, "cannot assign role at or above your role", "permission_error", "role_escalation_denied")
			return
		}
	}
	if p.Status != nil {
		status = strings.TrimSpace(*p.Status)
		if status != "active" && status != "disabled" {
			writeOpenAIError(w, http.StatusBadRequest, "status must be active or disabled", "invalid_request_error", "invalid_status")
			return
		}
	}
	if role == "" && status == "" && p.TeamID == nil {
		writeOpenAIError(w, http.StatusBadRequest, "nothing to update", "invalid_request_error", "empty_update")
		return
	}
	if role != "" || status != "" {
		if err := s.db.UpdateAuthUserRoleStatus(r.Context(), id, role, status); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "user_update_failed")
			return
		}
	}
	oldTeam, _ := s.db.PrimaryTeamForUser(r.Context(), id)
	if p.TeamID != nil {
		teamID := strings.TrimSpace(*p.TeamID)
		if teamID != "" {
			if _, found, terr := s.db.AuthTeamByIDOrName(r.Context(), teamID); terr != nil || !found {
				writeOpenAIError(w, http.StatusBadRequest, "unknown team", "invalid_request_error", "unknown_team")
				return
			}
		}
		memberRole := role
		if memberRole == "" {
			memberRole = user.Role
		}
		if err := s.db.SetUserTeam(r.Context(), id, teamID, memberRole); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "team_update_failed")
			return
		}
	}
	if status == "disabled" {
		// kill live sessions + refresh tokens so the account stops working now
		_ = s.db.RevokeAuthSessionsForUser(r.Context(), id)
	}
	if role != "" && role != user.Role {
		_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "role_changed", ActorUserID: id, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: user.Role + " → " + role, CreatedAt: time.Now().UTC()})
	}
	updated, _, _ := s.db.AuthUserByID(r.Context(), id)
	newTeam, _ := s.db.PrimaryTeamForUser(r.Context(), id)
	s.auditAdmin(r, "auth_user.update",
		auditJSON(map[string]string{"id": id, "role": user.Role, "status": user.Status, "team": oldTeam}),
		auditJSON(map[string]string{"id": id, "role": updated.Role, "status": updated.Status, "team": newTeam}))
	writeJSON(w, http.StatusOK, map[string]any{"user": updated, "team_id": newTeam})
}

func (s *Server) handleIPs(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ips, err := s.db.ListIPs(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "ips_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ips": ips})
}

func (s *Server) handleIPDetail(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ip := strings.TrimPrefix(r.URL.Path, "/admin/ips/")
	if ip == "" || strings.Contains(ip, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid ip", "invalid_request_error", "invalid_ip")
		return
	}
	detail, err := s.db.GetIPDetail(r.Context(), ip, recentLimit(r))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "ip not found", "invalid_request_error", "ip_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "ip_detail_failed")
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) handleRequestDetail(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/admin/requests/")
	if rest == "diff" {
		s.handleRequestDiff(w, r)
		return
	}
	if idx := strings.Index(rest, "/"); idx >= 0 {
		sub := rest[idx+1:]
		switch sub {
		case "note":
			s.handleRequestNote(w, r)
			return
		case "replay":
			s.handleRequestReplay(w, r)
			return
		case "analyze":
			s.handleRequestAnalyze(w, r)
			return
		case "explain":
			s.handleRequestExplain(w, r)
			return
		case "links":
			s.handleRequestLinks(w, r)
			return
		}
		writeOpenAIError(w, http.StatusNotFound, "not found", "invalid_request_error", "not_found")
		return
	}
	id := rest
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid request id", "invalid_request_error", "invalid_request_id")
		return
	}
	detail, err := s.db.RequestDetail(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "request_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "request_detail_failed")
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) handleRequestAnalyze(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/admin/requests/")
	idx := strings.Index(rest, "/")
	if idx <= 0 {
		writeOpenAIError(w, http.StatusBadRequest, "invalid request id", "invalid_request_error", "invalid_request_id")
		return
	}
	id := rest[:idx]

	detail, err := s.db.RequestDetail(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "request_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "request_detail_failed")
		return
	}

	var sb strings.Builder
	sb.WriteString("Analyze and summarize the following LLM Request & Response details. Format your response in Markdown (Korean language). Be concise and provide a 3-line summary of 1) User Intent, 2) Performed task/result, 3) Specific errors or warnings (if any).\n\n")
	sb.WriteString(fmt.Sprintf("## Metadata\n- Request ID: %s\n- Model: %s\n- Endpoint: %s\n- Status Code: %d\n", detail.Request.ID, detail.Request.Model, detail.Request.Endpoint, detail.Request.StatusCode))
	if detail.Request.Error != "" {
		sb.WriteString(fmt.Sprintf("- Error: %s\n", detail.Request.Error))
	}
	sb.WriteString("\n## Prompts (Conversations)\n")
	for _, p := range detail.Prompts {
		sb.WriteString(fmt.Sprintf("### Role: %s\n", p.Role))
		sb.WriteString(p.RedactedText)
		sb.WriteString("\n\n")
	}
	if detail.Response != nil && detail.Response.ResponseTextOptional != "" {
		sb.WriteString("## Response\n")
		sb.WriteString(detail.Response.ResponseTextOptional)
		sb.WriteString("\n\n")
	}

	promptToLLM := sb.String()

	provider, err := s.selectProvider(r.Context(), r, "")
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "select default provider failed: "+err.Error(), "server_error", "provider_selection_failed")
		return
	}

	modelName := "gpt-4o-mini"
	if detail.Request.Model != "" {
		modelName = detail.Request.Model
	}

	requestPayload := map[string]any{
		"model": modelName,
		"messages": []map[string]string{
			{
				"role":    "user",
				"content": promptToLLM,
			},
		},
	}

	payloadBytes, err := json.Marshal(requestPayload)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "marshal_payload_failed")
		return
	}

	upstreamURL, err := s.upstreamURL(provider.BaseURL, &url.URL{Path: "/v1/chat/completions"})
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "build_upstream_url_failed")
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstreamURL, bytes.NewReader(payloadBytes))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "create_request_failed")
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+provider.APIKey)

	resp, err := s.client.Do(req)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "upstream call failed: "+err.Error(), "server_error", "upstream_failed")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		writeOpenAIError(w, http.StatusBadGateway, fmt.Sprintf("upstream returned status %d: %s", resp.StatusCode, string(bodyBytes)), "server_error", "upstream_error")
		return
	}

	var openAIResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&openAIResp); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "decode upstream response failed: "+err.Error(), "server_error", "decode_failed")
		return
	}

	if len(openAIResp.Choices) == 0 {
		writeOpenAIError(w, http.StatusInternalServerError, "empty choices from upstream", "server_error", "empty_choices")
		return
	}

	analysisResult := openAIResp.Choices[0].Message.Content
	writeJSON(w, http.StatusOK, map[string]string{"analysis": analysisResult})
}

func (s *Server) handlePromptSearch(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	q := store.PromptSearch{
		Keyword:  strings.TrimSpace(r.URL.Query().Get("q")),
		APIKeyID: strings.TrimSpace(r.URL.Query().Get("api_key_id")),
		IP:       strings.TrimSpace(r.URL.Query().Get("ip")),
		Language: strings.TrimSpace(r.URL.Query().Get("language")),
		Since:    strings.TrimSpace(r.URL.Query().Get("since")),
		Limit:    recentLimit(r),
	}
	results, err := s.db.SearchPrompts(r.Context(), q)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "prompt_search_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": results})
}

func recentLimit(r *http.Request) int {
	value := strings.TrimSpace(r.URL.Query().Get("limit"))
	if value == "" {
		return 50
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 50
	}
	if parsed > 200 {
		return 200
	}
	return parsed
}
