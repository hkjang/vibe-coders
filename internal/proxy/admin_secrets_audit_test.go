package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vibe-coders/internal/secret"
	"vibe-coders/internal/store"
)

func TestSecretsRotateAuditFailurePreservesCipherAndData(t *testing.T) {
	db, raw := impactFailureStore(t)
	oldCipher, err := secret.New("synthetic-rotation-audit-old")
	if err != nil {
		t.Fatal(err)
	}
	enc, err := oldCipher.Encrypt("synthetic-rotation-audit-value")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
		Name: "rotation-audit", BaseURL: "http://127.0.0.1:9", EncryptedAPIKey: enc,
	}); err != nil {
		t.Fatal(err)
	}
	s := &Server{db: db}
	s.secrets.Store(oldCipher)
	if _, err := raw.ExecContext(t.Context(), "ALTER TABLE admin_audit_logs RENAME TO unavailable_rotation_audit"); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/admin/secrets/rotate", strings.NewReader(`{"new_secret":"synthetic-rotation-audit-new"}`)).WithContext(t.Context())
	w := httptest.NewRecorder()
	s.handleSecretsRotate(w, r)
	if w.Code != http.StatusInternalServerError || s.secrets.Load() != oldCipher {
		t.Error("audit failure must reject rotation without publishing a new cipher")
	}
	provider, found, err := db.GetProvider(t.Context(), "rotation-audit")
	if err != nil || !found || provider.EncryptedAPIKey != enc {
		t.Error("audit failure changed the stored provider key")
	}
	for _, forbidden := range []string{"admin_audit_logs", "SQL", "unavailable_rotation_audit", "synthetic-rotation-audit-value", "synthetic-rotation-audit-new", enc} {
		if strings.Contains(w.Body.String(), forbidden) {
			t.Error("rotation error exposed internal details or a credential")
		}
	}
}

func TestSecretsRotateAuditUsesAuthenticatedActor(t *testing.T) {
	f := newAPIKeyScopeContractFixture(t)
	f.request(t, http.MethodPost, "/admin/secrets/rotate", f.adminToken,
		`{"new_secret":"synthetic-authenticated-rotation-key"}`, http.StatusOK)
	audits, err := f.db.ListAdminAudit(t.Context(), 10)
	if err != nil {
		t.Fatal("rotation audit unavailable")
	}
	count := 0
	for _, audit := range audits {
		if audit.Action != "secrets.rotate" {
			continue
		}
		count++
		if audit.AdminID != "scope-contract-admin" {
			t.Fatal("rotation must audit the authenticated actor")
		}
	}
	if count != 1 {
		t.Fatal("rotation must commit exactly one authenticated audit")
	}
}
