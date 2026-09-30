package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestCostGuardConfigStrictPersistedParsing(t *testing.T) {
	for _, value := range []string{"true", "false", "1", "0"} {
		for _, threshold := range []string{"0", "47.25", " \t2.5\n", "1e2", "-0"} {
			config, err := costGuardConfigFromFlags(map[string]store.RuntimeFlag{
				"cost_guard_enabled":       {Value: value},
				"cost_guard_threshold_krw": {Value: threshold},
			})
			want, _ := parseFloat(threshold)
			if err != nil || config.Enabled != (value == "true" || value == "1") || config.ThresholdKRW != want {
				t.Fatalf("valid persisted config rejected: %q/%q", value, threshold)
			}
		}
	}
	for key, values := range map[string][]string{
		"cost_guard_enabled":       {"", "TRUE", " true", "false ", "yes", "2"},
		"cost_guard_threshold_krw": {"", "garbage", "-1", "NaN", "+Inf", "-Inf", "1e309"},
	} {
		for _, value := range values {
			if _, err := costGuardConfigFromFlags(map[string]store.RuntimeFlag{key: {Value: value}}); !errors.Is(err, errInvalidCostGuardConfig) {
				t.Fatalf("malformed persisted flag %q/%q was treated as confirmed", key, value)
			}
		}
	}
	if config, err := costGuardConfigFromFlags(nil); err != nil || config != (costGuardConfig{}) {
		t.Fatal("missing flags must remain confirmed false/zero")
	}
	for _, value := range []float64{-1, math.NaN(), math.Inf(1), math.Inf(-1)} {
		if validCostGuardThreshold(value) {
			t.Fatal("invalid input threshold accepted")
		}
	}
}

func costGuardConfigRequest(s *Server, method, body string, ctx context.Context) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	s.handleCostGuard(w, httptest.NewRequest(method, "/admin/cost", strings.NewReader(body)).WithContext(ctx))
	return w
}

func TestCostGuardConfigDatabaseFailureIsSafeAndDoesNotInvalidate(t *testing.T) {
	db, raw := impactFailureStore(t) // isolated SQLite file or PostgreSQL test schema
	s := &Server{db: db}
	if err := db.SetFlag(t.Context(), store.RuntimeFlag{Key: "cost_guard_enabled", Value: "true"}); err != nil {
		t.Fatal(err)
	}
	cached := s.costSnapshotCached(t.Context())
	if _, err := raw.ExecContext(t.Context(), "ALTER TABLE runtime_flags RENAME TO unavailable_runtime_flags"); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		w := costGuardConfigRequest(s, method, `{"enabled":false,"threshold_krw":1}`, t.Context())
		wantStatus, wantCode := 503, "cost_guard_config_unavailable"
		if method == http.MethodPost {
			wantStatus, wantCode = 500, "cost_guard_save_failed"
		}
		if w.Code != wantStatus || !strings.Contains(w.Body.String(), wantCode) || strings.Contains(w.Body.String(), "runtime_flags") || strings.Contains(w.Body.String(), "SQL") {
			t.Fatalf("storage error was hidden or leaked: status=%d", w.Code)
		}
		if s.costCache.Load() != cached {
			t.Fatal("failed request invalidated the runtime cache")
		}
	}
	if _, err := raw.ExecContext(t.Context(), "ALTER TABLE unavailable_runtime_flags RENAME TO runtime_flags"); err != nil {
		t.Fatal(err)
	}
	flags, err := db.GetRuntimeFlagSnapshot(t.Context(), costGuardFlagKeys)
	events, auditErr := db.ListAdminAudit(t.Context(), 20)
	if err != nil || auditErr != nil || len(flags) != 1 || flags["cost_guard_enabled"].Value != "true" || len(events) != 0 {
		t.Fatal("failed save changed flags or committed audit")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if read := costGuardConfigRequest(s, http.MethodGet, "", ctx); read.Code != 503 {
		t.Fatal("canceled GET hid its error behind a populated cache")
	}
	if write := costGuardConfigRequest(s, http.MethodPost, `{"enabled":false}`, ctx); write.Code != 500 || s.costCache.Load() != cached {
		t.Fatal("canceled POST reported success or invalidated cache")
	}
}

func TestCostGuardConfigSecondWriteFailureRollsBack(t *testing.T) {
	db, raw := impactFailureStore(t)
	s := &Server{db: db}
	before, err := db.SaveRuntimeFlagBatch(t.Context(), []store.RuntimeFlag{
		{Key: "cost_guard_enabled", Value: "false", Note: "keep"},
		{Key: "cost_guard_threshold_krw", Value: "47.25", Note: "keep"},
	}, costGuardFlagKeys)
	if err != nil {
		t.Fatal(err)
	}
	cached := s.costSnapshotCached(t.Context())
	statement := "CREATE TRIGGER reject_cost_threshold BEFORE INSERT ON runtime_flags WHEN NEW.key = 'cost_guard_threshold_krw' AND NEW.value = '99' BEGIN SELECT RAISE(FAIL, 'synthetic-private-storage-detail'); END"
	if os.Getenv("TEST_POSTGRES_DSN") != "" {
		statement = "ALTER TABLE runtime_flags ADD CONSTRAINT synthetic_private_storage_detail CHECK (key <> 'cost_guard_threshold_krw' OR value <> '99')"
	}
	if _, err := raw.ExecContext(t.Context(), statement); err != nil {
		t.Fatal(err)
	}
	w := costGuardConfigRequest(s, http.MethodPost, `{"enabled":true,"threshold_krw":99}`, t.Context())
	if w.Code != 500 || !strings.Contains(w.Body.String(), "cost_guard_save_failed") || strings.Contains(w.Body.String(), "synthetic") {
		t.Fatalf("second write failure did not return a safe storage error: %d", w.Code)
	}
	after, err := db.GetRuntimeFlagSnapshot(t.Context(), costGuardFlagKeys)
	events, auditErr := db.ListAdminAudit(t.Context(), 20)
	if err != nil || auditErr != nil || !reflect.DeepEqual(before, after) || len(events) != 0 || s.costCache.Load() != cached {
		t.Fatal("failed second flag write partially changed flags, metadata, audit or cache")
	}
}

func TestCostGuardConfigResponseOwnsCommittedSnapshotWithoutStats(t *testing.T) {
	db, raw := impactFailureStore(t)
	s := &Server{db: db}
	if _, err := raw.ExecContext(t.Context(), "ALTER TABLE token_usage RENAME TO unavailable_cost_stats"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ModelStats(t.Context(), time.Now().Add(-time.Hour)); err == nil {
		t.Fatal("statistics fault was not installed")
	}
	// The post-commit audit inserts a distinct later configuration. This proves
	// the response belongs to the save's transaction, not a follow-up flag read.
	statements := []string{"CREATE TRIGGER overwrite_cost_after_audit AFTER INSERT ON admin_audit_logs WHEN NEW.action = 'cost_guard.set' BEGIN UPDATE runtime_flags SET value = 'false' WHERE key = 'cost_guard_enabled'; UPDATE runtime_flags SET value = '99' WHERE key = 'cost_guard_threshold_krw'; END"}
	if os.Getenv("TEST_POSTGRES_DSN") != "" {
		statements = []string{
			"CREATE FUNCTION overwrite_cost_after_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE runtime_flags SET value = 'false' WHERE key = 'cost_guard_enabled'; UPDATE runtime_flags SET value = '99' WHERE key = 'cost_guard_threshold_krw'; RETURN NEW; END $$",
			"CREATE TRIGGER overwrite_cost_after_audit AFTER INSERT ON admin_audit_logs FOR EACH ROW WHEN (NEW.action = 'cost_guard.set') EXECUTE FUNCTION overwrite_cost_after_audit()",
		}
	}
	for _, statement := range statements {
		if _, err := raw.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	w := costGuardConfigRequest(s, http.MethodPost, `{"enabled":true,"threshold_krw":25.75}`, t.Context())
	var written costGuardConfig
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &written) != nil || written != (costGuardConfig{Enabled: true, ThresholdKRW: 25.75}) || s.costCache.Load() != nil {
		t.Fatalf("save response was replaced by post-commit state or filled the runtime cache: %d %+v", w.Code, written)
	}
	read := costGuardConfigRequest(s, http.MethodGet, "", t.Context())
	var current costGuardConfig
	if read.Code != 200 || json.Unmarshal(read.Body.Bytes(), &current) != nil || current != (costGuardConfig{ThresholdKRW: 99}) || s.costCache.Load() != nil {
		t.Fatal("uncached admin GET did not return the later stored snapshot independently of model stats")
	}
}
