package proxy

import (
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestMonitorModelCatalogFilterAPIAndCursor(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "")
	now := time.Now().UTC()
	for i, row := range []struct{ id, endpoint, reason string }{
		{"real-old", "/v1/chat/completions", "rule"}, {"real-new", "/v1/embeddings", "rule"},
		{"catalog", "/v1/models", "models_aggregate"},
	} {
		if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{
			ID: row.id, TraceID: row.id, Endpoint: row.endpoint, RouteReason: row.reason, Model: row.id,
			StatusCode: 200, CreatedAt: now.Add(time.Duration(i-3) * time.Second),
		}}); err != nil {
			t.Fatal(err)
		}
	}
	page := readAppRequestPage(t, providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/requests?limit=1&exclude_models=true", nil))
	if len(page.Requests) != 1 || page.Requests[0].RequestID != "real-new" || page.NextCursor == "" {
		t.Fatalf("page=%+v", page)
	}
	for _, query := range []string{"exclude_models=yes", "exclude_models=true&exclude_models=false", "limit=1&cursor=" + url.QueryEscape(page.NextCursor)} {
		response := providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/requests?"+query, nil)
		response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("query=%s status=%d", query, response.StatusCode)
		}
	}
	unfiltered := readAppRequestPage(t, providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/requests?limit=10", nil))
	if len(unfiltered.Requests) != 3 {
		t.Fatal("ordinary request list lost catalog audit rows")
	}
	for _, path := range []string{"/admin/scatter?include_summary=true", "/admin/xview/models?top=10", "/admin/xview/model-series?bucket=hour", "/admin/xview/model-outliers?top=10"} {
		t.Run(path, func(t *testing.T) {
			response, err := http.Get(gateway.URL + path + "&exclude_models=true")
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			var body map[string]any
			if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusOK {
				t.Fatalf("status=%d body=%v", response.StatusCode, body)
			}
			if path == "/admin/scatter?include_summary=true" {
				if len(body["points"].([]any)) != 2 || len(body["groups"].([]any)) != 2 {
					t.Fatalf("scatter=%v", body)
				}
			} else if body["sample_size"] != float64(2) {
				t.Fatalf("aggregate=%v", body)
			}
		})
	}
	legacy, err := http.Get(gateway.URL + "/admin/scatter?limit=10")
	if err != nil {
		t.Fatal(err)
	}
	defer legacy.Body.Close()
	var full struct {
		Points []store.ScatterPoint `json:"points"`
	}
	if err := json.NewDecoder(legacy.Body).Decode(&full); err != nil || len(full.Points) != 3 {
		t.Fatalf("legacy=%+v err=%v", full, err)
	}
}

func TestMonitorModelCatalogSavedViewAndContract(t *testing.T) {
	for _, params := range []string{"window=1h&include_models=true", "include_models=false"} {
		if err := validateSavedFilterParams("xview", params); err != nil {
			t.Fatal(err)
		}
	}
	if err := validateSavedFilterParams("xview", "include_models=yes"); err == nil {
		t.Fatal("invalid saved visibility accepted")
	}
	paths := buildOpenAPISpec()["paths"].(map[string]any)
	for _, path := range []string{"/admin/requests", "/admin/scatter", "/admin/xview/delta", "/admin/xview/models", "/admin/xview/model-series", "/admin/xview/model-outliers"} {
		op := paths[path].(map[string]any)["get"].(map[string]any)
		responses := op["responses"].(map[string]any)
		if _, ok := responses["200"]; !ok {
			t.Errorf("%s lost its successful response while adding a filter", path)
		}
		if _, ok := responses["default"]; !ok {
			t.Errorf("%s lost its error contract", path)
		}
		found := false
		for _, value := range op["parameters"].([]any) {
			p := value.(map[string]any)
			found = found || p["name"] == "exclude_models"
		}
		if !found {
			t.Fatalf("%s missing filter contract", path)
		}
	}
}
