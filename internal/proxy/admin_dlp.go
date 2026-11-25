package proxy

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/dlp"
	"vibe-coders/internal/store"
)

// Admin API for data loss prevention. Reads need security:read; saving needs
// admin:write. The test scan only computes, so it is a read.
//
//	GET  /admin/security/dlp          configuration, revision, catalog, recommended policies
//	PUT  /admin/security/dlp          save the configuration on top of expected_revision
//	POST /admin/security/dlp/test     scan sample text with the saved or a draft configuration
//	GET  /admin/security/dlp/events   matches, newest first, with a summary (team admins see their team)
const dlpAdminPath = "/admin/security/dlp"

const dlpBodyLimit = 1 << 20

type dlpCatalogEntry struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Description     string   `json:"description,omitempty"`
	BaseConfidence  string   `json:"base_confidence"`
	RequiresContext bool     `json:"requires_context"`
	Context         []string `json:"context"`
	Mask            string   `json:"mask"`
	Example         string   `json:"example"`
}

type dlpCatalogProfile struct {
	ID                   string            `json:"id"`
	Name                 string            `json:"name"`
	Description          string            `json:"description"`
	DefaultMinConfidence string            `json:"default_min_confidence"`
	DefaultMinMatches    int               `json:"default_min_matches"`
	RecordDistinct       int               `json:"record_distinct,omitempty"`
	RecordWindow         int               `json:"record_window,omitempty"`
	Entries              []dlpCatalogEntry `json:"entries"`
}

func dlpCatalog() []dlpCatalogProfile {
	out := []dlpCatalogProfile{}
	for _, p := range dlp.BuiltinProfiles() {
		profile := dlpCatalogProfile{
			ID: p.ID, Name: p.Name, Description: p.Description,
			DefaultMinConfidence: p.DefaultMinConfidence.String(), DefaultMinMatches: p.DefaultMinMatches,
			RecordDistinct: p.RecordDistinct, RecordWindow: p.RecordWindow, Entries: []dlpCatalogEntry{},
		}
		entries := dlp.ProfileEntries(p.ID)
		if len(p.RecordOf) > 0 {
			entries = nil
			for _, id := range p.RecordOf {
				if e, ok := dlp.LookupEntry(id); ok {
					entries = append(entries, e)
				}
			}
		}
		for _, e := range entries {
			profile.Entries = append(profile.Entries, dlpCatalogEntry{
				ID: e.ID, Name: e.Name, Description: e.Description, BaseConfidence: e.BaseConfidence().String(),
				RequiresContext: e.RequiresContext(), Context: append([]string{}, e.ContextWords()...), Mask: e.MaskLabel(), Example: e.Example,
			})
		}
		out = append(out, profile)
	}
	return out
}

func (s *Server) loadDLPConfig(r *http.Request) (dlp.Config, store.DLPSettings, error) {
	settings, found, err := s.db.GetDLPSettings(r.Context())
	if err != nil {
		return dlp.Config{}, store.DLPSettings{}, err
	}
	cfg := dlp.DefaultConfig()
	if found {
		if err := json.Unmarshal([]byte(settings.ConfigJSON), &cfg); err != nil {
			return dlp.Config{}, store.DLPSettings{}, err
		}
	}
	return dlp.Normalize(cfg), settings, nil
}

func (s *Server) handleDLP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		cfg, settings, err := s.loadDLPConfig(r)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, "DLP settings are unavailable", "server_error", "dlp_settings_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"config": cfg, "revision": settings.Revision, "updated_by": settings.UpdatedBy, "updated_at": settings.UpdatedAt,
			"catalog": dlpCatalog(), "recommended_policies": dlp.RecommendedPolicies(),
			"response_header": "X-Vibe-DLP", "compat_header": "cf-aig-dlp",
		})
	case http.MethodPut:
		var payload struct {
			Config           *dlp.Config `json:"config"`
			ExpectedRevision *int        `json:"expected_revision"`
			Reason           string      `json:"reason"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, dlpBodyLimit)).Decode(&payload); err != nil || payload.Config == nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if payload.ExpectedRevision == nil || *payload.ExpectedRevision < 0 {
			writeOpenAIError(w, http.StatusBadRequest, "expected_revision is required: the revision the edit started from (0 before the first save)", "invalid_request_error", "dlp_revision_missing")
			return
		}
		cfg := dlp.Normalize(*payload.Config)
		if issues := dlp.Validate(cfg); len(issues) > 0 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
				"error":  map[string]any{"message": "the DLP configuration has errors", "type": "invalid_request_error", "code": "dlp_config_invalid"},
				"issues": issues,
			})
			return
		}
		before, previous, err := s.loadDLPConfig(r)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, "DLP settings are unavailable", "server_error", "dlp_settings_failed")
			return
		}
		encoded, _ := json.Marshal(cfg)
		saved, err := s.db.SaveDLPSettings(r.Context(), string(encoded), *payload.ExpectedRevision, s.skillActor(r))
		if errors.Is(err, store.ErrDLPSettingsConflict) {
			writeOpenAIError(w, http.StatusConflict, "the DLP settings changed since they were loaded; reload and apply the change again", "invalid_request_error", "dlp_conflict")
			return
		}
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, "DLP settings could not be saved", "server_error", "dlp_save_failed")
			return
		}
		s.invalidateDLP()
		s.auditAdmin(r, "dlp.update",
			auditJSON(map[string]any{"revision": previous.Revision, "enabled": before.Enabled, "policies": len(before.Policies), "custom_profiles": len(before.CustomProfiles)}),
			auditJSON(map[string]any{"revision": saved.Revision, "enabled": cfg.Enabled, "policies": len(cfg.Policies), "custom_profiles": len(cfg.CustomProfiles), "reason": strings.TrimSpace(payload.Reason)}))
		writeJSON(w, http.StatusOK, map[string]any{"config": cfg, "revision": saved.Revision, "updated_by": saved.UpdatedBy, "updated_at": saved.UpdatedAt})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

type dlpTestMatch struct {
	ProfileID  string `json:"profile_id"`
	EntryID    string `json:"entry_id"`
	EntryName  string `json:"entry_name"`
	Start      int    `json:"start"`
	End        int    `json:"end"`
	Confidence string `json:"confidence"`
}

type dlpTestProfile struct {
	ProfileID  string   `json:"profile_id"`
	Name       string   `json:"name"`
	Triggered  bool     `json:"triggered"`
	MatchCount int      `json:"match_count"`
	EntryIDs   []string `json:"entry_ids"`
}

type dlpTestDecision struct {
	Action   string          `json:"action"`
	Policies []dlp.PolicyHit `json:"policies"`
}

func dlpDecisionView(d dlp.Decision) dlpTestDecision {
	policies := d.Policies
	if policies == nil {
		policies = []dlp.PolicyHit{}
	}
	return dlpTestDecision{Action: string(d.Action), Policies: policies}
}

func (s *Server) handleDLPTestAuthorized(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	s.handleDLPTest(w, r)
}

func (s *Server) handleDLPEventsAuthorized(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	s.handleDLPEvents(w, r)
}

func (s *Server) handleDLPTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var payload struct {
		Text     string      `json:"text"`
		Config   *dlp.Config `json:"config"`
		TeamID   string      `json:"team_id"`
		APIKeyID string      `json:"api_key_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, dlpBodyLimit+(64<<10))).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	if strings.TrimSpace(payload.Text) == "" || len(payload.Text) > dlpBodyLimit {
		writeOpenAIError(w, http.StatusBadRequest, "text must be 1 byte to 1 MiB", "invalid_request_error", "dlp_test_text_invalid")
		return
	}
	cfg := dlp.Config{}
	if payload.Config != nil {
		// A draft can carry up to thousands of custom patterns over a megabyte of text;
		// testing one is reserved for those who may save one. Readers test the saved
		// configuration.
		if !s.dlpMayWrite(r) {
			writeOpenAIError(w, http.StatusForbidden, "testing an unsaved DLP configuration requires admin:write; omit config to test the saved one", "permission_error", "dlp_draft_forbidden")
			return
		}
		cfg = *payload.Config
	} else {
		stored, _, err := s.loadDLPConfig(r)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, "DLP settings are unavailable", "server_error", "dlp_settings_failed")
			return
		}
		cfg = stored
	}
	// The test answers "what would happen", including while DLP is switched off.
	cfg.Enabled = true
	engine, issues := dlp.Compile(cfg)
	if len(issues) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error":  map[string]any{"message": "the DLP configuration has errors", "type": "invalid_request_error", "code": "dlp_config_invalid"},
			"issues": issues,
		})
		return
	}
	segments := []string{payload.Text}
	scan := engine.Scan(segments, nil)
	matches := []dlpTestMatch{}
	profiles := []dlpTestProfile{}
	for _, hit := range scan.Hits {
		profiles = append(profiles, dlpTestProfile{ProfileID: hit.ProfileID, Name: engine.ProfileName(hit.ProfileID), Triggered: true, MatchCount: len(hit.Matches), EntryIDs: hit.EntryIDs()})
		for _, m := range hit.Matches {
			matches = append(matches, dlpTestMatch{ProfileID: hit.ProfileID, EntryID: m.EntryID, EntryName: engine.EntryName(m.EntryID), Start: m.Start, End: m.End, Confidence: m.Confidence.String()})
		}
	}
	scope := dlp.Scope{TeamID: strings.TrimSpace(payload.TeamID), APIKeyID: strings.TrimSpace(payload.APIKeyID)}
	request := engine.Evaluate(dlp.CheckRequest, scope, segments)
	response := engine.Evaluate(dlp.CheckResponse, scope, segments)
	masked := payload.Text
	if request.Action == dlp.ActionMask {
		masked = engine.Mask(segments, request.MaskMatches)[0]
	}
	header, _ := dlp.Header(request, response)
	writeJSON(w, http.StatusOK, map[string]any{
		"matches": matches, "profiles": profiles, "truncated": scan.Truncated, "scanned_bytes": scan.Scanned,
		"request": dlpDecisionView(request), "response": dlpDecisionView(response),
		"masked_request": masked, "header": header,
	})
}

func (s *Server) handleDLPEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	query := r.URL.Query()
	hours := 24
	if raw := query.Get("hours"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 24*90 {
			writeOpenAIError(w, http.StatusBadRequest, "hours must be 1 to 2160", "invalid_request_error", "dlp_events_query_invalid")
			return
		}
		hours = parsed
	}
	limit := 100
	if raw := query.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 500 {
			writeOpenAIError(w, http.StatusBadRequest, "limit must be 1 to 500", "invalid_request_error", "dlp_events_query_invalid")
			return
		}
		limit = parsed
	}
	action := strings.ToUpper(strings.TrimSpace(query.Get("action")))
	if action != "" && action != "FLAG" && action != "MASK" && action != "BLOCK" {
		writeOpenAIError(w, http.StatusBadRequest, "action must be FLAG, MASK or BLOCK", "invalid_request_error", "dlp_events_query_invalid")
		return
	}
	check := strings.ToUpper(strings.TrimSpace(query.Get("check")))
	if check != "" && check != "REQUEST" && check != "RESPONSE" {
		writeOpenAIError(w, http.StatusBadRequest, "check must be REQUEST or RESPONSE", "invalid_request_error", "dlp_events_query_invalid")
		return
	}
	filter := store.DLPEventFilter{
		Since: time.Now().Add(-time.Duration(hours) * time.Hour), Limit: limit,
		RequestID: strings.TrimSpace(query.Get("request_id")), TeamID: strings.TrimSpace(query.Get("team_id")),
		Action: action, Check: check, ProfileID: strings.TrimSpace(query.Get("profile")),
	}
	if err := s.enforceGovernanceTeamScope(r, &filter.TeamID); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "governance scope could not be resolved", "server_error", "governance_scope_failed")
		return
	}
	events, err := s.db.ListDLPEvents(r.Context(), filter)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "DLP events could not be loaded", "server_error", "dlp_events_failed")
		return
	}
	summary := map[string]any{}
	for _, by := range []string{"action", "check_side", "profile_id", "day"} {
		rows, err := s.db.DLPEventSummary(r.Context(), store.DLPEventFilter{Since: filter.Since, TeamID: filter.TeamID, Action: action, Check: check, ProfileID: filter.ProfileID}, by)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, "DLP summary could not be loaded", "server_error", "dlp_events_failed")
			return
		}
		key := map[string]string{"action": "by_action", "check_side": "by_check", "profile_id": "by_profile", "day": "by_day"}[by]
		summary[key] = rows
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events, "summary": summary, "hours": hours, "count": len(events)})
}

// dlpMayWrite reports whether the caller could save the DLP configuration.
func (s *Server) dlpMayWrite(r *http.Request) bool {
	if s.cfg.Auth.Enabled {
		claims, ok := s.currentAccessClaims(r)
		return ok && hasScope(claims.Scopes, "admin:write")
	}
	if s.cfg.Auth.AdminToken == "" && s.cfg.Auth.AdminReadonlyToken == "" {
		return true
	}
	token := bearerToken(r.Header.Get("Authorization"))
	return s.cfg.Auth.AdminToken != "" && secureTokenEqual(token, s.cfg.Auth.AdminToken)
}
