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
	var created struct {
		Version store.ModelPricingVersion `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if _, err := time.Parse(time.RFC3339Nano, created.Version.CreatedAt); err != nil {
		t.Fatalf("created pricing timestamp = %q: %v", created.Version.CreatedAt, err)
	}
	getResponse, err := http.Get(srv.URL + "/admin/pricing?model=test-model")
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Versions []store.ModelPricingVersion `json:"versions"`
	}
	if err := json.NewDecoder(getResponse.Body).Decode(&listed); err != nil {
		getResponse.Body.Close()
		t.Fatal(err)
	}
	getResponse.Body.Close()
	if len(listed.Versions) != 1 || listed.Versions[0].CreatedAt != created.Version.CreatedAt {
		t.Fatalf("listed versions = %+v, want created timestamp %q", listed.Versions, created.Version.CreatedAt)
	}

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

	// Startup auto-seed should have pre-applied the built-in catalog (the pricing table
	// was empty at NewServer time), so current models are present without a manual seed.
	server.invalidatePricingCache()
	eff = server.pricingMap(context.Background())
	if _, ok := eff["claude-opus-4-8"]; !ok {
		t.Error("expected claude-opus-4-8 in effective pricing from startup auto-seed")
	}
	if eff["kimi-k2.6"].OutputKRWPer1M <= 0 {
		t.Error("expected kimi-k2.6 to have a positive KRW output price after auto-seed")
	}

	// A plain seed is now idempotent (entries already present → added 0); overwrite=1
	// re-inserts the catalog as fresh versions.
	plainResp, err := http.Post(srv.URL+"/admin/pricing/seed", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	var plain struct {
		Added int `json:"added"`
	}
	json.NewDecoder(plainResp.Body).Decode(&plain)
	plainResp.Body.Close()
	if plain.Added != 0 {
		t.Errorf("plain seed after auto-seed should add 0, got %d", plain.Added)
	}

	owResp, err := http.Post(srv.URL+"/admin/pricing/seed?overwrite=1", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	var ow struct {
		Added int `json:"added"`
	}
	json.NewDecoder(owResp.Body).Decode(&ow)
	owResp.Body.Close()
	if ow.Added == 0 {
		t.Error("expected overwrite seed to re-add catalog entries")
	}
}

// A negative unit price makes EstimateCostKRW return a negative cost, and every
// enforcement point is a `cost > limit` comparison, so the per-key budget and the cost
// guard would pass unconditionally for that model while quota totals shrink. The POST
// handler must reject it instead of recording the version.
func TestPricingRejectsNegativePrices(t *testing.T) {
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

	bodies := map[string]map[string]any{
		"input":  {"model": "neg-model", "input_krw_per_1m": -1.0, "output_krw_per_1m": 2.0},
		"output": {"model": "neg-model", "input_krw_per_1m": 1.0, "output_krw_per_1m": -2.0},
		"cached": {"model": "neg-model", "input_krw_per_1m": 1.0, "output_krw_per_1m": 2.0, "cached_input_krw_per_1m": -0.5},
	}
	for name, body := range bodies {
		t.Run(name, func(t *testing.T) {
			resp := postJSON(t, srv.URL+"/admin/pricing", "", body)
			payload, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", resp.StatusCode, payload)
			}
		})
	}

	versions, err := db.ListPricingVersions(context.Background(), "neg-model", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != 0 {
		t.Fatalf("rejected prices were still recorded: %+v", versions)
	}

	// Zero stays valid — it is how operators mark a model as not billed.
	free := postJSON(t, srv.URL+"/admin/pricing", "", map[string]any{
		"model": "free-model", "input_krw_per_1m": 0.0, "output_krw_per_1m": 0.0,
	})
	free.Body.Close()
	if free.StatusCode != http.StatusCreated {
		t.Fatalf("zero price status = %d, want 201", free.StatusCode)
	}
}
