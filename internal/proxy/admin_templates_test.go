package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestPromptTemplatesCRUD(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	// Create with an unknown category → coerced to "custom"? No: "refactor" is valid.
	resp := postJSON(t, srv.URL+"/admin/templates", "", map[string]any{
		"name": "Refactor Pass", "category": "refactor", "description": "표준 리팩터링", "body": "다음 코드를 리팩터링해줘",
	})
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("create failed: %d %s", resp.StatusCode, body)
	}
	var created struct {
		Template store.PromptTemplate `json:"template"`
	}
	json.NewDecoder(resp.Body).Decode(&created)
	resp.Body.Close()
	if created.Template.ID != "refactor-pass" {
		t.Errorf("slug = %q, want refactor-pass", created.Template.ID)
	}
	if created.Template.Category != "refactor" {
		t.Errorf("category = %q, want refactor", created.Template.Category)
	}

	// Unknown category coerced to custom.
	resp2 := postJSON(t, srv.URL+"/admin/templates", "", map[string]any{
		"name": "Odd One", "category": "nonsense", "body": "x",
	})
	resp2.Body.Close()

	// List should contain both.
	listResp, err := http.Get(srv.URL + "/admin/templates")
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Templates  []store.PromptTemplate `json:"templates"`
		Categories []map[string]string    `json:"categories"`
	}
	json.NewDecoder(listResp.Body).Decode(&listed)
	listResp.Body.Close()
	if len(listed.Templates) != 2 {
		t.Fatalf("expected 2 templates, got %d", len(listed.Templates))
	}
	var odd store.PromptTemplate
	for _, tm := range listed.Templates {
		if tm.ID == "odd-one" {
			odd = tm
		}
	}
	if odd.Category != "custom" {
		t.Errorf("unknown category should coerce to custom, got %q", odd.Category)
	}
	if len(listed.Categories) == 0 {
		t.Error("expected category list in response")
	}

	// Patch disable.
	patch, _ := http.NewRequest(http.MethodPatch, srv.URL+"/admin/templates/refactor-pass", strings.NewReader(`{"enabled":false}`))
	patch.Header.Set("Content-Type", "application/json")
	pr, err := http.DefaultClient.Do(patch)
	if err != nil {
		t.Fatal(err)
	}
	pr.Body.Close()
	if pr.StatusCode != http.StatusOK {
		t.Fatalf("patch failed: %d", pr.StatusCode)
	}
	enabledOnly, _ := http.Get(srv.URL + "/admin/templates?enabled=1")
	var afterPatch struct {
		Templates []store.PromptTemplate `json:"templates"`
	}
	json.NewDecoder(enabledOnly.Body).Decode(&afterPatch)
	enabledOnly.Body.Close()
	for _, tm := range afterPatch.Templates {
		if tm.ID == "refactor-pass" {
			t.Error("disabled template should not appear in enabled=1 list")
		}
	}

	// Delete.
	del, _ := http.NewRequest(http.MethodDelete, srv.URL+"/admin/templates/refactor-pass", nil)
	dr, err := http.DefaultClient.Do(del)
	if err != nil {
		t.Fatal(err)
	}
	dr.Body.Close()
	if dr.StatusCode != http.StatusOK {
		t.Fatalf("delete failed: %d", dr.StatusCode)
	}
}
