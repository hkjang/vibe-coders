package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestResourceSearchMCPToolNamesAndPermission(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled = true
	s.cfg.Auth.JWTSecret = "synthetic-tool-search-session-secret"
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
	t.Cleanup(upstream.Close)
	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{ID: "search-server", Name: "검색 서버", URL: upstream.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	for i, row := range []struct {
		server, tool string
		mcp          bool
	}{
		{"server-a", "정산 도구", true}, {"server-b", "정산 도구", true},
		{"native", "정산 도구", false}, {"", "정산 도구", true},
		{"person@example.com", "정산 개인정보", true},
		{"vc_sk_" + strings.Repeat("x", 43), "정산 비밀", true},
		{"unsafe", "정산 vc_sk_" + strings.Repeat("x", 43), true},
		{"unsafe-space", " 정산 앞 공백", true},
	} {
		id := "tool-search-" + strconv.Itoa(i)
		now := time.Now().UTC()
		if err := db.InsertLogRecord(t.Context(), store.LogRecord{
			Request: store.RequestLog{ID: id, TraceID: id, StatusCode: 200, CreatedAt: now},
			Tools:   []store.ToolInvocation{{ID: id + "-tool", RequestID: id, TraceID: id, ServerLabel: row.server, ToolName: row.tool, IsMCP: row.mcp, Source: "definition", ArgHash: "private-search-arguments", CreatedAt: now}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name   string
		scopes []string
		status string
	}{
		{"reader", []string{"admin:read", "observability:read"}, "ok"},
		{"admin-only", []string{"admin:read"}, "forbidden"},
		{"writer-only", []string{"admin:read", "mcp:admin"}, "forbidden"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Now().UTC()
			if err := db.InsertAuthSession(t.Context(), tc.name, "tool-reader", "127.0.0.1", "fixture", now.Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			token, err := s.signAccessToken(accessClaims{Subject: "tool-reader", Role: "admin", Scopes: tc.scopes, SessionID: tc.name, Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix()})
			if err != nil {
				t.Fatal(err)
			}
			w := resourceSearchRequest(s, `{"query":"정산","kinds":["mcp_tool","workflow"]}`, token)
			var result struct {
				Groups []resourceSearchGroup `json:"groups"`
			}
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 2 || result.Groups[0].Status != tc.status || result.Groups[1].Status != "ok" {
				t.Fatal("tool search permission boundary failed")
			}
			items := result.Groups[0].Items
			if tc.status == "ok" {
				if len(items) != 3 || items[0].ServerLabel != "(none)" || items[1].ID != "정산 도구" || items[2].ID != "정산 도구" || items[1].ServerLabel != "server-a" || items[2].ServerLabel != "server-b" {
					t.Fatal("same-name tools lost exact server identity")
				}
			} else if len(items) != 0 {
				t.Fatal("tool navigation exposed without read permission")
			}
			for _, private := range []string{"person@example.com", "vc_sk_", "private-search-arguments", upstream.URL} {
				if strings.Contains(w.Body.String(), private) {
					t.Fatal("search disclosed excluded metadata")
				}
			}
		})
	}
	if calls.Load() != 0 {
		t.Fatal("metadata search performed upstream discovery")
	}
}

func TestResourceSearchMCPToolFeatureVisibility(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.AdminReadonlyToken = "synthetic-tool-reader"
	for _, status := range []string{"hidden", "legacy"} {
		if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "ui.app.feature.mcp.overview.status", ValueJSON: `"` + status + `"`, ValueType: "string"}, "test", "search guard"); err != nil {
			t.Fatal(err)
		}
		w := resourceSearchRequest(s, `{"query":"정산","kinds":["mcp_tool"]}`, "synthetic-tool-reader")
		var result struct {
			Groups []resourceSearchGroup `json:"groups"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 1 || result.Groups[0].Status != "forbidden" || len(result.Groups[0].Items) != 0 {
			t.Fatal("hidden MCP feature bypass")
		}
	}
}
