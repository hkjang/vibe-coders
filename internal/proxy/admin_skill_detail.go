package proxy

import (
	"net/http"
	"net/url"
	"unicode"
	"unicode/utf8"
	"vibe-coders/internal/store"
)

// The caller has already applied the unchanged administrator read policy.
// A query identity avoids the historical by-name path's slash normalization.
func (s *Server) handleSkillReadView(w http.ResponseWriter, r *http.Request) bool {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err == nil && !values.Has("name") && (len(values["view"]) == 0 || (len(values["view"]) == 1 && values.Get("view") == "")) {
		return false
	}
	w.Header().Set("Cache-Control", "no-store")
	invalid := func() {
		writeOpenAIError(w, http.StatusBadRequest, "invalid skill detail query", "invalid_request_error", "invalid_skill_query")
	}
	if err != nil || len(values["view"]) != 1 || values.Get("view") != "detail" || len(values["name"]) != 1 {
		invalid()
		return true
	}
	for key := range values {
		if key != "view" && key != "name" {
			invalid()
			return true
		}
	}
	name := values.Get("name")
	if name == "" || !utf8.ValidString(name) || len(name) > 4096 {
		invalid()
		return true
	}
	for _, char := range name {
		if unicode.IsControl(char) {
			invalid()
			return true
		}
	}
	skill, found, err := s.db.GetSkill(r.Context(), name)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "failed to load skill", "server_error", "skill_detail_failed")
		return true
	}
	var selected *store.Skill
	if found {
		selected = &skill
	}
	writeJSON(w, http.StatusOK, map[string]any{"skill": selected})
	return true
}
