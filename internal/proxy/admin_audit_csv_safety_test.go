package proxy

import (
	"encoding/csv"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestAuditCSVSpreadsheetTextSafety(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	values := []string{"=1+1", "+1", "-1", "@SUM(1)", " \t=1", "\ufeff=1", "\tplain", "\nplain", "운영자, \"검토\"\n정상"}
	for i, value := range values {
		t.Run(value, func(t *testing.T) {
			at := time.Now().UTC().Add(time.Duration(i) * time.Second)
			if err := db.InsertAdminAudit(t.Context(), store.AdminAuditLog{ID: value, AdminID: value, Action: value, BeforeValue: value, AfterValue: value, CreatedAt: at}); err != nil {
				t.Fatal(err)
			}
			if err := db.InsertAlertEvent(t.Context(), store.AlertEvent{ID: value, RuleID: value, RuleName: value, CreatedAt: at}); err != nil {
				t.Fatal(err)
			}
			w := httptest.NewRecorder()
			s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/audit-logs.csv?limit=1", nil))
			if w.Code != 200 {
				t.Fatalf("status=%d", w.Code)
			}
			body := w.Body.String()
			if !strings.HasPrefix(body, "\ufeffcreated_at,") {
				t.Fatal("CSV BOM/header changed")
			}
			rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(body, "\ufeff"))).ReadAll()
			if err != nil || len(rows) != 3 {
				t.Fatalf("CSV rows=%d error=%v", len(rows), err)
			}
			want := "'" + value
			if i == len(values)-1 {
				want = value
			}
			for _, column := range []int{2, 3, 4, 5} {
				if rows[1][column] != want {
					t.Errorf("audit column %d was not preserved as spreadsheet text", column)
				}
			}
			if rows[2][2] != want {
				t.Error("alert actor was not preserved as spreadsheet text")
			}
		})
	}
}

func TestAuditCSVContractAccessAndRedaction(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "synthetic-audit-writer")
	s.cfg.Auth.AdminReadonlyToken = "synthetic-audit-reader"
	private := "https://example.invalid/?token=synthetic-audit-writer"
	for _, id := range []string{"first", "second"} {
		if err := db.InsertAdminAudit(t.Context(), store.AdminAuditLog{ID: id, AdminID: private, Action: "config.update", BeforeValue: private, AfterValue: private, CreatedAt: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
	}
	call := func(method, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/admin/audit-logs.csv?limit=1", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.Routes().ServeHTTP(w, r)
		return w
	}
	for _, token := range []string{"", "wrong"} {
		if w := call("GET", token); w.Code != 401 {
			t.Fatalf("denied status=%d", w.Code)
		}
	}
	for _, method := range []string{"POST", "DELETE", "HEAD"} {
		if w := call(method, "synthetic-audit-writer"); w.Code != 405 {
			t.Fatalf("method %s status=%d", method, w.Code)
		}
	}
	for _, token := range []string{"synthetic-audit-writer", "synthetic-audit-reader"} {
		w := call("GET", token)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/csv") {
			t.Fatalf("export status=%d", w.Code)
		}
		body := w.Body.String()
		rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(body, "\ufeff"))).ReadAll()
		if err != nil || len(rows) != 2 {
			t.Fatalf("limit/CSV rows=%d err=%v", len(rows), err)
		}
		if token == "synthetic-audit-reader" && strings.Contains(body, "synthetic-audit-writer") {
			t.Fatal("read-only export leaked protected credential")
		}
		if token == "synthetic-audit-writer" && !strings.Contains(body, private) {
			t.Fatal("raw-view projection changed")
		}
	}
}

func TestAuditCSVOpenAPIContract(t *testing.T) {
	paths := buildOpenAPISpec()["paths"].(map[string]any)
	op := paths["/admin/audit-logs.csv"].(map[string]any)["get"].(map[string]any)
	responses := op["responses"].(map[string]any)
	content := responses["200"].(map[string]any)["content"].(map[string]any)
	if len(content) != 1 || content["text/csv"].(map[string]any)["schema"].(map[string]any)["type"] != "string" {
		t.Fatal("CSV contract must return text")
	}
	if len(op["parameters"].([]any)) != 1 || op["requestBody"] != nil {
		t.Fatal("CSV query/body changed")
	}
	for _, status := range []string{"401", "405", "500"} {
		assertJSONOperationSchema(t, paths, "/admin/audit-logs.csv", "get", status, "AppError")
	}
}
