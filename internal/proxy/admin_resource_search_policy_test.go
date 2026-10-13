package proxy

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestResourceSearchPolicyPermissions(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled = true
	s.cfg.Auth.JWTSecret = "synthetic-policy-search-session-secret"
	if err := db.UpsertPolicyWithRules(t.Context(), store.Policy{ID: "policy-safe", Name: "정산 정책", Description: "private-policy-description"}, []store.PolicyRule{{ID: "rule-safe", Conditions: map[string]any{"team": "private-condition"}, Actions: map[string]any{"block": true}}}); err != nil {
		t.Fatal("policy fixture failed")
	}
	now := time.Now().UTC()
	for _, test := range []struct {
		name         string
		scopes       []string
		kinds        string
		status       int
		policyStatus string
	}{
		{"admin-only", []string{"admin:read"}, `["policy"]`, 200, "forbidden"},
		{"security-only", []string{"security:read"}, `["policy"]`, 200, "ok"},
		{"mixed", []string{"security:read"}, `["policy","workflow"]`, 200, "ok"},
		{"security-not-admin", []string{"security:read"}, `["workflow"]`, 403, ""},
		{"write-not-read", []string{"admin:write"}, `["policy"]`, 403, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := db.InsertAuthSession(t.Context(), test.name, "policy-reader", "127.0.0.1", "fixture", now.Add(time.Hour)); err != nil {
				t.Fatal("session fixture failed")
			}
			token, err := s.signAccessToken(accessClaims{Subject: "policy-reader", Role: "admin", Scopes: test.scopes, SessionID: test.name, Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix()})
			if err != nil {
				t.Fatal("session signing failed")
			}
			w := resourceSearchRequest(s, `{"query":"정산","kinds":`+test.kinds+`}`, token)
			if w.Code != test.status {
				t.Fatalf("status=%d expected=%d", w.Code, test.status)
			}
			if test.status != 200 {
				return
			}
			var result struct {
				Groups []resourceSearchGroup `json:"groups"`
			}
			if json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) == 0 {
				t.Fatal("invalid groups")
			}
			group := result.Groups[0]
			if group.Status != test.policyStatus {
				t.Fatal("policy scope boundary differs from policy list")
			}
			if test.policyStatus == "ok" && (len(group.Items) != 1 || group.Items[0].ID != "policy-safe") {
				t.Fatal("policy navigation missing")
			}
			if test.policyStatus == "forbidden" && len(group.Items) != 0 {
				t.Fatal("forbidden policy metadata exposed")
			}
			if len(result.Groups) == 2 && (result.Groups[1].Status != "forbidden" || len(result.Groups[1].Items) != 0) {
				t.Fatal("security reader gained admin search access")
			}
			if strings.Contains(w.Body.String(), "private-") || strings.Contains(w.Body.String(), "actions") {
				t.Fatal("policy definition exposed by metadata search")
			}
		})
	}
}

func TestResourceSearchPolicyFeatureAndProjection(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db}
	for _, policy := range []store.Policy{
		{ID: "safe", Name: "정산 안전 정책"},
		{ID: "unsafe-name", Name: "정산 person@example.com"},
		{ID: "vc_sk_" + strings.Repeat("x", 43), Name: "정산 식별자"},
	} {
		if err := db.UpsertPolicyWithRules(t.Context(), policy, nil); err != nil {
			t.Fatal("policy fixture failed")
		}
	}
	for _, status := range []string{"preview", "hidden", "legacy"} {
		if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "ui.app.feature.governance.policies.status", ValueJSON: `"` + status + `"`, ValueType: "string"}, "test", "search guard"); err != nil {
			t.Fatal("feature fixture failed")
		}
		w := resourceSearchRequest(s, `{"query":"정산","kinds":["policy"]}`, "")
		var result struct {
			Groups []resourceSearchGroup `json:"groups"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 1 {
			t.Fatal("invalid policy response")
		}
		if status == "preview" {
			if len(result.Groups[0].Items) != 1 || result.Groups[0].Items[0].ID != "safe" {
				t.Fatal("unsafe policy metadata exposed")
			}
		} else if result.Groups[0].Status != "forbidden" || len(result.Groups[0].Items) != 0 {
			t.Fatal("non-preview policy exposed")
		}
	}
}
