package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestResourceSearchMCPMetadataAndReadPermission(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled = true
	s.cfg.Auth.JWTSecret = "synthetic-mcp-search-session-secret"
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(500)
	}))
	t.Cleanup(upstream.Close)
	for _, row := range []store.MCPUpstream{
		{ID: "search-safe", Name: "정산 서버", URL: upstream.URL, EncryptedAuth: "private-auth", Metadata: store.MCPUpstreamMetadata{Description: "private-definition"}},
		{ID: "search-mail", Name: "정산 person@example.com"},
		{ID: "search-comma", Name: "정산,서버"},
		{ID: "search/path", Name: "정산 잘못된 식별자"},
		{ID: "search-secret", Name: "정산 vc_sk_" + strings.Repeat("x", 43)},
	} {
		if err := db.UpsertMCPUpstream(t.Context(), row); err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range []struct {
		name   string
		scopes []string
		status string
	}{
		{"admin-only", []string{"admin:read"}, "forbidden"},
		{"writer-without-reader", []string{"admin:read", "mcp:admin"}, "forbidden"},
		{"read-only", []string{"admin:read", "observability:read"}, "ok"},
	} {
		t.Run(test.name, func(t *testing.T) {
			now := time.Now().UTC()
			if err := db.InsertAuthSession(t.Context(), test.name, "mcp-search-reader", "127.0.0.1", "fixture", now.Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			token, err := s.signAccessToken(accessClaims{Subject: "mcp-search-reader", Role: "admin", Scopes: test.scopes, SessionID: test.name, Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix()})
			if err != nil {
				t.Fatal(err)
			}
			w := resourceSearchRequest(s, `{"query":"정산","kinds":["mcp_upstream","workflow"]}`, token)
			var result struct {
				Groups []resourceSearchGroup `json:"groups"`
			}
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 2 {
				t.Fatal("MCP search response failed")
			}
			group := result.Groups[0]
			if group.Status != test.status || result.Groups[1].Status != "ok" {
				t.Fatal("MCP read permission or partial result boundary failed")
			}
			if test.status == "ok" {
				if len(group.Items) != 1 || group.Items[0].ID != "search-safe" || group.Items[0].Title != "정산 서버" {
					t.Fatal("unsafe MCP navigation metadata")
				}
			} else if len(group.Items) != 0 {
				t.Fatal("MCP results disclosed without list read permission")
			}
			for _, private := range []string{"private-auth", "private-definition", upstream.URL, "person@example.com", "vc_sk_", "search/path", "정산,서버"} {
				if strings.Contains(w.Body.String(), private) {
					t.Fatal("MCP search exposed excluded data")
				}
			}
		})
	}
	if calls.Load() != 0 {
		t.Fatal("metadata search contacted upstream")
	}
}

func TestResourceSearchMCPFeatureAndLegacyReadonly(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.AdminToken = "synthetic-full"
	s.cfg.Auth.AdminReadonlyToken = "synthetic-readonly"
	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{ID: "mcp-search", Name: "검색 서버"}); err != nil {
		t.Fatal(err)
	}
	body := `{"query":"검색","kinds":["provider","workflow","app","skill","mcp_upstream"]}`
	w := resourceSearchRequest(s, body, "synthetic-readonly")
	var result struct {
		Groups []resourceSearchGroup `json:"groups"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 5 || len(result.Groups[4].Items) != 1 {
		t.Fatal("five-kind read-only search failed")
	}
	for _, status := range []string{"hidden", "legacy"} {
		if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "ui.app.feature.mcp.overview.status", ValueJSON: `"` + status + `"`, ValueType: "string"}, "test", "search guard"); err != nil {
			t.Fatal(err)
		}
		w = resourceSearchRequest(s, body, "synthetic-readonly")
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Groups[4].Status != "forbidden" || len(result.Groups[4].Items) != 0 {
			t.Fatal("MCP feature visibility bypass")
		}
	}
}
