package store

import (
	"context"
	"testing"
	"time"

	"vibe-coders/internal/mail"
)

func TestMailDeliveriesRoundTrip(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Date(2026, 9, 16, 9, 0, 0, 0, time.UTC)

	first := mail.Delivery{ID: "mail_1", Event: mail.EventApprovalRequested, Recipient: "bob@corp.example", Subject: "승인 대기", SubjectID: "appr_1", ActorID: "u_alice", CreatedAt: now}
	second := mail.Delivery{ID: "mail_2", Event: mail.EventKeyBlocked, Recipient: "alice@corp.example", Subject: "키 차단", SubjectID: "key_1", CreatedAt: now.Add(time.Minute)}
	for _, delivery := range []mail.Delivery{first, second} {
		if err := db.RecordMailDelivery(ctx, delivery); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.CompleteMailDelivery(ctx, "mail_1", mail.StatusSent, 1, "", now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := db.CompleteMailDelivery(ctx, "mail_2", mail.StatusFailed, 2, "connection refused", now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}

	all, err := db.ListMailDeliveries(ctx, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || all[0].ID != "mail_2" || all[0].Status != mail.StatusFailed || all[0].Attempts != 2 || all[0].ErrorMessage != "connection refused" ||
		all[1].Status != mail.StatusSent || !all[1].UpdatedAt.Equal(now.Add(time.Second)) || all[1].ActorID != "u_alice" {
		t.Fatalf("list = %+v", all)
	}
	failed, err := db.ListMailDeliveries(ctx, mail.StatusFailed, 10)
	if err != nil || len(failed) != 1 || failed[0].ID != "mail_2" {
		t.Fatalf("failed filter = %+v, %v", failed, err)
	}
	counts, err := db.MailDeliveryCounts(ctx)
	if err != nil || counts[mail.StatusSent] != 1 || counts[mail.StatusFailed] != 1 {
		t.Fatalf("counts = %v, %v", counts, err)
	}

	// "Once per key per day" reads the log rather than a second table, and a
	// failed attempt counts: a dead relay must not turn into a retry per request.
	seen, err := db.MailDeliveryAttemptedSince(ctx, mail.EventKeyBlocked, "alice@corp.example", "key_1", now.Add(-time.Hour))
	if err != nil || !seen {
		t.Fatalf("attempted since = %v, %v; want true", seen, err)
	}
	seen, err = db.MailDeliveryAttemptedSince(ctx, mail.EventKeyBlocked, "alice@corp.example", "key_1", now.Add(2*time.Hour))
	if err != nil || seen {
		t.Fatalf("attempted since later = %v, %v; want false", seen, err)
	}
	seen, _ = db.MailDeliveryAttemptedSince(ctx, mail.EventKeyBlocked, "alice@corp.example", "key_2", now.Add(-time.Hour))
	if seen {
		t.Fatal("a different key must not count as already notified")
	}

	// Rows beyond the retention window go when the next one is written.
	stale := mail.Delivery{ID: "mail_old", Event: mail.EventTest, Recipient: "x@corp.example", CreatedAt: now.Add(-mailDeliveryRetention - time.Hour)}
	if err := db.RecordMailDelivery(ctx, stale); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordMailDelivery(ctx, mail.Delivery{ID: "mail_3", Event: mail.EventTest, Recipient: "y@corp.example", CreatedAt: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	all, _ = db.ListMailDeliveries(ctx, "", 0)
	for _, delivery := range all {
		if delivery.ID == "mail_old" {
			t.Fatal("stale delivery survived the prune")
		}
	}
	if len(all) != 3 {
		t.Fatalf("after prune = %d rows, want 3", len(all))
	}
}

func TestLookupUserEmailsBorrowsTheUsersTable(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	for _, user := range []AuthUser{
		{ID: "u_alice", Email: "alice@corp.example", Name: "Alice", Role: "admin", Status: "active"},
		{ID: "u_gone", Email: "gone@corp.example", Name: "Gone", Role: "developer", Status: "disabled"},
	} {
		if err := db.CreateAuthUser(ctx, user); err != nil {
			t.Fatal(err)
		}
	}
	emails, err := db.LookupUserEmails(ctx, []string{"u_alice", "u_gone", "u_missing", "alice@corp.example", ""})
	if err != nil {
		t.Fatal(err)
	}
	if len(emails) != 2 || emails["u_alice"] != "alice@corp.example" || emails["alice@corp.example"] != "alice@corp.example" {
		t.Fatalf("emails = %v; want alice by id and by address only", emails)
	}
}
