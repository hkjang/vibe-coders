package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/store"
)

func TestPricingVersionsAndEffectiveMerge(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	// testConfig prices test-model at input 1 / output 2 (from env). Add a newer DB
	// version → effective pricing must reflect the DB value.
	in, out := 999.0, 1999.0
	resp := postJSON(t, srv.URL+"/admin/pricing", "", map[string]any{
		"model": "test-model", "input_krw_per_1m": in, "output_krw_per_1m": out, "source": "manual",
	})
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("add version failed: %d %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	server.invalidatePricingCache()
	eff := server.pricingMap(context.Background())
	if eff["test-model"].InputKRWPer1M != in || eff["test-model"].OutputKRWPer1M != out {
		t.Errorf("effective price = %+v, want DB version %g/%g", eff["test-model"], in, out)
	}

	// A second newer version wins over the first.
	resp2 := postJSON(t, srv.URL+"/admin/pricing", "", map[string]any{
		"model": "test-model", "input_krw_per_1m": 5.0, "output_krw_per_1m": 6.0,
	})
	resp2.Body.Close()
	server.invalidatePricingCache()
	if eff := server.pricingMap(context.Background()); eff["test-model"].InputKRWPer1M != 5.0 {
		t.Errorf("newest version should win, got %+v", eff["test-model"])
	}

	// Seed the built-in catalog → adds known models (e.g. claude-opus-4).
	seedResp, err := http.Post(srv.URL+"/admin/pricing/seed", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	var seed struct {
		Added int `json:"added"`
	}
	json.NewDecoder(seedResp.Body).Decode(&seed)
	seedResp.Body.Close()
	if seed.Added == 0 {
		t.Error("expected seed to add catalog entries")
	}
	server.invalidatePricingCache()
	eff = server.pricingMap(context.Background())
	if _, ok := eff["claude-opus-4"]; !ok {
		t.Error("expected claude-opus-4 in effective pricing after seed")
	}
	if eff["kimi-k2.6"].OutputKRWPer1M <= 0 {
		t.Error("expected kimi-k2.6 to have a positive KRW output price after seed")
	}
}
