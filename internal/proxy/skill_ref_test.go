package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"vibe-coders/internal/secret"
	"vibe-coders/internal/store"
)

func TestSkillReferencesStableCanonicalAndRotation(t *testing.T) {
	a, _, _ := newAdminModelsTestServer(t, "")
	b, _, _ := newAdminModelsTestServer(t, "")
	refs := a.skillRefSnapshot()
	names := []string{" exact ", "exact", "/target/", "target", strings.Repeat("a", 4097), "sk-ant-opaque-fixture", "literal\x00control", "__proto__"}
	seen := map[string]bool{}
	for _, name := range names {
		ref := refs(name)
		if !validSkillReference(ref) || seen[ref] || ref != b.skillRefSnapshot()(name) {
			t.Fatal("unstable, invalid or colliding reference")
		}
		if ref == skillRefPrefix+a.secrets.Load().OpaqueReference("provider", name) {
			t.Fatal("reference domain not separated")
		}
		seen[ref] = true
	}
	rotated, err := secret.New("skill-reference-rotated-fixture")
	if err != nil {
		t.Fatal(err)
	}
	a.secrets.Store(rotated)
	if refs(names[0]) != b.skillRefSnapshot()(names[0]) || refs(names[0]) == a.skillRefSnapshot()(names[0]) {
		t.Fatal("snapshot/rotation contract broken")
	}
	valid := refs("exact")
	// Trailing base64 pad bits must be canonical, not simply URL-safe.
	for _, ref := range []string{"", " " + valid, valid + " ", valid + "=", strings.Replace(valid, "skl_", "prv_", 1), "skl_" + strings.Repeat("A", 42) + "B"} {
		if validSkillReference(ref) {
			t.Fatal("invalid reference accepted")
		}
	}
	_, found, err := matchSkillReference([]store.Skill{{Name: "one"}, {Name: "two"}}, valid, func(string) string { return valid })
	if found || err == nil {
		t.Fatal("ambiguous match picked a skill")
	}
}

func TestSkillReferenceExactReadAndWriteHTTP(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	server, gateway := serveAdminModelsTestStore(t, "ref-admin", db)
	refs := server.skillRefSnapshot()
	const metadata = `{"unchanged":["private","metadata"]}`
	names := []string{" exact ", "exact", strings.Repeat("a", 4097), "/target/", "target", "sk-ant-opaque-fixture", "__proto__"}
	for _, name := range names {
		if _, err := db.UpsertSkill(t.Context(), store.Skill{Name: name, Description: "original", Instructions: "instructions", Metadata: metadata}, "fixture"); err != nil {
			t.Fatal(err)
		}
	}
	list := exactSkillRequest(t, gateway.URL, "ref-admin", "GET", "/admin/skills", nil, 200)
	var catalog struct {
		Skills []adminSkillView `json:"skills"`
	}
	if json.Unmarshal(list, &catalog) != nil || len(catalog.Skills) != len(names) {
		t.Fatal("catalog changed")
	}
	for _, row := range catalog.Skills {
		if row.SkillRef != refs(row.Name) {
			t.Fatal("catalog reference mismatch")
		}
	}
	for _, name := range names {
		ref := refs(name)
		data := exactSkillRequest(t, gateway.URL, "ref-admin", "GET", "/admin/skills?"+url.Values{"view": {"detail"}, "skill_ref": {ref}}.Encode(), nil, 200)
		var detail struct {
			Skill adminSkillView `json:"skill"`
		}
		if json.Unmarshal(data, &detail) != nil || detail.Skill.Name != name || detail.Skill.SkillRef != ref || detail.Skill.Metadata != metadata {
			t.Fatal("exact reference detail changed identity/content")
		}
	}
	alias, _, err := db.GetSkill(t.Context(), "exact")
	if err != nil {
		t.Fatal(err)
	}
	ref := refs(" exact ")
	data := exactSkillRequest(t, gateway.URL, "ref-admin", "POST", "/admin/skills", map[string]any{"skill_ref": ref, "name": " exact ", "description": "changed", "status": "draft"}, 201)
	var saved struct {
		Skill adminSkillView `json:"skill"`
	}
	if json.Unmarshal(data, &saved) != nil || saved.Skill.Name != " exact " || saved.Skill.Metadata != metadata || saved.Skill.SkillRef != ref {
		t.Fatal("reference edit lost identity or omitted metadata")
	}
	assertExactSkillAlias(t, db, alias)
	exactSkillRequest(t, gateway.URL, "ref-admin", "POST", "/admin/skills/promote", map[string]any{"skill_ref": ref, "to_status": "staging"}, 200)
	promoted, _, err := db.GetSkill(t.Context(), " exact ")
	if err != nil || promoted.Status != "staging" {
		t.Fatal("reference promoted wrong target")
	}
	assertExactSkillAlias(t, db, alias)
	exactSkillRequest(t, gateway.URL, "ref-admin", "POST", "/admin/skills/fitness", map[string]any{"skill_ref": ref, "kind": "golden", "passed": true}, 201)
	exact, err := db.ListSkillFitnessEvidence(t.Context(), " exact ")
	if err != nil || len(exact) != 1 {
		t.Fatal("reference evidence wrong target")
	}
	other, err := db.ListSkillFitnessEvidence(t.Context(), "exact")
	if err != nil || len(other) != 0 {
		t.Fatal("alias received evidence")
	}
	for _, path := range []string{"/admin/skills/scan", "/admin/skill-studio/readiness"} {
		data := exactSkillRequest(t, gateway.URL, "ref-admin", "GET", path+"?skill_ref="+ref, nil, 200)
		var got struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(data, &got) != nil || got.Name != " exact " {
			t.Fatal("companion read selected alias")
		}
	}
	for _, path := range []string{"/admin/skills/fitness", "/admin/skills/promotions", "/admin/skills/runs"} {
		exactSkillRequest(t, gateway.URL, "ref-admin", "GET", path+"?skill_ref="+ref, nil, 200)
	}
	exactSkillRequest(t, gateway.URL, "ref-admin", "POST", "/admin/skills/evaluate", map[string]any{"skill_ref": ref}, 200)
	exactSkillRequest(t, gateway.URL, "ref-admin", "DELETE", "/admin/skills?skill_ref="+ref, nil, 200)
	if _, found, err := db.GetSkill(t.Context(), " exact "); err != nil || found {
		t.Fatal("reference did not delete selected identity")
	}
	assertExactSkillAlias(t, db, alias)
}

// PostgreSQL TEXT cannot contain NUL. Keep the shared database contract above
// valid for both engines while explicitly preserving SQLite's existing names.
func TestSQLiteSkillReferenceNULReadHTTP(t *testing.T) {
	db := openSQLiteTestStore(t, filepath.Join(t.TempDir(), "skill-nul.db"))
	server, gateway := serveAdminModelsTestStore(t, "ref-admin", db)
	const name = "literal\x00control"
	const metadata = `{"unchanged":["private","metadata"]}`
	if _, err := db.UpsertSkill(t.Context(), store.Skill{Name: name, Description: "original", Instructions: "instructions", Metadata: metadata}, "fixture"); err != nil {
		t.Fatal(err)
	}
	ref := server.skillRefSnapshot()(name)
	list := exactSkillRequest(t, gateway.URL, "ref-admin", "GET", "/admin/skills", nil, 200)
	var catalog struct {
		Skills []adminSkillView `json:"skills"`
	}
	if json.Unmarshal(list, &catalog) != nil || len(catalog.Skills) != 1 || catalog.Skills[0].Name != name || catalog.Skills[0].SkillRef != ref {
		t.Fatal("SQLite legacy name or catalogue reference changed")
	}
	data := exactSkillRequest(t, gateway.URL, "ref-admin", "GET", "/admin/skills?"+url.Values{"view": {"detail"}, "skill_ref": {ref}}.Encode(), nil, 200)
	var detail struct {
		Skill adminSkillView `json:"skill"`
	}
	if json.Unmarshal(data, &detail) != nil || detail.Skill.Name != name || detail.Skill.SkillRef != ref || detail.Skill.Metadata != metadata {
		t.Fatal("SQLite legacy NUL detail changed identity or content")
	}
}

func TestSkillReferenceInvalidAndStaleNeverFallBack(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	server, gateway := serveAdminModelsTestStore(t, "ref-admin", db)
	alias := seedExactSkillPair(t, db, " exact ", "exact")
	ref := server.skillRefSnapshot()(" exact ")
	before, err := db.ListSkills(t.Context(), "")
	if err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []any{"", nil, true, 123, "bad", " " + ref, ref + "="} {
		exactSkillRequest(t, gateway.URL, "ref-admin", "POST", "/admin/skills", map[string]any{"name": "exact", "skill_ref": invalid, "description": "wrong"}, 400)
	}
	exactSkillRequest(t, gateway.URL, "ref-admin", "POST", "/admin/skills", map[string]any{"name": "exact", "skill_ref": ref, "description": "wrong"}, 400)
	for _, query := range []string{"skill_ref=", "skill_ref=%zz", "skill_ref=" + ref + "&skill_ref=" + ref, "skill_ref=" + ref + "&skill=exact"} {
		exactSkillRequest(t, gateway.URL, "ref-admin", "GET", "/admin/skills/fitness?"+query, nil, 400)
	}
	for _, query := range []string{"", "skill_ref=" + ref + "&name=exact", "skill_ref=" + ref + "&all=true"} {
		exactSkillRequest(t, gateway.URL, "ref-admin", "DELETE", "/admin/skills?"+query, nil, 400)
	}
	exactSkillRequest(t, gateway.URL, "ref-admin", "GET", "/admin/skills?view=detail&name=exact&skill_ref="+ref, nil, 400)
	rotated, err := secret.New("rotated-skill-reference-fixture")
	if err != nil {
		t.Fatal(err)
	}
	server.secrets.Store(rotated)
	data := exactSkillRequest(t, gateway.URL, "ref-admin", "GET", "/admin/skills?view=detail&skill_ref="+ref, nil, 200)
	if !bytes.Equal(bytes.TrimSpace(data), []byte(`{"skill":null}`)) {
		t.Fatal("stale detail fell back")
	}
	exactSkillRequest(t, gateway.URL, "ref-admin", "POST", "/admin/skills", map[string]any{"name": "exact", "skill_ref": ref, "description": "wrong"}, 404)
	exactSkillRequest(t, gateway.URL, "ref-admin", "DELETE", "/admin/skills?skill_ref="+ref, nil, 404)
	after, err := db.ListSkills(t.Context(), "")
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("invalid/stale selector changed catalog")
	}
	assertExactSkillAlias(t, db, alias)
}

func TestSkillReferenceJWTAndFitnessGateBoundaries(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "skill-ref.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://unused.invalid", "fixture")
	cfg.Auth.Enabled, cfg.Auth.JWTSecret, cfg.Auth.AccessTokenTTL = true, "skill-reference-jwt-fixture", time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)
	const name, alias = " exact ", "exact"
	for _, n := range []string{name, alias} {
		_, err := db.UpsertSkill(t.Context(), store.Skill{Name: n, Status: "staging", RiskLevel: "high", Instructions: "Summarize the provided document.", AllowedModels: "model", AllowedTools: "read", AllowedTeams: "foreign-team", DailyLimit: 1}, "fixture")
		if err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := db.AddSkillFitnessEvidence(t.Context(), store.SkillFitnessEvidence{ID: itoaProxy(i), SkillName: alias, Kind: "golden", Passed: true}); err != nil {
			t.Fatal(err)
		}
	}
	ref := server.skillRefSnapshot()(name)
	before, err := db.ListSkills(t.Context(), "")
	if err != nil {
		t.Fatal(err)
	}
	for _, role := range []string{"super_admin", "readonly_admin", "team_admin"} {
		token := issueLLMScopedTestToken(t, db, server, "ref-"+role, role, "caller-team", []string{"admin:read"}, time.Now().UTC())
		exactSkillRequest(t, gateway.URL, token, "GET", "/admin/skills?view=detail&skill_ref="+ref, nil, 200)
		for _, path := range []string{"/admin/skills", "/admin/skills/promote", "/admin/skills/fitness"} {
			exactSkillRequest(t, gateway.URL, token, "POST", path, map[string]any{"skill_ref": ref, "to_status": "production"}, 401)
		}
		exactSkillRequest(t, gateway.URL, token, "DELETE", "/admin/skills?skill_ref="+ref, nil, 401)
	}
	denied := issueLLMScopedTestToken(t, db, server, "ref-denied", "developer", "caller-team", []string{"llm:invoke"}, time.Now().UTC())
	for _, token := range []string{"", denied, "invalid"} {
		exactSkillRequest(t, gateway.URL, token, "GET", "/admin/skills?view=detail&skill_ref="+ref, nil, 401)
	}
	token := issueLLMScopedTestToken(t, db, server, "ref-writer", "super_admin", "caller-team", []string{"admin:read", "admin:write"}, time.Now().UTC())
	data := exactSkillRequest(t, gateway.URL, token, "POST", "/admin/skills/promote", map[string]any{"skill_ref": ref, "to_status": "production", "note": "reviewed"}, 422)
	if !bytes.Contains(data, []byte("model_fitness_gate")) {
		t.Fatal("reference borrowed alias fitness evidence")
	}
	after, err := db.ListSkills(t.Context(), "")
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("denied/gated operations changed definitions")
	}
	for _, n := range []string{name, alias} {
		promotions, err := db.ListSkillPromotions(t.Context(), n, 10)
		if err != nil || len(promotions) != 0 {
			t.Fatal("denied/gated promotion wrote history")
		}
	}
}

func TestSkillReferenceInputRejectsNullDuplicateAndNonCanonical(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	server, gateway := serveAdminModelsTestStore(t, "ref-admin", db)
	_, err := db.UpsertSkill(t.Context(), store.Skill{Name: "protected-skill", Metadata: `{"keep":true}`}, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	ref := server.skillRefSnapshot()("protected-skill")
	for _, raw := range []string{
		`{"skill_ref":null,"name":"protected-skill"}`,
		`{"skill_ref":"` + ref + `","skill_ref":"` + ref + `"}`,
		`{"skill_ref":"` + ref + `","SKILL_REF":"` + ref + `"}`,
		`{"skill_ref":[],"name":"protected-skill"}`,
	} {
		exactSkillRequest(t, gateway.URL, "ref-admin", "POST", "/admin/skills", json.RawMessage(raw), 400)
	}
	current, _, err := db.GetSkill(t.Context(), "protected-skill")
	if err != nil || current.Metadata != `{"keep":true}` {
		t.Fatal("rejected body changed metadata")
	}
}

func TestSkillReferenceAuditDoesNotPersistResolvedName(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	server, gateway := serveAdminModelsTestStore(t, "ref-admin", db)
	const name = "sk-ant-private-skill-reference-fixture"
	_, err := db.UpsertSkill(t.Context(), store.Skill{Name: name, Status: "draft"}, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	ref := server.skillRefSnapshot()(name)
	exactSkillRequest(t, gateway.URL, "ref-admin", "POST", "/admin/skills", map[string]any{"skill_ref": ref, "description": "changed", "status": "draft"}, 201)
	exactSkillRequest(t, gateway.URL, "ref-admin", "POST", "/admin/skills/promote", map[string]any{"skill_ref": ref, "to_status": "staging"}, 200)
	exactSkillRequest(t, gateway.URL, "ref-admin", "POST", "/admin/skills/fitness", map[string]any{"skill_ref": ref, "kind": "golden", "passed": true}, 201)
	exactSkillRequest(t, gateway.URL, "ref-admin", "DELETE", "/admin/skills?skill_ref="+ref, nil, 200)
	audits, err := db.ListAdminAudit(t.Context(), 20)
	if err != nil || len(audits) != 4 {
		t.Fatal("expected mutation audit rows", err)
	}
	for _, row := range audits {
		if strings.Contains(row.BeforeValue, name) || strings.Contains(row.AfterValue, name) || !strings.Contains(row.BeforeValue, ref) {
			t.Fatal("reference mutation leaked its resolved name to audit")
		}
	}
}

func TestSkillReferenceEditPreservesStoredBytes(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	server, gateway := serveAdminModelsTestStore(t, "ref-admin", db)
	for _, metadata := range []string{"  {\n\"keep\": [1, 2]}  ", "null", "legacy-non-json", ""} {
		name := " imported "
		if _, err := db.UpsertSkill(t.Context(), store.Skill{Name: name, Metadata: metadata}, "fixture"); err != nil {
			t.Fatal(err)
		}
		before, _, err := db.GetSkill(t.Context(), name)
		if err != nil {
			t.Fatal(err)
		}
		body := map[string]any{"skill_ref": server.skillRefSnapshot()(name), "name": name, "description": " edited ", "owner": " owner ", "version": " version ", "allowed_models": " models ", "allowed_tools": " tools ", "allowed_teams": " teams "}
		exactSkillRequest(t, gateway.URL, "ref-admin", "POST", "/admin/skills", body, 201)
		after, _, err := db.GetSkill(t.Context(), name)
		if err != nil || after.Metadata != before.Metadata || after.Owner != " owner " || after.Version != " version " || after.AllowedModels != " models " || after.AllowedTools != " tools " || after.AllowedTeams != " teams " || after.Description != " edited " {
			t.Fatal("reference edit normalized stored content")
		}
	}
}
