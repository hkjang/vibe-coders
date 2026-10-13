package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestSelfServiceRotationRequestValidation(t *testing.T) {
	revision := strings.Repeat("a", 64)
	for _, tc := range []struct {
		name  string
		body  string
		valid bool
	}{
		{"legacy-empty", "", true}, {"legacy-object", "{}", true}, {"legacy-reason", `{"reason":" 정기 교체 "}`, true},
		{"review", `{"reason":"정기 교체","expected_revision":"` + revision + `","grace_seconds":86400}`, true},
		{"review-immediate", `{"reason":"정기 교체","expected_revision":"` + revision + `","grace_seconds":0}`, true},
		{"missing-review", `{"grace_seconds":60}`, false},
		{"missing-reason", `{"expected_revision":"` + revision + `"}`, false},
		{"null", "null", false}, {"array", "[]", false}, {"extra-document", "{}{}", false},
		{"null-reason", `{"reason":null}`, false}, {"empty-reason", `{"reason":" "}`, false},
		{"long-reason", `{"reason":"` + strings.Repeat("가", 1025) + `"}`, false},
		{"oversized", strings.Repeat(" ", 8193), false}, {"invalid-utf8", string([]byte{255}), false},
		{"duplicate", `{"reason":"first","reason":"second"}`, false}, {"unknown", `{"unexpected":1}`, false},
		{"case-alias", `{"Reason":"test"}`, false}, {"bad-revision", `{"expected_revision":"bad"}`, false},
		{"null-grace", `{"grace_seconds":null}`, false}, {"fraction-grace", `{"grace_seconds":1.5}`, false},
		{"negative-grace", `{"grace_seconds":-1}`, false}, {"excess-grace", `{"grace_seconds":86401}`, false},
		{"string-grace", `{"grace_seconds":"60"}`, false}, {"null-revision", `{"expected_revision":null}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/me/keys/fixture/rotate", strings.NewReader(tc.body))
			_, err := readKeyRotationRequest(httptest.NewRecorder(), r)
			if (err == nil) != tc.valid {
				t.Fatal("rotation request validation mismatch")
			}
		})
	}
}

func TestSelfServiceRotationReviewedGraceLifecycle(t *testing.T) {
	ts, db := meKeysServer(t, true)
	key := store.APIKeyRecord{ID: "grace-target", Name: "유예 기간 검사", KeyHash: hashProxyKey("synthetic-grace-secret"), UserID: "u1", Team: "t1", Role: "developer", Status: "active", Scopes: []string{"models:read"}, ExpiresAt: time.Now().UTC().Add(time.Hour)}
	if err := db.UpsertAPIKey(t.Context(), key); err != nil {
		t.Fatal("seed failed")
	}
	key, _, _ = db.GetAPIKey(t.Context(), key.ID)
	keys, err := db.ListAPIKeys(t.Context())
	if err != nil {
		t.Fatal("review catalog failed")
	}
	revision := ""
	for _, public := range keys {
		if public.ID == key.ID {
			revision = public.Revision
		}
	}
	expectedRevision, err := db.APIKeyRevision(t.Context(), key)
	if err != nil || revision == "" || revision != expectedRevision {
		t.Fatal("public snapshot revision mismatch")
	}
	resp := postJSON(t, ts.URL+"/me/keys/"+key.ID+"/rotate", "usersecret", map[string]any{"reason": "정기 교체", "expected_revision": revision, "grace_seconds": 1})
	var result struct {
		Secret      string    `json:"secret"`
		GraceEndsAt time.Time `json:"grace_ends_at"`
		APIKey      struct {
			ID string `json:"id"`
		} `json:"api_key"`
	}
	err = json.NewDecoder(resp.Body).Decode(&result)
	resp.Body.Close()
	if err != nil || resp.StatusCode != http.StatusOK || result.Secret == "" || result.GraceEndsAt.IsZero() {
		t.Fatalf("reviewed rotation failed: %d", resp.StatusCode)
	}
	check := func(secret string, want int) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/me/keys", nil)
		req.Header.Set("Authorization", "Bearer "+secret)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal("authentication request failed")
		}
		response.Body.Close()
		if response.StatusCode != want {
			t.Fatalf("credential lifecycle status: %d, want %d", response.StatusCode, want)
		}
	}
	check("synthetic-grace-secret", http.StatusOK)
	check(result.Secret, http.StatusOK)
	// Replaying a lost response with the original review may not mint another secret.
	repeat := postJSON(t, ts.URL+"/me/keys/"+key.ID+"/rotate", "usersecret", map[string]any{"reason": "정기 교체", "expected_revision": revision, "grace_seconds": 1})
	repeat.Body.Close()
	if repeat.StatusCode != http.StatusConflict {
		t.Fatal("review replay did not conflict")
	}
	// Even an administrative upsert restoring the previous expiry cannot extend
	// the persisted grace deadline enforced on the normal authentication path.
	if err := db.UpsertAPIKey(t.Context(), key); err != nil {
		t.Fatal("metadata edit fixture failed")
	}
	effective, known, lookupErr := db.FindActiveAPIKeyByHash(t.Context(), key.KeyHash)
	if lookupErr != nil || !known || !effective.ExpiresAt.Equal(result.GraceEndsAt) {
		t.Fatal("authentication deadline differs from reviewed rotation result")
	}
	// The persisted deadline is wall time; Sleep waits on a monotonic clock.
	// A wall-clock correction while sleeping must not make the test claim that
	// grace has expired early. Confirm the boundary, with a monotonic upper bound.
	waitStarted := time.Now()
	for remaining := time.Until(result.GraceEndsAt.Add(20 * time.Millisecond)); remaining > 0; remaining = time.Until(result.GraceEndsAt.Add(20 * time.Millisecond)) {
		if time.Since(waitStarted) > 10*time.Second {
			t.Fatal("wall clock did not reach the grace deadline within the test budget")
		}
		time.Sleep(min(remaining, 100*time.Millisecond))
	}
	check("synthetic-grace-secret", http.StatusUnauthorized)
	check(result.Secret, http.StatusOK)
	next, found, err := db.GetAPIKey(t.Context(), result.APIKey.ID)
	if err != nil || !found || !next.ExpiresAt.Equal(key.ExpiresAt) {
		t.Fatal("replacement lost original expiry")
	}
}

func TestSelfServiceRotationRejectsStaleBrowserReview(t *testing.T) {
	ts, db := meKeysServer(t, true)
	key := store.APIKeyRecord{ID: "review-target", Name: "수정 전", KeyHash: "synthetic-review-hash", UserID: "u1", Team: "t1", Role: "developer", Status: "active", Scopes: []string{"models:read"}}
	if err := db.UpsertAPIKey(t.Context(), key); err != nil {
		t.Fatal("seed failed")
	}
	key, _, _ = db.GetAPIKey(t.Context(), key.ID)
	revision, err := db.APIKeyRevision(t.Context(), key)
	if err != nil {
		t.Fatal("review protection unavailable")
	}
	key.Name = "수정 후"
	if err := db.UpsertAPIKey(t.Context(), key); err != nil {
		t.Fatal("concurrent edit failed")
	}
	resp := postJSON(t, ts.URL+"/me/keys/"+key.ID+"/rotate", "usersecret", map[string]any{"reason": "정기 교체", "expected_revision": revision, "grace_seconds": 60})
	resp.Body.Close()
	keys, err := db.ListAPIKeys(t.Context())
	if resp.StatusCode != http.StatusConflict || err != nil || len(keys) != 2 {
		t.Fatal("stale browser review changed keys")
	}
}
