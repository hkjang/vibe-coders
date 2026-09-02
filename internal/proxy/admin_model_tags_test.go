package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestAdminModelTagWriteReturnsPersistedTimestamp(t *testing.T) {
	_, _, gateway := newAdminModelsTestServer(t, "")
	createdResponse := postJSON(t, gateway.URL+"/admin/model-tags", "", map[string]any{
		"model":      "gpt-5",
		"good_for":   "coding",
		"risk_note":  "review required",
		"updated_at": "client-controlled",
	})
	defer createdResponse.Body.Close()
	if createdResponse.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(createdResponse.Body)
		t.Fatalf("create model tag status = %d body=%s", createdResponse.StatusCode, body)
	}
	var created store.ModelUsageTag
	if err := json.NewDecoder(createdResponse.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if _, err := time.Parse(time.RFC3339Nano, created.UpdatedAt); err != nil {
		t.Fatalf("created updated_at = %q: %v", created.UpdatedAt, err)
	}

	listedResponse, err := http.Get(gateway.URL + "/admin/model-tags")
	if err != nil {
		t.Fatal(err)
	}
	defer listedResponse.Body.Close()
	if listedResponse.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(listedResponse.Body)
		t.Fatalf("list model tags status = %d body=%s", listedResponse.StatusCode, body)
	}
	var listed struct {
		Tags []store.ModelUsageTag `json:"tags"`
	}
	if err := json.NewDecoder(listedResponse.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Tags) != 1 || listed.Tags[0].UpdatedAt != created.UpdatedAt {
		t.Fatalf("listed tags = %+v, want created updated_at %q", listed.Tags, created.UpdatedAt)
	}
}

func TestModelTagsReadOnlyRouteRejectsNonGetMethods(t *testing.T) {
	_, _, gateway := newAdminModelsTestServer(t, "")
	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			req, err := http.NewRequest(method, gateway.URL+"/v1/model-tags", nil)
			if err != nil {
				t.Fatal(err)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusMethodNotAllowed {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("%s /v1/model-tags status = %d body=%s, want 405", method, resp.StatusCode, body)
			}
		})
	}
}
