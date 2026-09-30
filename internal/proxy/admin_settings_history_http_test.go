package proxy

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"sort"
	"testing"

	"vibe-coders/internal/store"
)

const historyHTTPKey = "text2sql.default_limit"

// Equality is a rollback ambiguity check, not support for chronological SQL
// ordering of arbitrary offsets or noncanonical imported timestamps.
func TestSettingsHistorySameInstant(t *testing.T) {
	for _, tc := range []struct {
		name, left, right string
		want              bool
	}{
		{"same_raw_valid", "2000-01-01T00:00:00.1Z", "2000-01-01T00:00:00.1Z", true},
		{"same_raw_invalid", "invalid", "invalid", true},
		{"same_raw_empty", "", "", true},
		{"different_valid", "2000-01-01T00:00:00.1Z", "2000-01-01T00:00:00.101Z", false},
		{"different_invalid", "invalid-left", "invalid-right", false},
		{"left_invalid", "invalid", "2000-01-01T00:00:00Z", false},
		{"right_invalid", "2000-01-01T00:00:00Z", "invalid", false},
		{"equivalent_fraction", "2000-01-01T00:00:00.1Z", "2000-01-01T00:00:00.100Z", true},
		{"equivalent_offset", "2000-01-01T00:00:00.1Z", "2000-01-01T09:00:00.100+09:00", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := sameSettingHistoryInstant(tc.left, tc.right); got != tc.want {
				t.Errorf("sameSettingHistoryInstant=%v want=%v", got, tc.want)
			}
		})
	}
}

// These are controlled history-order regressions, not a reproduction of the
// unobserved timestamps in the original lifecycle race failure. Real HTTP PUTs
// create every value, version, history row and audit; only IDs/timestamps are
// subsequently fixed in the isolated test database. No API/store is mocked.
func TestSettingsHistoryHTTP(t *testing.T) {
	const prefix = "2026-09-15T03:00:00"
	const tie = prefix + ".123Z"
	for _, tc := range []struct {
		name       string
		values     []string
		times      []string
		largest    int
		guarded    bool
		wantStatus int
		wantValue  string
		wantCode   string
	}{
		{"fraction_prefix", []string{"50", "70"}, []string{prefix + ".12Z", prefix + ".123Z"}, -1, true, 200, "50", ""},
		{"whole_second", []string{"50", "70"}, []string{prefix + "Z", prefix + ".001Z"}, -1, true, 200, "50", ""},
		{"tie_aba_legacy", []string{"10", "50", "70", "50"}, []string{tie, tie, tie, tie}, 1, false, 409, "", "setting_conflict"},
		{"tie_aba_guarded", []string{"10", "50", "70", "50"}, []string{tie, tie, tie, tie}, 1, true, 409, "", "setting_conflict"},
		{"tie_initial_legacy", []string{"50", "70"}, []string{tie, tie}, 0, false, 409, "", "setting_conflict"},
		{"tie_initial_guarded", []string{"50", "70"}, []string{tie, tie}, 0, true, 409, "", "setting_conflict"},
		{"equal_instant", []string{"50", "70"}, []string{prefix + ".1Z", prefix + ".100Z"}, -1, true, 409, "", "setting_conflict"},
		{"ordered_aba", []string{"10", "50", "70", "50"}, []string{prefix + ".1Z", prefix + ".2Z", prefix + ".3Z", prefix + ".4Z"}, -1, true, 200, "70", ""},
		{"older_ties", []string{"10", "50", "70", "50"}, []string{prefix + ".1Z", prefix + ".1Z", prefix + ".2Z", prefix + ".3Z"}, -1, true, 200, "70", ""},
		{"single_initial", []string{"50"}, []string{tie}, -1, true, 400, "", "no_history"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// The existing PostgreSQL helper truncates schema names at 55 bytes.
			// Keep every distinct subtest name below that limit; do not parallelize.
			if len(t.Name())+1 > 55 {
				t.Fatal("test name would truncate its isolated PostgreSQL schema")
			}
			db, raw := impactFailureStore(t)
			_, server := serveAdminModelsTestStore(t, "", db)
			ids := historyHTTPSeed(t, db, server.URL, tc.values)
			historyHTTPFixTimes(t, raw, ids, tc.times, tc.largest)
			before := historyHTTPSnapshot(t, db)
			if before.current.ValueJSON != fmt.Sprintf("%q", tc.values[len(tc.values)-1]) || before.current.Version != len(tc.values) || before.current.UpdatedAt != tc.times[len(tc.times)-1] || len(before.history) != len(tc.values) {
				t.Fatal("controlled fixture does not match the committed PUT sequence")
			}
			// Retain the real API ordering, including the intentionally wrong
			// selected row on unfixed code. Supplying every optional guard must
			// not turn an ambiguous server-side choice into a safe rollback.
			selected, err := db.ListAdminSettingHistory(t.Context(), historyHTTPKey, 5)
			if err != nil || len(selected) == 0 {
				t.Fatal("cannot read selected history")
			}
			body := map[string]any{"key": historyHTTPKey, "reason": "controlled history regression"}
			if tc.guarded {
				body["expected_version"] = before.current.Version
				body["expected_updated_at"] = before.current.UpdatedAt
				body["expected_history_id"] = selected[0].ID
				body["expected_history_count"] = selected[0].HistoryCount
			}
			encoded, err := json.Marshal(body)
			if err != nil {
				t.Fatal("cannot encode synthetic rollback request")
			}
			response, out := req(t, http.MethodPost, server.URL+"/admin/settings/rollback", string(encoded))
			after := historyHTTPSnapshot(t, db)
			if response.StatusCode != tc.wantStatus {
				t.Errorf("rollback status=%d want=%d", response.StatusCode, tc.wantStatus)
			}
			if tc.wantStatus != http.StatusOK {
				errBody, _ := out["error"].(map[string]any)
				if errBody["code"] != tc.wantCode {
					t.Errorf("rollback code=%v want=%s", errBody["code"], tc.wantCode)
				}
				if !reflect.DeepEqual(before.current, after.current) {
					t.Errorf("rejected rollback changed synthetic setting value/version: %s/v%d -> %s/v%d", before.current.ValueJSON, before.current.Version, after.current.ValueJSON, after.current.Version)
				}
				if !reflect.DeepEqual(before.history, after.history) {
					t.Errorf("rejected rollback changed history: before=%d after=%d", len(before.history), len(after.history))
				}
				if !reflect.DeepEqual(before.audits, after.audits) {
					t.Errorf("rejected rollback changed audits: before=%d after=%d", len(before.audits), len(after.audits))
				}
				return
			}
			if out["value"] != tc.wantValue || after.current.ValueJSON != fmt.Sprintf("%q", tc.wantValue) || after.current.Version != before.current.Version+1 {
				t.Errorf("successful rollback did not restore %s at version %d; current=%s/v%d", tc.wantValue, before.current.Version+1, after.current.ValueJSON, after.current.Version)
			}
			historyHTTPAssertAppend(t, before, after, tc.wantValue)
		})
	}
}

func historyHTTPSeed(t *testing.T, db *store.SQLStore, base string, values []string) []string {
	t.Helper()
	seen := make(map[string]bool)
	ids := make([]string, 0, len(values))
	for _, value := range values {
		response, _ := req(t, http.MethodPut, base+"/admin/settings/by-key/"+historyHTTPKey, fmt.Sprintf(`{"value":%q}`, value))
		if response.StatusCode != http.StatusOK {
			t.Fatalf("synthetic PUT status=%d want=200", response.StatusCode)
		}
		history, err := db.ListAdminSettingHistory(t.Context(), historyHTTPKey, 20)
		if err != nil || len(history) != len(ids)+1 {
			t.Fatal("PUT did not append exactly one history row")
		}
		var added []store.AdminSettingHistory
		for _, row := range history {
			if !seen[row.ID] {
				added = append(added, row)
			}
		}
		if len(added) != 1 || added[0].NewValueJSON != fmt.Sprintf("%q", value) || added[0].IsSecret || added[0].Key != historyHTTPKey {
			t.Fatal("cannot identify the exact synthetic PUT history by ID-set difference")
		}
		old := ""
		if len(ids) > 0 {
			old = fmt.Sprintf("%q", values[len(ids)-1])
		}
		if added[0].OldValueJSON != old {
			t.Fatal("PUT history does not preserve its predecessor")
		}
		seen[added[0].ID] = true
		ids = append(ids, added[0].ID)
	}
	return ids
}

func historyHTTPFixTimes(t *testing.T, raw *sql.DB, ids, timestamps []string, largest int) {
	t.Helper()
	if len(ids) != len(timestamps) || len(ids) == 0 {
		t.Fatal("invalid controlled history fixture")
	}
	tx, err := raw.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal("cannot start isolated timestamp fixture transaction")
	}
	defer tx.Rollback()
	exact := func(query string, args ...any) {
		t.Helper()
		result, err := tx.ExecContext(t.Context(), query, args...)
		if err != nil {
			t.Fatal("isolated timestamp fixture update failed")
		}
		n, err := result.RowsAffected()
		if err != nil || n != 1 {
			t.Fatal("isolated timestamp fixture did not affect exactly one intended row")
		}
	}
	for i, id := range ids {
		newID := fmt.Sprintf("ash_%016x", i+1)
		if i == largest {
			newID = "ash_ffffffffffffffff"
		}
		// Numbered parameters work with the existing SQLite and pgx drivers.
		exact(`UPDATE admin_setting_history SET id=$1, changed_at=$2 WHERE key=$3 AND id=$4`, newID, timestamps[i], historyHTTPKey, id)
	}
	exact(`UPDATE admin_settings SET updated_at=$1 WHERE key=$2`, timestamps[len(timestamps)-1], historyHTTPKey)
	if err := tx.Commit(); err != nil {
		t.Fatal("cannot commit isolated timestamp fixture transaction")
	}
}

type historyHTTPState struct {
	current store.AdminSetting
	history []store.AdminSettingHistory
	audits  []store.AdminAuditPublic
}

func historyHTTPSnapshot(t *testing.T, db *store.SQLStore) historyHTTPState {
	t.Helper()
	current, found, err := db.GetAdminSetting(t.Context(), historyHTTPKey)
	if err != nil || !found || current.IsSecret {
		t.Fatal("cannot read non-secret synthetic setting")
	}
	history, err := db.ListAdminSettingHistory(t.Context(), historyHTTPKey, 20)
	if err != nil {
		t.Fatal("cannot read synthetic setting history")
	}
	audits, err := db.ListAdminAudit(t.Context(), 200)
	if err != nil || len(audits) >= 200 {
		t.Fatal("cannot capture all isolated audit rows")
	}
	// Comparison must not rely on timestamp ordering, including audit ties.
	sort.Slice(history, func(i, j int) bool { return history[i].ID < history[j].ID })
	sort.Slice(audits, func(i, j int) bool { return audits[i].ID < audits[j].ID })
	return historyHTTPState{current, history, audits}
}

func historyHTTPAssertAppend(t *testing.T, before, after historyHTTPState, value string) {
	t.Helper()
	oldHistory := make(map[string]store.AdminSettingHistory)
	for _, row := range before.history {
		row.HistoryCount++
		oldHistory[row.ID] = row
	}
	newHistory := 0
	for _, row := range after.history {
		if old, exists := oldHistory[row.ID]; exists {
			if !reflect.DeepEqual(old, row) {
				t.Error("successful rollback rewrote a pre-existing history row")
			}
		} else {
			newHistory++
			if row.OldValueJSON != before.current.ValueJSON || row.NewValueJSON != fmt.Sprintf("%q", value) || row.HistoryCount != int64(len(before.history)+1) {
				t.Error("appended rollback history has the wrong old/new value or count")
			}
		}
	}
	if len(after.history) != len(before.history)+1 || newHistory != 1 {
		t.Error("successful rollback did not append exactly one history row")
	}
	oldAudits := make(map[string]store.AdminAuditPublic)
	for _, row := range before.audits {
		oldAudits[row.ID] = row
	}
	newAudits := 0
	for _, row := range after.audits {
		if old, exists := oldAudits[row.ID]; exists {
			if !reflect.DeepEqual(old, row) {
				t.Error("successful rollback rewrote a pre-existing audit row")
			}
		} else {
			newAudits++
			if row.Action != "setting.rollback" {
				t.Error("successful rollback appended an unexpected audit action")
			}
		}
	}
	if len(after.audits) != len(before.audits)+1 || newAudits != 1 {
		t.Error("successful rollback did not append exactly one audit row")
	}
}
