package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// handleAdminChangeSets lists or creates change sets. GET/POST /admin/change-sets
func (s *Server) handleAdminChangeSets(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		cs, err := s.db.ListChangeSets(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"change_sets": cs})
	case http.MethodPost:
		var p struct {
			Title       string                `json:"title"`
			Description string                `json:"description"`
			CanaryScope string                `json:"canary_scope"`
			Items       []store.ChangeSetItem `json:"items"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil || strings.TrimSpace(p.Title) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "title is required", "invalid_request_error", "bad_request")
			return
		}
		cs := store.ChangeSet{
			ID: newID("cset"), Title: strings.TrimSpace(p.Title), Description: p.Description,
			CanaryScope: strings.TrimSpace(p.CanaryScope), Items: p.Items, Status: "draft", CreatedBy: adminID(r),
		}
		if cs.Items == nil {
			cs.Items = []store.ChangeSetItem{}
		}
		if err := s.db.CreateChangeSet(r.Context(), cs); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "create_failed")
			return
		}
		s.auditAdmin(r, "change_set.create", cs.ID, auditJSON(map[string]any{"title": cs.Title, "items": len(cs.Items)}))
		writeJSON(w, http.StatusCreated, cs)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleAdminChangeSetByID dispatches GET/DELETE /admin/change-sets/{id} and the action
// sub-routes: /dryrun, /submit, /approve, /apply, /rollback.
func (s *Server) handleAdminChangeSetByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/admin/change-sets/")
	id, action := rest, ""
	if idx := strings.Index(rest, "/"); idx >= 0 {
		id, action = rest[:idx], rest[idx+1:]
	}
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "change set id required", "invalid_request_error", "bad_request")
		return
	}
	cs, found, err := s.db.GetChangeSet(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "get_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "change set not found", "invalid_request_error", "not_found")
		return
	}
	switch action {
	case "":
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, cs)
		case http.MethodDelete:
			if err := s.db.DeleteChangeSet(r.Context(), id); err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "delete_failed")
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "deleted"})
		default:
			writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		}
	case "dryrun":
		s.changeSetDryRun(w, r, cs)
	case "submit":
		s.changeSetTransition(w, r, cs, "draft", "pending")
	case "approve":
		s.changeSetTransition(w, r, cs, "pending", "approved")
	case "apply":
		s.changeSetApply(w, r, cs)
	case "rollback":
		s.changeSetRollback(w, r, cs)
	default:
		writeOpenAIError(w, http.StatusNotFound, "unknown action", "invalid_request_error", "not_found")
	}
}

// changeSetDryRun shows each item's current vs proposed effective value, validity, and
// restart-required flag without applying anything.
func (s *Server) changeSetDryRun(w http.ResponseWriter, r *http.Request, cs store.ChangeSet) {
	stored := s.storedSettingsMap(r)
	checks := []map[string]any{}
	changed, restart, invalid := 0, false, 0
	for _, it := range cs.Items {
		row := map[string]any{"kind": it.Kind, "key": it.Key, "proposed": it.Value}
		if it.Kind != "setting" {
			row["applied_by_gateway"] = false
			row["detail"] = "이 버전에서는 setting 항목만 적용됩니다(참고용으로 기록)"
			checks = append(checks, row)
			continue
		}
		d, ok := settingDefByKey(it.Key)
		if !ok {
			row["valid"] = false
			row["detail"] = "알 수 없는 설정 키"
			invalid++
			checks = append(checks, row)
			continue
		}
		cur, source := s.effectiveSettingValue(stored, d)
		row["current"] = cur
		row["source"] = source
		row["changed"] = cur != it.Value
		row["restart_required"] = d.Restart
		if cur != it.Value {
			changed++
		}
		if d.Restart {
			restart = true
		}
		if err := validateSettingValue(d, it.Value); err != nil {
			row["valid"] = false
			row["detail"] = err.Error()
			invalid++
		} else {
			row["valid"] = true
		}
		checks = append(checks, row)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"change_set_id": cs.ID, "status": cs.Status, "checks": checks,
		"changed_count": changed, "invalid_count": invalid, "restart_required": restart,
		"canary_scope": cs.CanaryScope,
		"note":         "setting 변경은 전역 적용입니다(canary_scope는 메모로만 기록). policy/routing/skill 항목은 참고용.",
	})
}

func (s *Server) storedSettingsMap(r *http.Request) map[string]store.AdminSetting {
	stored := map[string]store.AdminSetting{}
	if list, err := s.db.ListAdminSettings(r.Context()); err == nil {
		for _, a := range list {
			stored[a.Key] = a
		}
	}
	return stored
}

// changeSetTransition performs a simple status move (submit/approve), recording the reviewer
// on approval.
func (s *Server) changeSetTransition(w http.ResponseWriter, r *http.Request, cs store.ChangeSet, from, to string) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if cs.Status != from {
		writeOpenAIError(w, http.StatusUnprocessableEntity, "change set must be in '"+from+"' to "+to+" (current: "+cs.Status+")", "invalid_request_error", "bad_state")
		return
	}
	var p struct {
		Note string `json:"note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&p)
	cs.Status = to
	if strings.TrimSpace(p.Note) != "" {
		cs.Note = strings.TrimSpace(p.Note)
	}
	if to == "approved" {
		cs.Reviewer = adminID(r)
	}
	if err := s.db.UpdateChangeSet(r.Context(), cs); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "update_failed")
		return
	}
	s.auditAdmin(r, "change_set."+to, cs.ID, "")
	writeJSON(w, http.StatusOK, cs)
}

// changeSetApply validates all setting items, captures their prior effective values (for
// rollback), persists them, reloads the runtime config once, and marks the set applied.
func (s *Server) changeSetApply(w http.ResponseWriter, r *http.Request, cs store.ChangeSet) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if cs.Status != "approved" {
		writeOpenAIError(w, http.StatusUnprocessableEntity, "change set must be 'approved' to apply (current: "+cs.Status+")", "invalid_request_error", "bad_state")
		return
	}
	stored := s.storedSettingsMap(r)
	// Validate all setting items up-front so a partial apply can't break the gateway.
	type pending struct {
		def   settingDef
		value string
		prior string
	}
	todo := []pending{}
	for _, it := range cs.Items {
		if it.Kind != "setting" {
			continue
		}
		d, ok := settingDefByKey(it.Key)
		if !ok {
			writeOpenAIError(w, http.StatusUnprocessableEntity, "unknown setting key: "+it.Key, "invalid_request_error", "bad_key")
			return
		}
		if err := validateSettingValue(d, it.Value); err != nil {
			writeOpenAIError(w, http.StatusUnprocessableEntity, "invalid value for "+it.Key+": "+err.Error(), "invalid_request_error", "bad_value")
			return
		}
		cur, _ := s.effectiveSettingValue(stored, d)
		todo = append(todo, pending{def: d, value: it.Value, prior: cur})
	}
	prior := make([]store.ChangeSetItem, 0, len(todo))
	for _, t := range todo {
		if err := s.persistSettingValue(r, t.def, t.value, "change-set "+cs.ID); err != nil {
			// Best-effort: stop on first failure; already-written items remain (reload still runs).
			s.reloadRuntimeConfig(r.Context())
			writeOpenAIError(w, http.StatusInternalServerError, "apply failed at "+t.def.Key+": "+err.Error(), "server_error", "apply_failed")
			return
		}
		prior = append(prior, store.ChangeSetItem{Kind: "setting", Key: t.def.Key, Value: t.prior})
	}
	s.reloadRuntimeConfig(r.Context())
	cs.Prior = prior
	cs.Status = "applied"
	cs.AppliedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.db.UpdateChangeSet(r.Context(), cs); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "update_failed")
		return
	}
	s.auditAdmin(r, "change_set.apply", cs.ID, auditJSON(map[string]any{"applied": len(prior)}))
	writeJSON(w, http.StatusOK, map[string]any{"status": "applied", "applied_count": len(prior), "change_set": cs})
}

// changeSetRollback restores the prior effective values captured at apply time.
func (s *Server) changeSetRollback(w http.ResponseWriter, r *http.Request, cs store.ChangeSet) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if cs.Status != "applied" {
		writeOpenAIError(w, http.StatusUnprocessableEntity, "only an applied change set can be rolled back (current: "+cs.Status+")", "invalid_request_error", "bad_state")
		return
	}
	restored := 0
	for _, it := range cs.Prior {
		if it.Kind != "setting" {
			continue
		}
		d, ok := settingDefByKey(it.Key)
		if !ok {
			continue
		}
		if err := s.persistSettingValue(r, d, it.Value, "rollback "+cs.ID); err == nil {
			restored++
		}
	}
	s.reloadRuntimeConfig(r.Context())
	cs.Status = "rolled_back"
	if err := s.db.UpdateChangeSet(r.Context(), cs); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "update_failed")
		return
	}
	s.auditAdmin(r, "change_set.rollback", cs.ID, auditJSON(map[string]any{"restored": restored}))
	writeJSON(w, http.StatusOK, map[string]any{"status": "rolled_back", "restored_count": restored, "change_set": cs})
}
