package store

import (
	"context"
	"testing"
	"time"
)

func TestAdminAuditAnomalies(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	ins := func(admin, action string, when time.Time) {
		if err := db.InsertAdminAudit(ctx, AdminAuditLog{
			ID: action + "_" + admin + "_" + when.Format("150405.000000000"),
			AdminID: admin, Action: action, CreatedAt: when,
		}); err != nil {
			t.Fatal(err)
		}
	}

	// admin_destroyer: 6 delete actions (within window, daytime) → destructive_burst (high).
	noonToday := time.Date(now.Year(), now.Month(), now.Day(), 12, 0, 0, 0, time.UTC)
	if noonToday.After(now) {
		noonToday = now.Add(-2 * time.Hour)
	}
	for i := 0; i < 6; i++ {
		ins("admin_destroyer", "apikey.delete", noonToday.Add(time.Duration(i)*time.Minute))
	}
	// admin_priv: one scope change → privilege_changes (high).
	ins("admin_priv", "apikey.scopes.update", noonToday)
	// admin_quiet: a couple of benign reads → no flags.
	ins("admin_quiet", "template.upsert", noonToday)
	ins("admin_quiet", "pricing.seed", noonToday)

	anomalies, err := db.AdminAuditAnomalies(ctx, now.Add(-24*time.Hour), 5, 100)
	if err != nil {
		t.Fatal(err)
	}
	byAdmin := map[string]AdminAuditAnomaly{}
	for _, a := range anomalies {
		byAdmin[a.AdminID] = a
	}

	d, ok := byAdmin["admin_destroyer"]
	if !ok {
		t.Fatal("admin_destroyer should be flagged")
	}
	if d.DestructiveActions != 6 || !strListHas(d.Flags, "destructive_burst") || d.Severity != "high" {
		t.Errorf("destroyer = %+v, want 6 destructive / destructive_burst / high", d)
	}
	p, ok := byAdmin["admin_priv"]
	if !ok || !strListHas(p.Flags, "privilege_changes") || p.Severity != "high" {
		t.Errorf("admin_priv should be high with privilege_changes, got %+v", p)
	}
	if _, ok := byAdmin["admin_quiet"]; ok {
		t.Error("admin_quiet has no anomalies and should be omitted")
	}
	// High-severity entries sort first.
	if len(anomalies) > 0 && anomalies[0].Severity != "high" {
		t.Errorf("high severity should sort first, got %q", anomalies[0].Severity)
	}
}

func TestAdminAuditOffHours(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	// An action at 03:00 UTC (off-hours) within the window.
	threeAM := time.Date(now.Year(), now.Month(), now.Day(), 3, 0, 0, 0, time.UTC)
	if threeAM.After(now) {
		threeAM = threeAM.Add(-24 * time.Hour)
	}
	if err := db.InsertAdminAudit(ctx, AdminAuditLog{ID: "x1", AdminID: "night_owl", Action: "template.upsert", CreatedAt: threeAM}); err != nil {
		t.Fatal(err)
	}
	anomalies, err := db.AdminAuditAnomalies(ctx, now.Add(-48*time.Hour), 5, 100)
	if err != nil {
		t.Fatal(err)
	}
	var owl AdminAuditAnomaly
	for _, a := range anomalies {
		if a.AdminID == "night_owl" {
			owl = a
		}
	}
	if owl.OffHoursActions != 1 || !strListHas(owl.Flags, "off_hours") || owl.Severity != "medium" {
		t.Errorf("night_owl should be medium with off_hours, got %+v", owl)
	}
}
