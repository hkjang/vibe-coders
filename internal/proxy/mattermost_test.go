package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestMattermostNotify(t *testing.T) {
	received := make(chan string, 8)
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var p struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal(b, &p)
		received <- p.Text
		w.WriteHeader(http.StatusOK)
	}))
	defer hook.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// Disabled by default → no delivery.
	server.notifyMattermost(ctx, "cost", "should not send")
	select {
	case <-received:
		t.Fatal("notification sent while disabled")
	case <-time.After(150 * time.Millisecond):
	}

	// Enable with only the "secret" category.
	for k, v := range map[string]string{
		"mattermost_enabled":     "true",
		"mattermost_webhook_url": hook.URL,
		"mattermost_events":      "secret",
	} {
		if err := db.SetFlag(ctx, store.RuntimeFlag{Key: k, Value: v, UpdatedAt: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
	}
	server.invalidateMattermostCache()

	// "cost" is muted → nothing.
	server.notifyMattermost(ctx, "cost", "muted category")
	select {
	case <-received:
		t.Fatal("muted category should not deliver")
	case <-time.After(150 * time.Millisecond):
	}

	// "secret" is enabled → delivered.
	server.notifyMattermost(ctx, "secret", "secret detected!")
	select {
	case text := <-received:
		if text == "" || !contains(text, "secret detected!") {
			t.Errorf("unexpected message: %q", text)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected a delivered secret notification")
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
