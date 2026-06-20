package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestAppVisibleTo(t *testing.T) {
	admin := accessClaims{Scopes: []string{"admin:read"}, Role: "admin"}
	dev := accessClaims{Role: "developer", TeamID: "team-a", Scopes: []string{"team:read"}}

	// Admin sees everything, including archived.
	if !appVisibleTo(store.WorkApp{Status: "archived"}, admin) {
		t.Error("admin should see archived apps")
	}
	// Non-admin can't see archived.
	if appVisibleTo(store.WorkApp{Status: "archived"}, dev) {
		t.Error("non-admin must not see archived apps")
	}
	// Open app (no gates) visible to anyone active.
	if !appVisibleTo(store.WorkApp{Status: "active"}, dev) {
		t.Error("ungated active app should be visible")
	}
	// Team gate: matching team passes, others blocked.
	if !appVisibleTo(store.WorkApp{Status: "active", AllowedTeams: "team-a,team-b"}, dev) {
		t.Error("matching team should pass")
	}
	if appVisibleTo(store.WorkApp{Status: "active", AllowedTeams: "team-x"}, dev) {
		t.Error("non-matching team should be blocked")
	}
	// Role gate.
	if appVisibleTo(store.WorkApp{Status: "active", AllowedRoles: "team_admin"}, dev) {
		t.Error("non-matching role should be blocked")
	}
	if !appVisibleTo(store.WorkApp{Status: "active", AllowedRoles: "developer"}, dev) {
		t.Error("matching role should pass")
	}
}

func TestAppComponentStep(t *testing.T) {
	skill := appComponentStep(store.AppComponent{Kind: "skill", Ref: "code-review"})
	if skill["action"] != "chat" || skill["endpoint"] != "/v1/chat/completions" {
		t.Errorf("skill step mapping wrong: %+v", skill)
	}
	rep := appComponentStep(store.AppComponent{Kind: "text2sql_report", Ref: "rep1"})
	if rep["action"] != "text2sql_report" || rep["endpoint"] != "/admin/text2sql/saved-reports/rep1" {
		t.Errorf("report step mapping wrong: %+v", rep)
	}
	model := appComponentStep(store.AppComponent{Kind: "model", Ref: "claude-opus-4-8"})
	if model["action"] != "model" {
		t.Errorf("model step mapping wrong: %+v", model)
	}
	unknown := appComponentStep(store.AppComponent{Kind: "weird"})
	if unknown["action"] != "unknown" {
		t.Errorf("unknown kind should map to unknown action: %+v", unknown)
	}
}

func TestWorkAppStore(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := t.Context()
	app := store.WorkApp{ID: "app1", Title: "Code Review", Components: []store.AppComponent{{Kind: "skill", Ref: "cr"}, {Kind: "model", Ref: "m1"}}, AllowedTeams: "team-a"}
	if err := db.CreateWorkApp(ctx, app); err != nil {
		t.Fatal(err)
	}
	got, found, err := db.GetWorkApp(ctx, "app1")
	if err != nil || !found || len(got.Components) != 2 || got.Components[0].Kind != "skill" {
		t.Fatalf("get app mismatch: found=%v comps=%+v err=%v", found, got.Components, err)
	}
	got.Status = "archived"
	if err := db.UpdateWorkApp(ctx, got); err != nil {
		t.Fatal(err)
	}
	got2, _, _ := db.GetWorkApp(ctx, "app1")
	if got2.Status != "archived" {
		t.Errorf("status update failed: %s", got2.Status)
	}
	if err := db.DeleteWorkApp(ctx, "app1"); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := db.GetWorkApp(ctx, "app1"); found {
		t.Error("app should be deleted")
	}
}
