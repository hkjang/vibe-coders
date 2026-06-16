package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestEvaluateSkillPolicy(t *testing.T) {
	sk := store.Skill{AllowedModels: "gpt-*, qwen-plus", AllowedTools: "sql-runner, search"}
	cases := []struct {
		name   string
		model  string
		tools  []string
		wantOK bool
	}{
		{"model + tools ok", "gpt-4o", []string{"search"}, true},
		{"model not allowed", "claude-3", nil, false},
		{"tool not allowed", "qwen-plus", []string{"rm-rf"}, false},
		{"exact model ok", "qwen-plus", nil, true},
		{"empty model skips model check", "", []string{"search"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := evaluateSkillPolicy(sk, tc.model, tc.tools)
			if (len(v) == 0) != tc.wantOK {
				t.Fatalf("model=%q tools=%v → violations=%v, wantOK=%v", tc.model, tc.tools, v, tc.wantOK)
			}
		})
	}

	// No restrictions configured → everything passes.
	if v := evaluateSkillPolicy(store.Skill{}, "anything", []string{"any-tool"}); len(v) != 0 {
		t.Fatalf("unrestricted skill should allow all, got %v", v)
	}
}

func TestParseRequestToolNames(t *testing.T) {
	body := []byte(`{"model":"m","tools":[{"type":"function","function":{"name":"search"}},{"type":"function","function":{"name":"sql-runner"}}]}`)
	got := parseRequestToolNames(body)
	if len(got) != 2 || got[0] != "search" || got[1] != "sql-runner" {
		t.Fatalf("parseRequestToolNames = %v", got)
	}
	if legacy := parseRequestToolNames([]byte(`{"functions":[{"name":"calc"}]}`)); len(legacy) != 1 || legacy[0] != "calc" {
		t.Fatalf("legacy functions parse = %v", legacy)
	}
}

func TestSkillEnforceBlocks(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "e.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	server.skillsRuntime.Store(&config.SkillsConfig{Enforcement: "enforce"})
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	ctx := context.Background()
	if _, err := db.UpsertSkill(ctx, store.Skill{Name: "gpt-only", Status: "production", AllowedModels: "gpt-*"}, "tester"); err != nil {
		t.Fatal(err)
	}

	// A request that opts into the skill with a disallowed model is blocked before upstream.
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions", jsonReader(map[string]any{
		"model": "claude-3", "messages": []map[string]string{{"role": "user", "content": "hi"}},
	}))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Vibe-Skill", "gpt-only")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("enforce block = %d, want 403", resp.StatusCode)
	}
	if resp.Header.Get("X-Vibe-Skill-Policy") != "blocked" {
		t.Fatalf("policy header = %q", resp.Header.Get("X-Vibe-Skill-Policy"))
	}

	// The blocked attempt is recorded in the run log (recorded async — poll briefly).
	waitFor(t, 2e9, func() bool {
		runs, _ := db.ListSkillRuns(ctx, "gpt-only", 10)
		return len(runs) == 1 && runs[0].Status == "blocked"
	})

	// An unavailable (non-production) skill under enforce is also blocked.
	if _, err := db.UpsertSkill(ctx, store.Skill{Name: "draft-skill", Status: "draft"}, "tester"); err != nil {
		t.Fatal(err)
	}
	req2, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions", jsonReader(map[string]any{
		"model": "gpt-4o", "messages": []map[string]string{{"role": "user", "content": "hi"}},
	}))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("X-Vibe-Skill", "draft-skill")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusForbidden {
		t.Fatalf("unavailable skill enforce = %d, want 403", resp2.StatusCode)
	}
}

func TestSkillEvaluateAndSeed(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "v.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	// Seed the recommended starter skills.
	resp := postJSON(t, srv.URL+"/admin/skills/seed-recommended", "", map[string]any{})
	var seed struct {
		Seeded []string `json:"seeded"`
	}
	json.NewDecoder(resp.Body).Decode(&seed)
	resp.Body.Close()
	if len(seed.Seeded) != 3 {
		t.Fatalf("seed-recommended = %v", seed.Seeded)
	}

	// Dry-run the policy of a seeded skill (text2sql-safety-test-generator allows sql-runner).
	resp = postJSON(t, srv.URL+"/admin/skills/evaluate", "", map[string]any{
		"name": "text2sql-safety-test-generator", "model": "gpt-4o", "tools": []string{"sql-runner"},
	})
	var ev struct {
		Allowed    bool     `json:"allowed"`
		Violations []string `json:"violations"`
	}
	json.NewDecoder(resp.Body).Decode(&ev)
	resp.Body.Close()
	if !ev.Allowed {
		t.Fatalf("expected allowed, got violations %v", ev.Violations)
	}

	// A disallowed tool produces a violation.
	resp = postJSON(t, srv.URL+"/admin/skills/evaluate", "", map[string]any{
		"name": "text2sql-safety-test-generator", "tools": []string{"rm-rf"},
	})
	json.NewDecoder(resp.Body).Decode(&ev)
	resp.Body.Close()
	if ev.Allowed || len(ev.Violations) == 0 {
		t.Fatalf("expected a tool violation, got %+v", ev)
	}
}

func TestSkillRegistryLifecycle(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "s.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	// Create a draft skill (admin). Defaults applied: version/status/risk/metadata.
	resp := postJSON(t, srv.URL+"/admin/skills", "", map[string]any{
		"name": "text2sql-safety", "description": "SQL safety review", "owner": "data-platform",
		"allowed_models": "qwen-*", "allowed_tools": "sql-runner", "instructions": "Check SELECT-only.",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create skill = %d", resp.StatusCode)
	}
	var created struct {
		Skill store.Skill `json:"skill"`
	}
	json.NewDecoder(resp.Body).Decode(&created)
	resp.Body.Close()
	if created.Skill.Version != "0.1.0" || created.Skill.Status != "draft" || created.Skill.RiskLevel != "low" {
		t.Fatalf("defaults not applied: %+v", created.Skill)
	}

	// Invalid status rejected.
	resp = postJSON(t, srv.URL+"/admin/skills", "", map[string]any{"name": "bad", "status": "live"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid status = %d, want 400", resp.StatusCode)
	}
	resp.Body.Close()

	// Not yet production → absent from the caller-facing catalog.
	pubResp, _ := http.Get(srv.URL + "/v1/skills")
	var pub struct {
		Skills []map[string]any `json:"skills"`
	}
	json.NewDecoder(pubResp.Body).Decode(&pub)
	pubResp.Body.Close()
	if len(pub.Skills) != 0 {
		t.Fatalf("draft skill leaked to /v1/skills: %+v", pub.Skills)
	}

	// Promote to production.
	resp = postJSON(t, srv.URL+"/admin/skills", "", map[string]any{
		"name": "text2sql-safety", "status": "production", "risk_level": "medium", "version": "1.0.0",
		"allowed_models": "qwen-*", "allowed_tools": "sql-runner", "instructions": "Check SELECT-only.",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("promote = %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Now visible publicly (without instructions in the list view).
	pubResp, _ = http.Get(srv.URL + "/v1/skills")
	json.NewDecoder(pubResp.Body).Decode(&pub)
	pubResp.Body.Close()
	if len(pub.Skills) != 1 || pub.Skills[0]["name"] != "text2sql-safety" {
		t.Fatalf("production skill missing from catalog: %+v", pub.Skills)
	}
	if _, hasInstr := pub.Skills[0]["instructions"]; hasInstr {
		t.Fatalf("list view must not expose instructions")
	}

	// Detail view includes instructions + policy hints.
	detResp, _ := http.Get(srv.URL + "/v1/skills/text2sql-safety")
	var det struct {
		Skill map[string]any `json:"skill"`
	}
	json.NewDecoder(detResp.Body).Decode(&det)
	detResp.Body.Close()
	if det.Skill["instructions"] != "Check SELECT-only." || det.Skill["allowed_models"] != "qwen-*" {
		t.Fatalf("detail view incomplete: %+v", det.Skill)
	}

	// Record a run, then read it back via the admin log.
	if err := db.RecordSkillRun(context.Background(), store.SkillRun{
		SkillName: "text2sql-safety", SkillVersion: "1.0.0", Actor: "tester",
		Model: "qwen-plus", Status: "ok", CostKRW: 1.25, LatencyMS: 42,
	}); err != nil {
		t.Fatal(err)
	}
	runResp, _ := http.Get(srv.URL + "/admin/skills/runs?skill=text2sql-safety")
	var runs struct {
		Runs []store.SkillRun `json:"runs"`
	}
	json.NewDecoder(runResp.Body).Decode(&runs)
	runResp.Body.Close()
	if len(runs.Runs) != 1 || runs.Runs[0].Model != "qwen-plus" {
		t.Fatalf("skill run log = %+v", runs.Runs)
	}

	// Delete, then confirm it's gone from the public catalog.
	delReq, _ := http.NewRequest(http.MethodDelete, srv.URL+"/admin/skills/by-name/text2sql-safety", nil)
	delResp, err := http.DefaultClient.Do(delReq)
	if err != nil {
		t.Fatal(err)
	}
	delResp.Body.Close()
	if delResp.StatusCode != http.StatusOK {
		t.Fatalf("delete = %d", delResp.StatusCode)
	}
	missResp, _ := http.Get(srv.URL + "/v1/skills/text2sql-safety")
	missResp.Body.Close()
	if missResp.StatusCode != http.StatusNotFound {
		t.Fatalf("deleted skill still resolves = %d", missResp.StatusCode)
	}
}
