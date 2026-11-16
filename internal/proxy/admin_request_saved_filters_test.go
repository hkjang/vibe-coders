package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestRequestSharedFiltersPreserveCriteriaAndReadonlyAccess(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "synthetic-filter-writer")
	s.cfg.Auth.AdminReadonlyToken = "synthetic-filter-reader"
	handler := s.Routes()
	call := func(method, path, token, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	created := call(http.MethodPost, "/admin/saved-filters", "synthetic-filter-writer", `{"name":"운영 오류","view":"requests","params":"model=production&status=5xx&tz=UTC&limit=25"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d", created.Code)
	}
	var envelope struct {
		Filter store.SavedFilter `json:"filter"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	id := envelope.Filter.ID
	if id == "" {
		t.Fatal("missing shared filter ID")
	}
	original, originalFound, err := db.GetSavedFilter(t.Context(), id)
	if err != nil || !originalFound {
		t.Fatal("created filter was not persisted")
	}
	for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete} {
		path := "/admin/saved-filters/" + id
		if method == http.MethodPost {
			path = "/admin/saved-filters"
		}
		denied := call(method, path, "synthetic-filter-reader", `{"name":"차단되어야 함","view":"requests","params":""}`)
		if denied.Code != http.StatusUnauthorized {
			t.Fatalf("readonly %s status = %d", method, denied.Code)
		}
	}
	listed := call(http.MethodGet, "/admin/saved-filters?view=requests", "synthetic-filter-reader", "")
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), id) {
		t.Fatal("readonly administrator cannot list shared request filters")
	}
	renamed := call(http.MethodPatch, "/admin/saved-filters/"+id, "synthetic-filter-writer", `{"name":"운영 장애 검토"}`)
	if renamed.Code != http.StatusOK {
		t.Fatalf("rename status = %d", renamed.Code)
	}
	filter, found, err := db.GetSavedFilter(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	if !found || filter.Name != "운영 장애 검토" || filter.Params != original.Params || filter.View != "requests" || !filter.CreatedAt.Equal(original.CreatedAt) {
		t.Fatal("rename changed fields other than the shared name")
	}
	removed := call(http.MethodDelete, "/admin/saved-filters/"+id, "synthetic-filter-writer", "")
	if removed.Code != http.StatusOK {
		t.Fatalf("delete status = %d", removed.Code)
	}
	audit := call(http.MethodGet, "/admin/audit-logs.csv", "synthetic-filter-reader", "")
	if audit.Code != http.StatusOK {
		t.Fatalf("audit status = %d", audit.Code)
	}
	for _, event := range []string{"saved_filter.create", "saved_filter.update", "saved_filter.delete"} {
		if !strings.Contains(audit.Body.String(), event) {
			t.Fatalf("missing audit action %s", event)
		}
	}
}
