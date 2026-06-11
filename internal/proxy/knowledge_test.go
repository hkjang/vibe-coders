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

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"사내 코딩 규칙":         "", // all non-ascii → empty (caller falls back)
		"Coding Standards": "coding-standards",
		"  API__Rules!! ":  "api__rules",
		"v2 Rules":         "v2-rules",
		"---":              "",
	}
	for in, want := range cases {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func newKnowledgeServer(t *testing.T) (*Server, *store.SQLStore) {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	server, err := NewServer(testConfig("http://example.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	return server, db
}

func TestExpandKnowledgePlaceholderAndHeader(t *testing.T) {
	s, db := newKnowledgeServer(t)
	ctx := context.Background()
	if err := db.UpsertKnowledge(ctx, store.KnowledgeSnippet{ID: "rules", Name: "Rules", Content: "ALWAYS write tests.", Enabled: true, TokenEstimate: 4}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertKnowledge(ctx, store.KnowledgeSnippet{ID: "style", Name: "Style", Content: "Use tabs.", Enabled: true, TokenEstimate: 2}); err != nil {
		t.Fatal(err)
	}

	// placeholder substitution
	body := []byte(`{"model":"m","messages":[{"role":"user","content":"{{kb:rules}}\nNow write code"}]}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(""))
	out, ids, tokens := s.expandKnowledge(req, body)
	if len(ids) != 1 || ids[0] != "rules" || tokens <= 0 {
		t.Fatalf("placeholder: ids=%v tokens=%d", ids, tokens)
	}
	if !strings.Contains(string(out), "ALWAYS write tests.") || strings.Contains(string(out), "{{kb:rules}}") {
		t.Fatalf("placeholder not expanded: %s", out)
	}

	// header prepend
	req2 := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(""))
	req2.Header.Set("X-Vibe-Knowledge", "style,rules")
	out2, ids2, _ := s.expandKnowledge(req2, []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`))
	if len(ids2) != 2 {
		t.Fatalf("header: expected 2 ids, got %v", ids2)
	}
	var root map[string]any
	_ = json.Unmarshal(out2, &root)
	msgs := root["messages"].([]any)
	first := msgs[0].(map[string]any)
	if first["role"] != "system" || !strings.Contains(first["content"].(string), "Use tabs.") {
		t.Fatalf("header prepend missing system message: %s", out2)
	}

	// unknown slug left intact, no expansion
	out3, ids3, _ := s.expandKnowledge(req, []byte(`{"model":"m","messages":[{"role":"user","content":"{{kb:nope}}"}]}`))
	if len(ids3) != 0 || !strings.Contains(string(out3), "{{kb:nope}}") {
		t.Fatalf("unknown slug should be untouched: ids=%v out=%s", ids3, out3)
	}

	// no placeholder, no header → exact no-op (same bytes)
	plain := []byte(`{"model":"m","messages":[{"role":"user","content":"hello"}]}`)
	out4, ids4, _ := s.expandKnowledge(httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader("")), plain)
	if len(ids4) != 0 || string(out4) != string(plain) {
		t.Fatalf("expected no-op, got ids=%v", ids4)
	}
}

func TestExpandKnowledgeSkipsDisabled(t *testing.T) {
	s, db := newKnowledgeServer(t)
	if err := db.UpsertKnowledge(context.Background(), store.KnowledgeSnippet{ID: "rules", Name: "Rules", Content: "secret", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"model":"m","messages":[{"role":"user","content":"{{kb:rules}}"}]}`)
	out, ids, _ := s.expandKnowledge(httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader("")), body)
	if len(ids) != 0 || !strings.Contains(string(out), "{{kb:rules}}") {
		t.Fatalf("disabled snippet must not expand: ids=%v out=%s", ids, out)
	}
}

func TestExpandContextRegistryPlaceholderAndHeader(t *testing.T) {
	s, db := newKnowledgeServer(t)
	ctx := context.Background()
	if err := db.UpsertContextRegistry(ctx, store.ContextRegistryEntry{ID: "ctx1", Key: "ctx_architecture", Name: "Architecture", Content: "Use hexagonal boundaries.", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertContextRegistry(ctx, store.ContextRegistryEntry{ID: "ctx2", Key: "ctx_api_standard", Name: "API", Content: "Return RFC7807 errors.", Enabled: true}); err != nil {
		t.Fatal(err)
	}

	body := []byte(`{"model":"m","messages":[{"role":"user","content":"{{ctx:ctx_architecture}}\nDesign it"}]}`)
	out, ids, tokens := s.expandKnowledge(httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader("")), body)
	if len(ids) != 1 || ids[0] != "ctx:ctx_architecture" || tokens <= 0 {
		t.Fatalf("context placeholder ids=%v tokens=%d", ids, tokens)
	}
	if !strings.Contains(string(out), "Use hexagonal boundaries.") || strings.Contains(string(out), "{{ctx:ctx_architecture}}") {
		t.Fatalf("context placeholder not expanded: %s", out)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(""))
	req.Header.Set("X-Vibe-Context", "ctx_api_standard")
	out2, ids2, _ := s.expandKnowledge(req, []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`))
	if len(ids2) != 1 || ids2[0] != "ctx:ctx_api_standard" {
		t.Fatalf("context header ids=%v", ids2)
	}
	if !strings.Contains(string(out2), "Return RFC7807 errors.") {
		t.Fatalf("context header not prepended: %s", out2)
	}
}

func TestKnowledgeCRUDEndpoint(t *testing.T) {
	s, db := newKnowledgeServer(t)
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()
	ctx := context.Background()

	// create (slug derived from name)
	resp := postJSON(t, proxy.URL+"/admin/knowledge", "", map[string]any{"name": "Coding Standards", "content": "Always handle errors."})
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("create failed: %d %s", resp.StatusCode, b)
	}
	resp.Body.Close()

	list, err := db.ListKnowledge(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != "coding-standards" || list[0].TokenEstimate <= 0 {
		t.Fatalf("unexpected snippet: %+v", list)
	}

	// disable via PATCH
	req, _ := http.NewRequest(http.MethodPatch, proxy.URL+"/admin/knowledge/coding-standards", strings.NewReader(`{"enabled":false}`))
	pr, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	pr.Body.Close()
	if pr.StatusCode != http.StatusOK {
		t.Fatalf("patch failed: %d", pr.StatusCode)
	}
	list, _ = db.ListKnowledge(ctx)
	if list[0].Enabled {
		t.Fatalf("snippet should be disabled")
	}

	// delete
	del, _ := http.NewRequest(http.MethodDelete, proxy.URL+"/admin/knowledge/coding-standards", nil)
	dr, err := http.DefaultClient.Do(del)
	if err != nil {
		t.Fatal(err)
	}
	dr.Body.Close()
	list, _ = db.ListKnowledge(ctx)
	if len(list) != 0 {
		t.Fatalf("expected empty after delete, got %d", len(list))
	}
}
