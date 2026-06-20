package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func newStudioServer(t *testing.T) (*store.SQLStore, *httptest.Server) {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "studio.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	t.Cleanup(srv.Close)
	return db, srv
}

func TestSkillStudioCandidatesFromText2SQL(t *testing.T) {
	db, srv := newStudioServer(t)
	ctx := context.Background()
	for i := 0; i < 4; i++ {
		if err := db.InsertText2SQLLog(ctx, store.Text2SQLQueryLog{
			ID: "t2s_" + string(rune('a'+i)), Mode: "execute", Question: "지난달 팀별 매출 합계는?",
			GeneratedSQL: "SELECT team, SUM(amount) FROM sales GROUP BY team", Valid: true,
		}); err != nil {
			t.Fatal(err)
		}
	}

	resp, _ := http.Get(srv.URL + "/admin/skill-studio/candidates?min_count=2")
	var out struct {
		Candidates []skillCandidate `json:"candidates"`
		Count      int              `json:"count"`
		BySource   map[string]int   `json:"by_source"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if out.Count < 1 {
		t.Fatalf("expected >=1 candidate, got %+v", out)
	}
	var t2s *skillCandidate
	for i := range out.Candidates {
		if out.Candidates[i].Source == "text2sql" {
			t2s = &out.Candidates[i]
			break
		}
	}
	if t2s == nil {
		t.Fatalf("expected a text2sql candidate, sources=%+v", out.BySource)
	}
	if t2s.AlreadySkill {
		t.Fatal("candidate should not yet be an existing skill")
	}
	if t2s.SuggestedName == "" || t2s.Suggested.Instructions == "" {
		t.Fatalf("candidate should carry a suggested name + instructions: %+v", t2s)
	}
}

func TestSkillStudioAdoptCreatesDraft(t *testing.T) {
	db, srv := newStudioServer(t)
	ctx := context.Background()

	resp := postJSON(t, srv.URL+"/admin/skill-studio/adopt", "", map[string]any{
		"name": "Answer Monthly Sales", "description": "월별 매출 표준 답변",
		"instructions": "표준 절차로 답한다", "source": "text2sql", "risk_level": "medium",
		"signal": map[string]any{"count": 4},
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("adopt = %d", resp.StatusCode)
	}
	var out struct {
		Skill store.Skill `json:"skill"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if out.Skill.Status != "draft" {
		t.Fatalf("adopted skill must be draft, got %q", out.Skill.Status)
	}
	if out.Skill.Name != "answer-monthly-sales" {
		t.Fatalf("name should be slugified, got %q", out.Skill.Name)
	}
	// Metadata records the studio origin.
	sk, found, _ := db.GetSkill(ctx, "answer-monthly-sales")
	if !found || !strings.Contains(sk.Metadata, "skill_studio") {
		t.Fatalf("adopted skill should record studio origin: %+v", sk)
	}

	// Re-adopting the same name conflicts (idempotent guard).
	resp2 := postJSON(t, srv.URL+"/admin/skill-studio/adopt", "", map[string]any{"name": "Answer Monthly Sales"})
	if resp2.StatusCode != http.StatusConflict {
		t.Fatalf("re-adopt = %d, want 409", resp2.StatusCode)
	}
	resp2.Body.Close()
}

func TestSkillStudioReadinessGatesProduction(t *testing.T) {
	db, srv := newStudioServer(t)
	ctx := context.Background()

	// A bare staging skill: instructions only, no mandatory guardrails.
	if _, err := db.UpsertSkill(ctx, store.Skill{Name: "bare", Status: "staging", Instructions: "do"}, "tester"); err != nil {
		t.Fatal(err)
	}
	resp, _ := http.Get(srv.URL + "/admin/skill-studio/readiness?name=bare")
	var rd struct {
		ProductionReady bool          `json:"production_ready"`
		NextStatus      string        `json:"next_status"`
		Checks          []policyCheck `json:"checks"`
	}
	json.NewDecoder(resp.Body).Decode(&rd)
	resp.Body.Close()
	if rd.ProductionReady {
		t.Fatal("bare skill must not be production-ready")
	}
	if rd.NextStatus != "production" {
		t.Fatalf("staging skill next_status should be production, got %q", rd.NextStatus)
	}
	// The promote endpoint must also reject it (mandatory gate).
	pr := postJSON(t, srv.URL+"/admin/skills/promote", "", map[string]any{"name": "bare", "to_status": "production"})
	if pr.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("promote bare→production = %d, want 422", pr.StatusCode)
	}
	pr.Body.Close()

	// Fill every guardrail → readiness flips to true and promotion succeeds.
	if _, err := db.UpsertSkill(ctx, store.Skill{Name: "bare", Status: "staging", Instructions: "do",
		AllowedModels: "gpt-*", AllowedTools: "sql-runner", AllowedTeams: "team_data", DailyLimit: 50}, "tester"); err != nil {
		t.Fatal(err)
	}
	resp2, _ := http.Get(srv.URL + "/admin/skill-studio/readiness?name=bare")
	json.NewDecoder(resp2.Body).Decode(&rd)
	resp2.Body.Close()
	if !rd.ProductionReady {
		t.Fatalf("fully-configured skill should be production-ready, checks=%+v", rd.Checks)
	}
	pr2 := postJSON(t, srv.URL+"/admin/skills/promote", "", map[string]any{"name": "bare", "to_status": "production"})
	if pr2.StatusCode != http.StatusOK {
		t.Fatalf("promote fully-configured = %d, want 200", pr2.StatusCode)
	}
	pr2.Body.Close()
}
