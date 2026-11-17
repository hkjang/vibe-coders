package proxy

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestRedTeamRunPageOpenAPI(t *testing.T) {
	s, _, _ := newAdminModelsTestServer(t, "")
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/openapi.json", nil))
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	var d map[string]any
	if json.Unmarshal(w.Body.Bytes(), &d) != nil {
		t.Fatal("json")
	}
	op := d["paths"].(map[string]any)["/admin/redteam/runs"].(map[string]any)["get"].(map[string]any)
	if len(op["parameters"].([]any)) != 13 {
		t.Fatal("missing page contract")
	}
}
