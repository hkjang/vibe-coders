package proxy

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/secret"
	"vibe-coders/internal/store"
)

type promptStageWorkspaceItem struct {
	Reference     string  `json:"reference"`
	Name          string  `json:"name"`
	Version       string  `json:"version"`
	Stage         string  `json:"stage"`
	Registered    bool    `json:"registered"`
	CanChange     bool    `json:"can_change"`
	Revision      string  `json:"revision"`
	Calls         int64   `json:"calls"`
	Errors        int64   `json:"errors"`
	EvalFailures  int64   `json:"evaluation_failures"`
	EligibleStage string  `json:"eligible_stage"`
	UpdatedAt     *string `json:"updated_at"`
}

func promptStageRevision(cipher *secret.Cipher, snapshot store.PromptStageSnapshot) string {
	encoded, _ := json.Marshal(snapshot)
	return cipher.OpaqueReference("prompt-stage-revision/v1", string(encoded))
}
func promptStageReference(cipher *secret.Cipher, name, version string) string {
	encoded, _ := json.Marshal([]string{name, version})
	return cipher.OpaqueReference("prompt-stage-identity/v1", string(encoded))
}
func promptStageKnown(stage string) bool {
	return stage == store.PromptStageExperiment || stage == store.PromptStageValidation || stage == store.PromptStageProduction
}
func (s *Server) safePromptStageIdentity(value string) bool {
	return value != "" && strings.TrimSpace(value) == value && utf8.RuneCountInString(value) <= 256 && s.safeResourceSearchText(value)
}
func (s *Server) projectPromptStage(cipher *secret.Cipher, row store.PromptStageWorkspaceRow) promptStageWorkspaceItem {
	p, st := row.Snapshot.Promotion, row.Stats
	item := promptStageWorkspaceItem{Reference: promptStageReference(cipher, p.PromptName, p.PromptVersion), Name: p.PromptName, Version: p.PromptVersion, Stage: p.Stage, Registered: row.Snapshot.Registered, Calls: st.Calls, Errors: st.Errors, EvalFailures: st.EvalFailures, UpdatedAt: contextMetadataTime(p.UpdatedAt)}
	safe := s.safePromptStageIdentity(p.PromptName) && s.safePromptStageIdentity(p.PromptVersion)
	if !s.safePromptStageIdentity(p.PromptName) {
		item.Name = "[숨김]"
	}
	if !s.safePromptStageIdentity(p.PromptVersion) {
		item.Version = "[숨김]"
	}
	known := promptStageKnown(p.Stage)
	if !known {
		item.Stage = "unknown"
	}
	item.CanChange = safe && known
	if item.CanChange {
		item.Revision = promptStageRevision(cipher, row.Snapshot)
	}
	if known {
		item.EligibleStage = eligibleNextStage(p.Stage, st, defaultPromotionCriteria())
	}
	return item
}

func (s *Server) handlePromptStageWorkspace(w http.ResponseWriter, r *http.Request, query url.Values) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, 401, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method == http.MethodPost {
		if len(query) != 1 || len(query["view"]) != 1 || query.Get("view") != "workspace" {
			writePromptStageInvalid(w)
			return
		}
		s.savePromptStageWorkspace(w, r)
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, 405, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	limit, offset, stage, window := 25, 0, "all", "7d"
	valid := query.Get("view") == "workspace"
	for key, values := range query {
		if len(values) != 1 {
			valid = false
		}
		switch key {
		case "view":
		case "stage":
			stage = query.Get(key)
		case "window":
			window = query.Get(key)
		case "limit", "offset":
			value, err := strconv.Atoi(query.Get(key))
			if err != nil || strconv.Itoa(value) != query.Get(key) {
				valid = false
			}
			if key == "limit" {
				limit = value
			} else {
				offset = value
			}
		default:
			valid = false
		}
	}
	duration, ok := promptStageDuration(window)
	if !valid || !ok || limit < 1 || limit > 100 || offset < 0 || offset > 1000000 || (stage != "all" && !promptStageKnown(stage)) {
		writePromptStageInvalid(w)
		return
	}
	until := time.Now().UTC()
	since := until.Add(-duration)
	rows, total, err := s.db.PromptStageWorkspacePage(r.Context(), since, until, stage, limit, offset)
	if err != nil {
		writePromptStageFailure(w)
		return
	}
	cipher := s.secrets.Load()
	items := make([]promptStageWorkspaceItem, 0, len(rows))
	for _, row := range rows {
		items = append(items, s.projectPromptStage(cipher, row))
	}
	writeJSON(w, 200, map[string]any{"items": items, "total": total, "limit": limit, "offset": offset, "stage": stage, "window": window, "since": since, "until": until,
		"criteria": promptStageCriteriaView()})
}
func writePromptStageInvalid(w http.ResponseWriter) {
	writeOpenAIError(w, 400, "invalid prompt stage request", "invalid_request_error", "invalid_prompt_stage")
}
func writePromptStageFailure(w http.ResponseWriter) {
	writeOpenAIError(w, 500, "prompt stages could not be processed", "server_error", "prompt_stage_failed")
}
func writePromptStageConflict(w http.ResponseWriter) {
	writeOpenAIError(w, 409, "prompt stage changed; reload before reviewing again", "invalid_request_error", "prompt_stage_conflict")
}
func (s *Server) savePromptStageWorkspace(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Name     string `json:"name"`
		Version  string `json:"version"`
		Revision string `json:"revision"`
		Stage    string `json:"stage"`
		Reason   string `json:"reason"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		writePromptStageInvalid(w)
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		writePromptStageInvalid(w)
		return
	}
	payload.Reason = strings.TrimSpace(payload.Reason)
	if !s.safePromptStageIdentity(payload.Name) || !s.safePromptStageIdentity(payload.Version) || !promptStageKnown(payload.Stage) || len(payload.Revision) != 43 || payload.Reason == "" || utf8.RuneCountInString(payload.Reason) > 500 || !s.safeResourceSearchText(payload.Reason) {
		writePromptStageInvalid(w)
		return
	}
	before, err := s.db.GetPromptStageSnapshot(r.Context(), payload.Name, payload.Version)
	if err != nil {
		writePromptStageFailure(w)
		return
	}
	cipher := s.secrets.Load()
	if !promptStageKnown(before.Promotion.Stage) || subtle.ConstantTimeCompare([]byte(promptStageRevision(cipher, before)), []byte(payload.Revision)) != 1 {
		writePromptStageConflict(w)
		return
	}
	if before.Promotion.Stage == payload.Stage {
		writePromptStageInvalid(w)
		return
	}
	reference := promptStageReference(cipher, payload.Name, payload.Version)
	audit := store.AdminAuditLog{ID: newID("audit"), AdminID: adminID(r), Action: "prompt.promotion.set",
		BeforeValue: auditJSON(map[string]any{"reference": reference, "stage": before.Promotion.Stage, "registered": before.Registered}),
		AfterValue:  auditJSON(map[string]any{"reference": reference, "stage": payload.Stage, "reason": payload.Reason})}
	changed, err := s.db.CompareAndSetPromptStage(r.Context(), before, payload.Stage, payload.Reason, audit)
	if errors.Is(err, store.ErrPromptStageConflict) {
		writePromptStageConflict(w)
		return
	}
	if err != nil {
		writePromptStageFailure(w)
		return
	}
	s.runAdminPostChange(r, audit.Action, audit.BeforeValue, audit.AfterValue, "")
	writeJSON(w, 200, map[string]any{"reference": reference, "stage": changed.Stage, "updated_at": changed.UpdatedAt, "revision": promptStageRevision(cipher, store.PromptStageSnapshot{Promotion: changed, Registered: true})})
}
