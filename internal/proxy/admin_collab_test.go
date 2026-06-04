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
	"time"

	"vibe-coders/internal/store"
)

func TestRequestNotesAndTagSearch(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	r := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", false))
	if r.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(r.Body)
		t.Fatalf("call failed: %d %s", r.StatusCode, body)
	}
	r.Body.Close()

	waitFor(t, time.Second, func() bool {
		s, _ := db.Summary(context.Background())
		return s.TotalRequests == 1
	})

	listResp, err := http.Get(proxy.URL + "/admin/requests?limit=1")
	if err != nil {
		t.Fatal(err)
	}
	defer listResp.Body.Close()
	var list struct {
		Requests []store.RecentRequest `json:"requests"`
	}
	if err := json.NewDecoder(listResp.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Requests) == 0 {
		t.Fatal("expected at least one request")
	}
	id := list.Requests[0].ID

	noteResp := postJSON(t, proxy.URL+"/admin/requests/"+id+"/note", "", map[string]any{
		"tags": []string{"의심", "재현필요"},
		"note": "토큰 폭주 의심",
	})
	if noteResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(noteResp.Body)
		t.Fatalf("note save failed: %d %s", noteResp.StatusCode, body)
	}
	noteResp.Body.Close()

	// recent endpoint must surface tag + note
	listResp2, err := http.Get(proxy.URL + "/admin/requests?limit=1")
	if err != nil {
		t.Fatal(err)
	}
	defer listResp2.Body.Close()
	var list2 struct {
		Requests []store.RecentRequest `json:"requests"`
	}
	if err := json.NewDecoder(listResp2.Body).Decode(&list2); err != nil {
		t.Fatal(err)
	}
	if len(list2.Requests[0].Tags) != 2 {
		t.Fatalf("expected 2 tags on request, got %v", list2.Requests[0].Tags)
	}
	if !strings.Contains(list2.Requests[0].Note, "폭주") {
		t.Fatalf("expected note saved, got %q", list2.Requests[0].Note)
	}

	// #tag search through /admin/prompts
	tagResp, err := http.Get(proxy.URL + "/admin/prompts?q=" + "%23%EC%9D%98%EC%8B%AC")
	if err != nil {
		t.Fatal(err)
	}
	defer tagResp.Body.Close()
	var tagRes struct {
		Requests []store.RecentRequest `json:"requests"`
	}
	if err := json.NewDecoder(tagResp.Body).Decode(&tagRes); err != nil {
		t.Fatal(err)
	}
	if len(tagRes.Requests) != 1 || tagRes.Requests[0].ID != id {
		t.Fatalf("expected tag search to find the request, got %#v", tagRes.Requests)
	}
}

func TestSavedFiltersCRUDAndAuditCSV(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig("http://example.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	create := postJSON(t, proxy.URL+"/admin/saved-filters", "", map[string]any{
		"name":   "최근 24h 오류",
		"view":   "prompts",
		"params": "language=Go&limit=200",
	})
	if create.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(create.Body)
		t.Fatalf("create failed: %d %s", create.StatusCode, body)
	}
	var created struct {
		Filter store.SavedFilter `json:"filter"`
	}
	if err := json.NewDecoder(create.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	create.Body.Close()
	if created.Filter.ID == "" {
		t.Fatal("expected filter id")
	}

	getResp, err := http.Get(proxy.URL + "/admin/saved-filters")
	if err != nil {
		t.Fatal(err)
	}
	defer getResp.Body.Close()
	var listed struct {
		Filters []store.SavedFilter `json:"filters"`
	}
	if err := json.NewDecoder(getResp.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Filters) != 1 {
		t.Fatalf("expected 1 filter, got %d", len(listed.Filters))
	}

	// Audit CSV should include the saved_filter.create entry
	csvResp, err := http.Get(proxy.URL + "/admin/audit-logs.csv")
	if err != nil {
		t.Fatal(err)
	}
	defer csvResp.Body.Close()
	body, _ := io.ReadAll(csvResp.Body)
	if !strings.Contains(string(body), "saved_filter.create") {
		t.Fatalf("expected audit CSV to mention saved_filter.create, got: %s", body)
	}

	// delete the filter
	req, _ := http.NewRequest(http.MethodDelete, proxy.URL+"/admin/saved-filters/"+created.Filter.ID, nil)
	delResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	delResp.Body.Close()
	if delResp.StatusCode != http.StatusOK {
		t.Fatalf("delete failed: %d", delResp.StatusCode)
	}
}
