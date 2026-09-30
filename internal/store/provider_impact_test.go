package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestProviderImpactReadIsBoundedAndNarrow(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	for _, name := range []string{"a", "b", "c"} {
		if err := db.UpsertProvider(t.Context(), ProviderConfig{Name: name, BaseURL: strings.Repeat("private-url", 10000), EncryptedAPIKey: strings.Repeat("cipher", 10000), ModelPatterns: strings.Repeat("private-pattern", 10000), FailoverGroup: "group", Enabled: true}); err != nil {
			t.Fatal(err)
		}
	}
	read, err := db.ProviderImpactConfigs(t.Context(), "", 2)
	if err != nil || !read.Truncated || read.Scanned != 2 || len(read.Rows) != 2 || read.Rows[0].Name != "a" {
		t.Fatalf("bounded provider projection: %+v err=%v", read, err)
	}
	exact, err := db.ProviderImpactConfigs(t.Context(), "c", 1)
	if err != nil || exact.Truncated || len(exact.Rows) != 1 || exact.Rows[0].FailoverGroup != "group" {
		t.Fatalf("exact provider projection: %+v err=%v", exact, err)
	}
	for _, statement := range []string{
		`ALTER TABLE provider_configs DROP COLUMN encrypted_api_key`,
		`ALTER TABLE provider_configs DROP COLUMN base_url`,
		`ALTER TABLE provider_configs DROP COLUMN model_patterns`,
	} {
		if _, err := db.db.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ProviderImpactConfigs(t.Context(), "", 2); err != nil {
		t.Fatalf("provider assessment depended on unrelated sensitive columns: %v", err)
	}
}

func TestProviderImpactReferencesBoundLegacyFieldsAndExcludePrompt(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	for _, route := range []AgentRoute{
		{ID: "a", VirtualModel: "vibe/a", Provider: "provider-a", BackingModel: "model-a", Enabled: true, SystemPrompt: strings.Repeat("secret", 20000)},
		{ID: "b", VirtualModel: "vibe/b", Provider: strings.Repeat("한", 100), BackingModel: "model-b"},
		{ID: "c", VirtualModel: "vibe/c", Provider: "provider-c"},
	} {
		if err := db.UpsertAgentRoute(t.Context(), route); err != nil {
			t.Fatal(err)
		}
	}
	for _, statement := range []string{
		`ALTER TABLE agent_routes DROP COLUMN system_prompt`,
		`ALTER TABLE agent_routes DROP COLUMN allowed_tools_json`,
		`ALTER TABLE agent_routes DROP COLUMN mcp_upstreams_json`,
	} {
		if _, err := db.db.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	read, err := db.ProviderImpactAgentReferences(t.Context(), 2)
	if err != nil || !read.Truncated || read.Scanned != 2 || len(read.Rows) != 1 || read.Rows[0].Provider != "provider-a" {
		t.Fatalf("agent projection: %+v err=%v", read, err)
	}
	if err := db.UpsertRoutingRule(t.Context(), RoutingRule{ID: "route-a", TargetProvider: "provider-a", TargetModel: "model-a", Note: strings.Repeat("private-note", 10000)}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.ExecContext(t.Context(), `ALTER TABLE routing_rules DROP COLUMN note`); err != nil {
		t.Fatal(err)
	}
	rules, err := db.ProviderImpactRoutingReferences(t.Context(), 2)
	if err != nil || rules.Truncated || len(rules.Rows) != 1 || rules.Rows[0].ID != "route-a" {
		t.Fatalf("rule projection: %+v err=%v", rules, err)
	}
}

func TestProviderImpactKeysRejectIncompleteAssessmentWithoutReadingCredentials(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	for _, id := range []string{"a", "b", "c"} {
		if err := db.UpsertAPIKey(t.Context(), APIKeyRecord{ID: id, Name: "private-name", KeyHash: id + "-hash", Owner: "private-owner", Team: "team-a", Status: "active", AllowedProviders: []string{"Provider-*"}, DeniedProviders: []string{"*-blocked"}, ExpiresAt: time.Now().UTC().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.db.ExecContext(t.Context(), `UPDATE api_keys SET allowed_providers = 'malformed' WHERE id = 'b'`); err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"key_hash", "name", "owner", "allowed_models", "denied_models"} {
		// key_hash has a UNIQUE constraint, so rename instead of DROP to establish
		// that the projection never refers to its production name on either DB.
		if _, err := db.db.ExecContext(t.Context(), `ALTER TABLE api_keys RENAME COLUMN `+column+` TO fixture_unused_`+column); err != nil {
			t.Fatal(err)
		}
	}
	read, err := db.ProviderImpactKeys(t.Context(), 2)
	if err != nil || !read.Truncated || read.Scanned != 2 || len(read.Rows) != 1 {
		t.Fatalf("key projection: %+v err=%v", read, err)
	}
	if read.Rows[0].Team != "team-a" || read.Rows[0].AllowedProviders[0] != "Provider-*" || read.Rows[0].ExpiresAt.IsZero() {
		t.Fatalf("provider access metadata changed: %+v", read.Rows[0])
	}
}

func TestProviderImpactTeamsFailClosedOnAmbiguityAndTruncation(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	for _, team := range []AuthTeam{{ID: "a", Name: "Alpha"}, {ID: "b", Name: "Beta"}, {ID: "c", Name: "a"}} {
		if err := db.UpsertAuthTeam(t.Context(), team); err != nil {
			t.Fatal(err)
		}
	}
	count, partial, err := db.ProviderImpactTeams(t.Context(), []string{"Alpha", "ALPHA", "b", "Beta", ""}, 10)
	if err != nil || partial || count != 2 {
		t.Fatalf("canonical teams count=%d partial=%v err=%v", count, partial, err)
	}
	count, partial, err = db.ProviderImpactTeams(t.Context(), []string{"a", "unknown", " Alpha", "b"}, 10)
	if err != nil || !partial || count != 1 {
		t.Fatalf("ambiguous teams count=%d partial=%v err=%v", count, partial, err)
	}
	count, partial, err = db.ProviderImpactTeams(t.Context(), []string{"Alpha"}, 1)
	if err != nil || !partial || count != 0 {
		t.Fatalf("truncated teams guessed unique ownership: count=%d partial=%v err=%v", count, partial, err)
	}
	if _, err := db.db.ExecContext(t.Context(), `DROP TABLE teams`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := db.ProviderImpactTeams(t.Context(), nil, 10); err == nil {
		t.Fatal("team storage failure became a zero count")
	}
}

func TestProviderImpactOptionalDataValidation(t *testing.T) {
	for _, raw := range []string{`["safe-*"]`, `[]`, `null`} {
		if _, valid := impactProviderPatterns(raw); !valid {
			t.Fatalf("valid provider list rejected: %s", raw)
		}
	}
	for _, raw := range []string{`[1]`, `["safe",`, `"provider"`, `["` + strings.Repeat("p", 257) + `"]`} {
		if _, valid := impactProviderPatterns(raw); valid {
			t.Fatal("unassessable provider list was accepted")
		}
	}
	if _, valid := impactOptionalTime("malformed"); valid {
		t.Fatal("malformed expiry became unexpired")
	}
	if _, valid := impactOptionalTime(""); !valid {
		t.Fatal("unset expiry rejected")
	}
}

func TestProviderImpactReadStopsOnContextCancellation(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := db.ProviderImpactConfigs(ctx, "", 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled provider read error=%v", err)
	}
	if _, _, err := db.ProviderImpactTeams(ctx, []string{"team"}, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled team read error=%v", err)
	}
	ctx, cancel = context.WithCancel(t.Context())
	defer cancel()
	_, err := readProviderImpact(ctx, db, "SELECT 1 UNION ALL SELECT 2", nil, 2, func(rows *sql.Rows) (int, bool, error) {
		var value int
		err := rows.Scan(&value)
		cancel()
		return value, true, err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("bounded row processing ignored cancellation: %v", err)
	}
}
