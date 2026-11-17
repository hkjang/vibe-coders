package proxy

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"vibe-coders/internal/store"
)

func TestContextMetadataSearchHTTPContract(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	for _, entry := range []store.ContextRegistryEntry{
		{ID: "ctx-a", Key: "alpha", Name: "한글 자료", Enabled: true, Content: "private-body-only", UseCount: 3},
		{ID: "ctx-b", Key: "beta", Name: "한글 자료", Enabled: true, Content: "private-body-only", UseCount: 7},
		{ID: "ctx-c", Key: "gamma", Name: "다른 자료", Enabled: false, Content: "private-body-only", UseCount: 9},
	} {
		if err := db.UpsertContextRegistry(t.Context(), entry); err != nil {
			t.Fatal(err)
		}
	}
	request := func(query string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/contexts?view=metadata&"+query, nil))
		return w
	}
	w := request("q=" + url.QueryEscape("한글") + "&state=enabled&sort=use_count:desc,key:asc&limit=1&offset=1")
	var result struct {
		Items []contextMetadataItem `json:"items"`
		Total int                   `json:"total"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Total != 2 || len(result.Items) != 1 || result.Items[0].Key != "alpha" {
		t.Fatal("search/sort page mismatch", w.Code)
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &raw) != nil || len(raw) != 6 {
		t.Fatal("legacy metadata response shape changed")
	}
	if strings.Contains(w.Body.String(), "private-") || strings.Contains(w.Body.String(), "ctx-") {
		t.Fatal("body or mutation identity leaked")
	}
	for _, q := range []string{"q=x&q=y", "sort=name:asc&sort=key:asc", "q=" + url.QueryEscape(strings.Repeat("한", 201)), "q=" + url.QueryEscape("token=private-credential"), "q=" + url.QueryEscape("https://user:private-password@example.test"), "q=line%0Abreak", "sort=name:asc,name:desc", "sort=content:asc", "sort=name:up"} {
		w = request(q)
		if w.Code != 400 || strings.Contains(w.Body.String(), "private-") || strings.Contains(w.Body.String(), "items") {
			t.Fatal("invalid/sensitive query was accepted or echoed", w.Code)
		}
	}
	w = request("q=private-body-only")
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Total != 0 {
		t.Fatal("search must not inspect stored content")
	}
}
