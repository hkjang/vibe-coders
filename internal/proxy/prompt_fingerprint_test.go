package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestPromptFingerprintGroupsAndSeparates(t *testing.T) {
	mk := func(text string) []store.PromptLog { return []store.PromptLog{{Role: "user", RedactedText: text}} }

	// Same salient vocabulary + intent → same fingerprint, regardless of filler/casing.
	a := promptFingerprint(mk("이 OrderController 를 리팩토링해줘"))
	b := promptFingerprint(mk("OrderController 리팩토링 좀 해줘 please"))
	if a == "" || a != b {
		t.Fatalf("expected same fingerprint for similar prompts, got %q vs %q", a, b)
	}
	// Pasted code is stripped, so the same instruction with different code still matches.
	c := promptFingerprint(mk("OrderController 리팩토링해줘\n```go\nfunc A(){}\n```"))
	if c != a {
		t.Fatalf("code block should be ignored: %q vs %q", c, a)
	}
	// Different domain vocabulary → different fingerprint.
	d := promptFingerprint(mk("PaymentService 의 동시성 버그를 고쳐줘"))
	if d == a {
		t.Fatalf("different task should not collide: %q", d)
	}
	// Empty prompt → empty fingerprint (not grouped).
	if promptFingerprint(mk("   ")) != "" {
		t.Fatalf("blank prompt should yield empty fingerprint")
	}
	// All fingerprints carry the fp_ prefix.
	if a[:3] != "fp_" {
		t.Fatalf("fingerprint should have fp_ prefix, got %q", a)
	}
}

func seedFingerprint(t *testing.T, db *store.SQLStore, fp, taskType, model, promptText string, n, successes int, cost float64) {
	t.Helper()
	ctx := context.Background()
	base := time.Now().UTC().Add(-time.Hour)
	for i := 0; i < n; i++ {
		status := 200
		if i >= successes {
			status = 500
		}
		id := fp + "-" + model + "-" + strconv.Itoa(i)
		rec := store.LogRecord{
			Request: store.RequestLog{
				ID: id, TraceID: id, Endpoint: "/v1/chat/completions",
				Model: model, TaskType: taskType, PromptFingerprint: fp,
				StatusCode: status, LatencyMS: 120, CreatedAt: base,
			},
			Prompts: []store.PromptLog{{ID: id + "p", RequestID: id, Role: "user", RedactedText: promptText, CreatedAt: base}},
			Usage:   &store.TokenUsage{ID: id + "u", RequestID: id, TotalTokens: 200, EstimatedCost: cost, Currency: "KRW", Source: "usage", CreatedAt: base},
		}
		if err := db.InsertLogRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPromptFingerprintsAggregation(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()

	// One cluster, two models: cheap (most used, lower success) and premium (pricier, perfect).
	seedFingerprint(t, db, "fp_abc123def0", "generate", "cheap", "REST 컨트롤러 만들어줘", 30, 24, 10)
	seedFingerprint(t, db, "fp_abc123def0", "generate", "premium", "REST 컨트롤러 만들어줘", 10, 10, 80)
	// A second, smaller cluster.
	seedFingerprint(t, db, "fp_zzz999aaa1", "debug", "cheap", "동시성 버그 고쳐줘", 5, 3, 10)

	stats, err := db.PromptFingerprints(ctx, time.Now().Add(-24*time.Hour), 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 2 {
		t.Fatalf("expected 2 clusters, got %d", len(stats))
	}
	// sorted by requests desc → the 40-request cluster first
	top := stats[0]
	if top.Fingerprint != "fp_abc123def0" || top.Requests != 40 {
		t.Fatalf("unexpected top cluster: %+v", top)
	}
	if top.DistinctModels != 2 {
		t.Errorf("distinct models = %d, want 2", top.DistinctModels)
	}
	if top.TopModel != "cheap" {
		t.Errorf("top model = %q, want cheap (most used)", top.TopModel)
	}
	if top.SamplePrompt == "" {
		t.Errorf("expected a sample prompt label")
	}
	// success rate = (24+10)/40 = 0.85
	if top.SuccessRate < 0.84 || top.SuccessRate > 0.86 {
		t.Errorf("success rate = %.3f, want ~0.85", top.SuccessRate)
	}
}

func TestPromptFingerprintsEndpoint(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://example.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	seedFingerprint(t, db, "fp_endpoint01", "generate", "gpt-4.1-mini", "API 엔드포인트 만들어줘", 8, 8, 12)

	resp, err := http.Get(proxy.URL + "/admin/prompts/fingerprints?window=24h")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var out struct {
		Fingerprints []store.PromptFingerprintStat `json:"fingerprints"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if len(out.Fingerprints) != 1 || out.Fingerprints[0].Fingerprint != "fp_endpoint01" {
		t.Fatalf("unexpected fingerprints: %+v", out.Fingerprints)
	}
}
