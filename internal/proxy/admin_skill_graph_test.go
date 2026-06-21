package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/store"
)

func TestSkillDependencyGraph(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()

	if _, err := db.UpsertSkill(ctx, store.Skill{
		Name: "code-reviewer", Status: "production", RiskLevel: "high",
		AllowedModels: "gpt-4,claude-*", AllowedTools: "shell", AllowedTeams: "alpha",
	}, "tester"); err != nil {
		t.Fatal(err)
	}

	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fb.ndjson"))
	logger.Start()
	defer logger.Stop(ctx)
	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp, err := http.Get(proxy.URL + "/admin/skills/dependency-graph")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	var out struct {
		Nodes  []map[string]any `json:"nodes"`
		Skills []struct {
			Name   string   `json:"name"`
			Models []string `json:"models"`
			Tools  []string `json:"tools"`
			Teams  []string `json:"teams"`
		} `json:"skills"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, body)
	}
	if len(out.Skills) != 1 || out.Skills[0].Name != "code-reviewer" {
		t.Fatalf("expected the production skill, got %+v", out.Skills)
	}
	sk := out.Skills[0]
	if len(sk.Models) != 2 || sk.Tools[0] != "shell" || sk.Teams[0] != "alpha" {
		t.Fatalf("dependencies not parsed: %+v", sk)
	}
	// Graph must contain skill + model + tool + team nodes.
	if len(out.Nodes) < 4 {
		t.Fatalf("expected >=4 nodes, got %d", len(out.Nodes))
	}
}
