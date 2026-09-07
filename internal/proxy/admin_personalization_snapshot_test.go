package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/store"
)

// A profile snapshot is an audited row that accumulates and feeds the drift
// comparison. Reading the profile used to create one whenever the URL carried
// snapshot=1, so a refresh or a prefetch could take snapshots on its own.
func TestPersonalProfileSnapshotIsTakenOnlyOnPost(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	snapshotCount := func() int {
		t.Helper()
		rows, err := db.ListPersonalProfileSnapshots(context.Background(), "usr_1", 20)
		if err != nil {
			t.Fatal(err)
		}
		return len(rows)
	}

	// Reading, even with the query parameter that used to trigger it.
	for _, path := range []string{
		"/admin/personalization/profiles/usr_1",
		"/admin/personalization/profiles/usr_1?snapshot=1",
	} {
		resp, err := http.Get(proxy.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status = %d", path, resp.StatusCode)
		}
		if _, ok := body["profile"]; !ok {
			t.Fatalf("GET %s returned no profile", path)
		}
	}
	if count := snapshotCount(); count != 0 {
		t.Fatalf("reading the profile took %d snapshots", count)
	}

	created := postJSON(t, proxy.URL+"/admin/personalization/profiles/usr_1", "", map[string]any{})
	defer created.Body.Close()
	if created.StatusCode != http.StatusOK {
		t.Fatalf("POST status = %d", created.StatusCode)
	}
	if count := snapshotCount(); count != 1 {
		t.Fatalf("snapshots after one POST = %d, want 1", count)
	}
}
