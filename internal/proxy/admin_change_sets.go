package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

const redactedChangeSetValue = "********"

// validateChangeSetSettingItems keeps settings that cannot safely round-trip through the
// generic change-set JSON model out of the workflow. Secret values would otherwise be stored in
// plaintext in change_sets.items/prior, while read-only values are owned by the environment.
func validateChangeSetSettingItems(items []store.ChangeSetItem) error {
	for _, item := range items {
		if item.Kind != "setting" {
			continue
		}
		key := strings.TrimSpace(item.Key)
		def, ok := settingDefByKey(key)
		if !ok {
			return fmt.Errorf("unknown setting key: %s", key)
		}
		if def.Secret {
			return fmt.Errorf("secret setting %s cannot be managed by a change set", key)
		}
		if def.ReadOnly {
			return fmt.Errorf("read-only setting %s cannot be managed by a change set", key)
		}
	}
	return nil
}

// sanitizeChangeSet is also applied to legacy rows created before secret settings were rejected.
// It returns a deep-enough copy for JSON serialization without changing the stored record.
func sanitizeChangeSet(cs store.ChangeSet) store.ChangeSet {
	mask := func(items []store.ChangeSetItem) []store.ChangeSetItem {
		out := append([]store.ChangeSetItem(nil), items...)
		for i := range out {
			if out[i].Kind != "setting" {
				continue
			}
			if def, ok := settingDefByKey(strings.TrimSpace(out[i].Key)); ok && def.Secret {
				out[i].Value = redactedChangeSetValue
			}
		}
		return out
	}
	cs.Items = mask(cs.Items)
	cs.Prior = mask(cs.Prior)
	return cs
}

func writeUnsafeChangeSetSetting(w http.ResponseWriter, err error) {
	writeOpenAIError(w, http.StatusUnprocessableEntity, err.Error(), "invalid_request_error", "unsafe_setting")
}

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
		for i := range cs {
			cs[i] = sanitizeChangeSet(cs[i])
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
		if err := validateChangeSetSettingItems(p.Items); err != nil {
			writeUnsafeChangeSetSetting(w, err)
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
		writeJSON(w, http.StatusCreated, sanitizeChangeSet(cs))
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
			writeJSON(w, http.StatusOK, sanitizeChangeSet(cs))
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
	if err := validateChangeSetSettingItems(cs.Items); err != nil {
		writeUnsafeChangeSetSetting(w, err)
		return
	}
	stored, err := s.storedSettingsMap(r)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "settings_failed")
		return
	}
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
		cur, source, valueErr := s.effectiveSettingValue(stored, d)
		if valueErr != nil {
			row["valid"] = false
			row["detail"] = "current secret value is unavailable"
			invalid++
			checks = append(checks, row)
			continue
		}
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

func (s *Server) storedSettingsMap(r *http.Request) (map[string]store.AdminSetting, error) {
	stored := map[string]store.AdminSetting{}
	list, err := s.db.ListAdminSettings(r.Context())
	if err != nil {
		return nil, err
	}
	for _, a := range list {
		stored[a.Key] = a
	}
	return stored, nil
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
	writeJSON(w, http.StatusOK, sanitizeChangeSet(cs))
}

// changeSetApply validates all setting items, captures their prior effective values (for
// rollback), persists them, reloads the runtime config once, and marks the set applied.
func (s *Server) changeSetApply(w http.ResponseWriter, r *http.Request, cs store.ChangeSet) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if err := validateChangeSetSettingItems(cs.Items); err != nil {
		writeUnsafeChangeSetSetting(w, err)
		return
	}
	if cs.Status == "apply_pending" {
		s.finishPendingChangeSet(w, r, cs, "apply_pending", "applied", "apply", len(cs.Prior))
		return
	}
	if cs.Status != "approved" {
		writeOpenAIError(w, http.StatusUnprocessableEntity, "change set must be 'approved' to apply (current: "+cs.Status+")", "invalid_request_error", "bad_state")
		return
	}
	stored, err := s.storedSettingsMap(r)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "settings_failed")
		return
	}
	// Validate all setting items up-front so a partial apply can't break the gateway.
	type pending struct {
		def     settingDef
		value   string
		prior   string
		current store.AdminSetting
		found   bool
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
		cur, _, valueErr := s.effectiveSettingValue(stored, d)
		if valueErr != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "current setting value is unavailable: "+it.Key, "server_error", "setting_unavailable")
			return
		}
		current, found := stored[d.Key]
		todo = append(todo, pending{def: d, value: it.Value, prior: cur, current: current, found: found})
	}
	prior := make([]store.ChangeSetItem, 0, len(todo))
	records := make([]store.AdminSetting, 0, len(todo))
	for _, t := range todo {
		record, err := s.prepareSettingValue(t.def, t.value)
		if err != nil {
			writeOpenAIError(w, http.StatusUnprocessableEntity, "invalid value for "+t.def.Key+": "+err.Error(), "invalid_request_error", "bad_value")
			return
		}
		if err := setSettingExpectedVersion(&record, t.current, t.found, nil); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "apply_failed")
			return
		}
		records = append(records, record)
		prior = append(prior, store.ChangeSetItem{Kind: "setting", Key: t.def.Key, Value: t.prior})
	}
	cs.Prior = prior
	cs.Status = "apply_pending"
	cs.AppliedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.db.StageChangeSetSettings(r.Context(), cs, "approved", adminID(r), "change-set "+cs.ID, records); err != nil {
		status, code := http.StatusInternalServerError, "apply_failed"
		if errors.Is(err, store.ErrAdminSettingConflict) || errors.Is(err, store.ErrChangeSetConflict) {
			status, code = http.StatusConflict, "change_set_conflict"
		}
		writeOpenAIError(w, status, err.Error(), "server_error", code)
		return
	}
	s.finishPendingChangeSet(w, r, cs, "apply_pending", "applied", "apply", len(prior))
}

// changeSetRollback restores the prior effective values captured at apply time.
func (s *Server) changeSetRollback(w http.ResponseWriter, r *http.Request, cs store.ChangeSet) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if err := validateChangeSetSettingItems(cs.Prior); err != nil {
		writeUnsafeChangeSetSetting(w, err)
		return
	}
	if cs.Status == "rollback_pending" {
		s.finishPendingChangeSet(w, r, cs, "rollback_pending", "rolled_back", "rollback", len(cs.Prior))
		return
	}
	if cs.Status != "applied" {
		writeOpenAIError(w, http.StatusUnprocessableEntity, "only an applied change set can be rolled back (current: "+cs.Status+")", "invalid_request_error", "bad_state")
		return
	}
	stored, err := s.storedSettingsMap(r)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "settings_failed")
		return
	}
	records := make([]store.AdminSetting, 0, len(cs.Prior))
	for _, it := range cs.Prior {
		if it.Kind != "setting" {
			continue
		}
		d, ok := settingDefByKey(it.Key)
		if !ok {
			writeOpenAIError(w, http.StatusUnprocessableEntity, "unknown prior setting key: "+it.Key, "invalid_request_error", "bad_key")
			return
		}
		record, err := s.prepareSettingValue(d, it.Value)
		if err != nil {
			writeOpenAIError(w, http.StatusUnprocessableEntity, "invalid prior value for "+it.Key+": "+err.Error(), "invalid_request_error", "bad_value")
			return
		}
		current, found := stored[d.Key]
		if err := setSettingExpectedVersion(&record, current, found, nil); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "rollback_failed")
			return
		}
		records = append(records, record)
	}
	cs.Status = "rollback_pending"
	if err := s.db.StageChangeSetSettings(r.Context(), cs, "applied", adminID(r), "rollback "+cs.ID, records); err != nil {
		status, code := http.StatusInternalServerError, "rollback_failed"
		if errors.Is(err, store.ErrAdminSettingConflict) || errors.Is(err, store.ErrChangeSetConflict) {
			status, code = http.StatusConflict, "change_set_conflict"
		}
		writeOpenAIError(w, status, err.Error(), "server_error", code)
		return
	}
	s.finishPendingChangeSet(w, r, cs, "rollback_pending", "rolled_back", "rollback", len(records))
}

// finishPendingChangeSet performs only the resumable portion of apply/rollback. Settings are
// already durable when a pending marker exists, so retries reload and finalize without rewriting
// values or adding duplicate setting-history rows.
func (s *Server) finishPendingChangeSet(w http.ResponseWriter, r *http.Request, cs store.ChangeSet, pendingStatus, finalStatus, action string, count int) {
	if err := s.reloadRuntimeConfig(r.Context()); err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "settings were stored atomically but runtime reload is pending", "server_error", "setting_reload_pending")
		return
	}
	if err := s.db.FinalizeChangeSetStatus(r.Context(), cs.ID, pendingStatus, finalStatus); err != nil {
		status, code := http.StatusInternalServerError, "update_failed"
		if errors.Is(err, store.ErrChangeSetConflict) {
			status, code = http.StatusConflict, "change_set_conflict"
		}
		writeOpenAIError(w, status, err.Error(), "server_error", code)
		return
	}
	cs.Status = finalStatus
	metric := "applied"
	countField := "applied_count"
	if action == "rollback" {
		metric = "restored"
		countField = "restored_count"
	}
	s.auditAdmin(r, "change_set."+action, cs.ID, auditJSON(map[string]any{metric: count}))
	writeJSON(w, http.StatusOK, map[string]any{"status": finalStatus, countField: count, "change_set": sanitizeChangeSet(cs)})
}
