package proxy

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"vibe-coders/internal/store"
)

const skillRefPrefix = "skl_"

type skillReferenceFunc func(string) string

// Capture one immutable secret epoch for every row in a response or resolution.
func (s *Server) skillRefSnapshot() skillReferenceFunc {
	cipher := s.secrets.Load()
	return func(name string) string { return skillRefPrefix + cipher.OpaqueReference("skill", name) }
}

func validSkillReference(ref string) bool {
	if len(ref) != len(skillRefPrefix)+43 || !strings.HasPrefix(ref, skillRefPrefix) {
		return false
	}
	encoded := strings.TrimPrefix(ref, skillRefPrefix)
	digest, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	return err == nil && len(digest) == 32 && base64.RawURLEncoding.EncodeToString(digest) == encoded
}

type adminSkillView struct {
	store.Skill
	SkillRef string `json:"skill_ref"`
}

func (refs skillReferenceFunc) view(skill store.Skill) adminSkillView {
	return adminSkillView{Skill: skill, SkillRef: refs(skill.Name)}
}
func (refs skillReferenceFunc) views(skills []store.Skill) []adminSkillView {
	if skills == nil {
		return nil
	}
	rows := make([]adminSkillView, len(skills))
	for i, skill := range skills {
		rows[i] = refs.view(skill)
	}
	return rows
}

// A ref is an identity, never authorization. Call only after the endpoint's
// existing authorizeAdmin check. Ambiguity fails closed rather than picking one.
func matchSkillReference(skills []store.Skill, ref string, refs skillReferenceFunc) (store.Skill, bool, error) {
	var selected store.Skill
	found := false
	for _, skill := range skills {
		if subtle.ConstantTimeCompare([]byte(refs(skill.Name)), []byte(ref)) != 1 {
			continue
		}
		if found {
			return store.Skill{}, false, errors.New("ambiguous skill reference")
		}
		selected, found = skill, true
	}
	return selected, found, nil
}
func (s *Server) resolveSkillReference(ctx context.Context, ref string, refs skillReferenceFunc) (store.Skill, bool, error) {
	skills, err := s.db.ListSkills(ctx, "")
	if err != nil {
		return store.Skill{}, false, err
	}
	return matchSkillReference(skills, ref, refs)
}

// Presence is distinct from empty/null. Explicit invalid or duplicate selectors
// must never fall back to legacy name normalization.
type skillRefInput struct {
	present bool
	value   string
}

func (ref skillRefInput) MarshalJSON() ([]byte, error) { return json.Marshal(ref.value) }
func (ref *skillRefInput) UnmarshalJSON(data []byte) error {
	if ref.present {
		return errors.New("duplicate skill reference")
	}
	ref.present = true
	if string(data) == "null" {
		return errors.New("invalid skill reference")
	}
	if err := json.Unmarshal(data, &ref.value); err != nil {
		return errors.New("invalid skill reference")
	}
	if !validSkillReference(ref.value) {
		return errors.New("invalid skill reference")
	}
	return nil
}

type adminSkillTarget struct {
	name     string
	refs     skillReferenceFunc
	selected *store.Skill
}

// Reference-based actions keep the resolved private identity out of persisted audit text.
func (target adminSkillTarget) inputText(value string) string {
	if target.selected != nil {
		return value
	}
	return strings.TrimSpace(value)
}

func (target adminSkillTarget) auditIdentity() string {
	if target.selected != nil {
		return auditJSON(map[string]string{"skill_ref": target.refs(target.name)})
	}
	return target.name
}
func invalidSkillReference(w http.ResponseWriter) {
	writeOpenAIError(w, http.StatusBadRequest, "invalid skill reference selector", "invalid_request_error", "invalid_skill_reference")
}

// Name-only callers retain their documented TrimSpace behavior. Ref callers may
// omit the name or echo the exact stored name; no normalization/renaming occurs.
func (s *Server) adminSkillTarget(w http.ResponseWriter, r *http.Request, name string, ref skillRefInput) (adminSkillTarget, bool) {
	target := adminSkillTarget{name: strings.TrimSpace(name), refs: s.skillRefSnapshot()}
	if !ref.present {
		return target, true
	}
	w.Header().Set("Cache-Control", "no-store")
	if !validSkillReference(ref.value) {
		invalidSkillReference(w)
		return target, false
	}
	selected, found, err := s.resolveSkillReference(r.Context(), ref.value, target.refs)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "failed to resolve skill", "server_error", "skill_reference_failed")
		return target, false
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "skill not found", "invalid_request_error", "not_found")
		return target, false
	}
	if (name != "" && name != selected.Name) || strings.TrimSpace(selected.Name) == "" {
		invalidSkillReference(w)
		return target, false
	}
	target.name, target.selected = selected.Name, &selected
	return target, true
}

func (s *Server) adminSkillQueryTarget(w http.ResponseWriter, r *http.Request, nameKey string) (adminSkillTarget, bool) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		invalidSkillReference(w)
		return adminSkillTarget{}, false
	}
	ref := skillRefInput{}
	if values.Has("skill_ref") {
		if len(values["skill_ref"]) != 1 || values.Has(nameKey) {
			invalidSkillReference(w)
			return adminSkillTarget{}, false
		}
		ref = skillRefInput{present: true, value: values.Get("skill_ref")}
	}
	return s.adminSkillTarget(w, r, values.Get(nameKey), ref)
}
