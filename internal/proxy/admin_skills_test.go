package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/store"
)

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
