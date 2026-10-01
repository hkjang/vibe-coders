package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"vibe-coders/internal/store"
)

func TestProviderConnectionTestCredentialAndDestinationMatrix(t *testing.T) {
	for _, tc := range []struct {
		name, mode, key, storedKey, target, wantAuth, code string
		newName                                            bool
		status                                             int
	}{
		{"stored key", "stored", "", "stored-secret", "same", "Bearer stored-secret", "", false, 200},
		{"replace key", "draft", "new-secret", "stored-secret", "same", "Bearer new-secret", "", false, 200},
		{"changed destination stored key denied", "stored", "", "stored-secret", "changed", "", "provider_destination_changed", false, 409},
		{"changed destination explicit key", "draft", "new-secret", "stored-secret", "changed", "Bearer new-secret", "", false, 200},
		{"existing key none denied", "none", "", "stored-secret", "same", "", "stored_credential_present", false, 409},
		{"keyless existing none", "none", "", "", "same", "", "", false, 200},
		{"keyless existing changed none", "none", "", "", "changed", "", "", false, 200},
		{"missing stored key", "stored", "", "", "same", "", "stored_credential_unavailable", false, 409},
		{"new target draft", "draft", "new-secret", "stored-secret", "same", "Bearer new-secret", "", true, 200},
		{"new target none", "none", "", "stored-secret", "same", "", "", true, 200},
		{"new name collision never inherits", "none", "", "stored-secret", "collision", "", "provider_already_exists", true, 409},
		{"new name collision with replacement", "draft", "new-secret", "stored-secret", "collision", "", "provider_already_exists", true, 409},
		{"unknown reference", "stored", "", "stored-secret", "missing", "", "provider_not_found", false, 404},
		{"masked input", "stored", "", "stored-secret", "masked", "", "invalid_base_url", false, 400},
		{"unsafe stored destination", "stored", "", "stored-secret", "unsafe-stored", "", "provider_destination_changed", false, 409},
		{"unsafe stored safe replacement", "draft", "new-secret", "stored-secret", "unsafe-replace", "Bearer new-secret", "", false, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int64
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Header.Get("Authorization") != tc.wantAuth {
					t.Error("wrong credential selection")
				}
				if tc.mode == "none" {
					if _, exists := r.Header["Authorization"]; exists {
						t.Error("keyless mode must omit the Authorization header")
					}
				}
				if tc.target == "changed" && r.URL.Path != "/replacement/v1/models" {
					t.Error("edited draft did not reach its selected target")
				}
				_, _ = io.WriteString(w, `{"data":[]}`)
			}))
			t.Cleanup(upstream.Close)
			server, db, gateway := newConnectionTestServer(t)
			storedURL := upstream.URL
			if strings.HasPrefix(tc.target, "unsafe") {
				storedURL += "?token=stored-url-secret"
			}
			addAdminModelsProvider(t, server, db, store.ProviderConfig{Name: "existing", BaseURL: storedURL, Enabled: false, TimeoutMS: 4000, Priority: 37, ModelPatterns: "private-model", FailoverGroup: "private-group"}, tc.storedKey)
			before, err := db.ListProviders(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			body := map[string]any{"provider_ref": server.providerRef("existing"), "base_url": upstream.URL, "credential_mode": tc.mode}
			if tc.newName {
				delete(body, "provider_ref")
				body["name"] = "new-name"
			}
			switch tc.target {
			case "changed":
				body["base_url"] = upstream.URL + "/replacement"
			case "collision":
				body["name"] = " existing "
			case "missing":
				body["provider_ref"] = server.providerRef("missing")
			case "masked":
				body["base_url"] = invalidProviderURLDisplay
			}
			if tc.mode == "draft" {
				body["api_key"] = tc.key
			}
			status, result, raw := connectionPost(t, gateway.URL, "", body)
			if status != tc.status || tc.code != "" && !strings.Contains(raw, tc.code) || status == 200 && result.Outcome != "catalog_available" {
				t.Fatalf("unexpected result: status=%d body=%s", status, raw)
			}
			wantCalls := int64(0)
			if status == 200 {
				wantCalls = 1
			}
			after, err := db.ListProviders(t.Context())
			if err != nil || !reflect.DeepEqual(before, after) || calls.Load() != wantCalls {
				t.Fatalf("credential/destination denial mutated state or made a request: calls=%d err=%v", calls.Load(), err)
			}
			audits, err := db.ListAdminAudit(t.Context(), 10)
			if err != nil || len(audits) != int(wantCalls) {
				t.Fatal("unexpected connection audit count")
			}
			encoded, _ := json.Marshal(audits)
			for _, forbidden := range []string{"stored-secret", "new-secret", "stored-url-secret", "private-model", "private-group", upstream.URL} {
				if strings.Contains(string(encoded)+raw, forbidden) {
					t.Fatal("credential or provider metadata leaked to response/audit")
				}
			}
		})
	}
}

func TestProviderConnectionTestUsesCurrentStoredCredentialsWithoutSaveCAS(t *testing.T) {
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer current-secret" {
			t.Error("probe reused a former stored key")
		}
		_, _ = io.WriteString(w, `{"data":[]}`)
	}))
	t.Cleanup(upstream.Close)
	server, db, gateway := newConnectionTestServer(t)
	provider := store.ProviderConfig{Name: "existing", BaseURL: upstream.URL}
	addAdminModelsProvider(t, server, db, provider, "former-secret")
	ref := server.providerRef(provider.Name)
	addAdminModelsProvider(t, server, db, provider, "current-secret")
	status, result, _ := connectionPost(t, gateway.URL, "", map[string]any{"provider_ref": ref, "base_url": upstream.URL, "credential_mode": "stored"})
	if status != 200 || result.Outcome != "catalog_available" || calls.Load() != 1 {
		t.Fatal("current stored credential was not used")
	}
}

func TestProviderConnectionTestPreservesSaveURLSemantics(t *testing.T) {
	for _, mode := range []string{"draft", "none", "stored"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int64
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path != "/v1/v1/models" || r.URL.RawQuery != "deployment=tenant" {
					t.Errorf("probe diverged from existing save/path construction: %s", r.URL)
				}
				_, _ = io.WriteString(w, `{"data":[]}`)
			}))
			t.Cleanup(upstream.Close)
			server, db, gateway := newConnectionTestServer(t)
			baseURL := upstream.URL + "/v1?deployment=tenant/"
			body := map[string]any{"name": "new", "base_url": " " + baseURL + " ", "credential_mode": mode}
			if mode == "draft" {
				body["api_key"] = "new-key"
			}
			if mode == "stored" {
				addAdminModelsProvider(t, server, db, store.ProviderConfig{Name: "existing", BaseURL: baseURL}, "old-key")
				delete(body, "name")
				body["provider_ref"] = server.providerRef("existing")
			}
			status, result, raw := connectionPost(t, gateway.URL, "", body)
			if mode == "stored" {
				if status != 409 || !strings.Contains(raw, "provider_destination_changed") || calls.Load() != 0 {
					t.Fatal("stored key escaped to save-normalized changed query")
				}
			} else if status != 200 || result.Outcome != "catalog_available" || calls.Load() != 1 {
				t.Fatalf("new draft normalization failed: status=%d body=%s", status, raw)
			}
		})
	}
}
