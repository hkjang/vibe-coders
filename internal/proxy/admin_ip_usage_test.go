package proxy

import (
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestIPUsageHTTPAndOpenAPIContract(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "")
	when := time.Date(2026, 11, 12, 15, 10, 0, 0, time.UTC)
	for index, ip := range []string{"2001:0db8::1", "2001:db8::1", "192.0.2.10", "unknown"} {
		insertAppRequestTestRowWithIP(t, db, "ip-contract-"+string(rune('a'+index)), "provider-fixture", 200, ip, when)
	}
	read := func(path string, status int) map[string]any {
		t.Helper()
		response, err := http.Get(gateway.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != status || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("IP contract status/cache mismatch: %d", response.StatusCode)
		}
		var body map[string]any
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	list := read("/admin/ips", 200)["ips"].([]any)
	if len(list) != 4 {
		t.Fatal("IP list must retain exact legacy IPv6 groups")
	}
	for _, ip := range []string{"2001:0db8::1", "2001:db8::1", "192.0.2.10", "unknown"} {
		detail := read("/admin/ips/"+url.PathEscape(ip)+"?limit=1", 200)
		stats := detail["stats"].(map[string]any)
		if stats["ip"] != ip || stats["requests"] != float64(1) || stats["cost_krw"] != 1.25 || stats["tokens"] != float64(7) {
			t.Fatal("IP identity or aggregate drift")
		}
		day := detail["daily"].([]any)[0].(map[string]any)
		if day["date"] != "2026-11-13" || day["day"] != nil {
			t.Fatal("Expected Seoul date field, not day")
		}
		model := detail["by_model"].([]any)[0].(map[string]any)
		key := detail["by_key"].([]any)[0].(map[string]any)
		if model["key"] != "test-model" || model["model"] != nil || key["key"] == nil || key["api_key_id"] != nil {
			t.Fatal("Expected grouped key field")
		}
		recent := detail["recent"].([]any)
		if len(recent) != 1 || recent[0].(map[string]any)["estimated_cost"] != 1.25 || recent[0].(map[string]any)["cost_krw"] != nil {
			t.Fatal("Expected recent request estimated_cost")
		}
	}
	read("/admin/ips/192.0.2.99", 404)
	read("/admin/ips/not-an-ip", 400)
	read("/admin/ips/fe80::1%25eth0", 400)
	response, err := http.Post(gateway.URL+"/admin/ips", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 405 || response.Header.Get("Allow") != "GET" || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("IP method contract changed")
	}

	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	assertJSONOperationSchema(t, paths, "/admin/ips", "get", "200", "IPUsageList")
	assertJSONOperationSchema(t, paths, "/admin/ips/{ip}", "get", "200", "IPUsageDetail")
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	for name, field := range map[string]string{"IPUsageGroup": "key", "IPUsageDay": "date", "IPUsageRecent": "estimated_cost"} {
		if schemas[name].(map[string]any)["properties"].(map[string]any)[field] == nil {
			t.Fatal("OpenAPI missing runtime IP contract field")
		}
	}
}

func TestIPUsageUnauthorizedResponsesAreNotCached(t *testing.T) {
	_, _, gateway := newAdminModelsTestServer(t, "ip-contract-admin-fixture")
	for _, path := range []string{"/admin/ips", "/admin/ips/192.0.2.1"} {
		response, err := http.Get(gateway.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 401 || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("IP authorization/cache boundary changed")
		}
	}
}
