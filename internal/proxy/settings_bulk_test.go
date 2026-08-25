package proxy

import (
	"net/http"
	"testing"
)

func TestAdminSettingsBulkExportImport(t *testing.T) {
	ts, _ := settingsServer(t)
	base := ts.URL + "/admin/settings"

	// Bulk apply two valid settings.
	resp, out := req(t, http.MethodPut, base+"/bulk",
		`{"settings":[{"key":"text2sql.preview_model","value":"m-prev"},{"key":"carbon.pue","value":"1.3"}],"reason":"batch"}`)
	if resp.StatusCode != http.StatusOK || out["applied"] != float64(2) {
		t.Fatalf("bulk apply = status %d %+v, want 200/applied=2", resp.StatusCode, out)
	}

	// Bulk with one invalid value → whole batch rejected (422), nothing applied.
	resp, _ = req(t, http.MethodPut, base+"/bulk",
		`{"settings":[{"key":"text2sql.summary_model","value":"ok"},{"key":"carbon.pue","value":"-5"}]}`)
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("invalid bulk should 422, got %d", resp.StatusCode)
	}
	// The valid sibling must NOT have been written (atomic).
	_, list := req(t, http.MethodGet, base+"/text2sql.models", "")
	for _, it := range list["settings"].([]any) {
		m := it.(map[string]any)
		if m["key"] == "text2sql.summary_model" && m["source"] == "admin" {
			t.Error("partial apply leaked: summary_model should remain env after a rejected batch")
		}
	}

	// Export returns the applied non-secret overrides.
	_, exp := req(t, http.MethodGet, base+"/export", "")
	expItems := exp["settings"].([]any)
	hasPrev := false
	for _, it := range expItems {
		m := it.(map[string]any)
		if m["key"] == "text2sql.preview_model" && m["value"] == "m-prev" {
			hasPrev = true
		}
		if m["key"] == "text2sql.exec_dsn" {
			t.Error("export must exclude secret keys")
		}
	}
	if !hasPrev {
		t.Error("export should include the applied preview_model override")
	}

	// Import rejects secret keys.
	resp, _ = req(t, http.MethodPost, base+"/import",
		`{"settings":[{"key":"text2sql.exec_dsn","value":"postgres://x"}]}`)
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("import of a secret key should 422, got %d", resp.StatusCode)
	}

	// Import a valid non-secret setting succeeds.
	resp, imp := req(t, http.MethodPost, base+"/import",
		`{"settings":[{"key":"text2sql.dialect","value":"MySQL"}],"reason":"import"}`)
	if resp.StatusCode != http.StatusOK || imp["applied"] != float64(1) {
		t.Fatalf("import valid setting = status %d %+v", resp.StatusCode, imp)
	}
}
