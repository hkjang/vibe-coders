package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

const pricingSnapshotTTL = 30 * time.Second

// pricingSnapshot caches the effective price map (env config overlaid with the
// latest DB pricing versions) so cost calculations never hit the DB on the hot path.
type pricingSnapshot struct {
	prices    map[string]config.ModelPrice
	fetchedAt time.Time
}

// pricingMap returns the effective per-model price map: env-configured prices with
// DB-managed pricing versions overlaid on top (DB wins, since it is the maintained
// source). Cached on a short TTL.
func (s *Server) pricingMap(ctx context.Context) map[string]config.ModelPrice {
	if c := s.priceCache.Load(); c != nil && time.Since(c.fetchedAt) < pricingSnapshotTTL {
		return c.prices
	}
	merged := map[string]config.ModelPrice{}
	for k, v := range s.cfg.Pricing {
		merged[k] = v
	}
	if latest, err := s.db.LatestPricing(ctx); err == nil {
		for k, v := range latest {
			merged[k] = v
		}
	}
	s.priceCache.Store(&pricingSnapshot{prices: merged, fetchedAt: time.Now()})
	return merged
}

func (s *Server) invalidatePricingCache() { s.priceCache.Store(nil) }

// usdToKRW is the conversion rate used when seeding USD-quoted public prices.
const usdToKRW = 1380.0

// pricingCatalogEntry is a built-in seed price (per 1M tokens).
type pricingCatalogEntry struct {
	model     string
	inUSD     float64
	outUSD    float64
	cachedUSD float64
	source    string
}

// builtinPricingCatalog is the researched price seed (2026-06). Major US models use
// published per-1M USD rates; Chinese models (Qwen/Kimi) use approximate cloud rates
// as requested. Converted to KRW at seed time. Operators can override any entry by
// adding a newer version via POST /admin/pricing.
var builtinPricingCatalog = []pricingCatalogEntry{
	// OpenAI
	{"gpt-5.2", 1.75, 14.0, 0.4375, "web:2026-06"},
	{"gpt-5.1", 1.25, 10.0, 0.125, "approx:2026-06"},
	{"gpt-5", 1.25, 10.0, 0.125, "approx:2026-06"},
	{"gpt-4.1", 2.0, 8.0, 0.5, "approx:2026-06"},
	{"gpt-4.1-mini", 0.4, 1.6, 0.1, "approx:2026-06"},
	{"gpt-4.1-nano", 0.10, 0.40, 0.025, "web:2026-06"},
	{"gpt-4o", 2.5, 10.0, 1.25, "approx:2026-06"},
	{"gpt-4o-mini", 0.15, 0.60, 0.075, "approx:2026-06"},
	{"o1", 15.0, 60.0, 7.5, "web:2026-06"},
	{"o3", 2.0, 8.0, 0.5, "approx:2026-06"},
	{"o4-mini", 1.1, 4.4, 0.275, "approx:2026-06"},
	// Anthropic — current Claude 4.x family (cache read ≈ 0.1× input)
	{"claude-opus-4-8", 5.0, 25.0, 0.5, "approx:2026-06"},
	{"claude-opus-4-7", 5.0, 25.0, 0.5, "approx:2026-06"},
	{"claude-opus-4-6", 5.0, 25.0, 0.5, "approx:2026-06"},
	{"claude-sonnet-4-6", 3.0, 15.0, 0.3, "approx:2026-06"},
	{"claude-sonnet-4-5", 3.0, 15.0, 0.3, "approx:2026-06"},
	{"claude-haiku-4-5", 1.0, 5.0, 0.1, "approx:2026-06"},
	{"claude-fable-5", 3.0, 15.0, 0.3, "approx:2026-06"},
	// Anthropic — prior generation (kept for back-compat)
	{"claude-opus-4", 5.0, 25.0, 0.5, "web:2026-06"},
	{"claude-sonnet-4", 3.0, 15.0, 0.3, "web:2026-06"},
	{"claude-haiku-4", 1.0, 5.0, 0.1, "web:2026-06"},
	{"claude-3-5-sonnet", 3.0, 15.0, 0.3, "web:2026-06"},
	{"claude-3-5-haiku", 0.80, 4.0, 0.08, "web:2026-06"},
	// Google Gemini
	{"gemini-3-pro", 2.0, 12.0, 0.5, "web:2026-06"},
	{"gemini-2.5-pro", 1.25, 10.0, 0.3125, "web:2026-06"},
	{"gemini-2.5-flash", 0.30, 2.50, 0.075, "web:2026-06"},
	{"gemini-2.0-flash-lite", 0.075, 0.30, 0.01875, "web:2026-06"},
	// Chinese models — approximate cloud pricing (per request)
	{"kimi-k2.6", 0.95, 4.0, 0.16, "approx-cloud:2026-06"},
	{"kimi-k2.5", 0.60, 2.50, 0.12, "approx-cloud:2026-06"},
	{"moonshot-v1", 0.60, 2.50, 0.12, "approx-cloud:2026-06"},
	{"qwen-max", 1.6, 6.4, 0.4, "approx-cloud:2026-06"},
	{"qwen-plus", 0.40, 1.20, 0.1, "approx-cloud:2026-06"},
	{"qwen-turbo", 0.05, 0.20, 0.0125, "approx-cloud:2026-06"},
}

// handlePricing serves and edits managed model pricing with version history.
// GET  /admin/pricing[?model=]        → effective prices + version history
// POST /admin/pricing {model,...}     → add a new price version
func (s *Server) handlePricing(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		versions, err := s.db.ListPricingVersions(r.Context(), strings.TrimSpace(r.URL.Query().Get("model")), recentLimit(r))
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "pricing_list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"effective": s.pricingMap(r.Context()),
			"versions":  versions,
		})
	case http.MethodPost:
		var p struct {
			Model               string   `json:"model"`
			InputKRWPer1M       *float64 `json:"input_krw_per_1m"`
			OutputKRWPer1M      *float64 `json:"output_krw_per_1m"`
			CachedInputKRWPer1M float64  `json:"cached_input_krw_per_1m"`
			Source              string   `json:"source"`
			Note                string   `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		p.Model = strings.TrimSpace(p.Model)
		if p.Model == "" || p.InputKRWPer1M == nil || p.OutputKRWPer1M == nil {
			writeOpenAIError(w, http.StatusBadRequest, "model, input_krw_per_1m, output_krw_per_1m are required", "invalid_request_error", "missing_fields")
			return
		}
		v := store.ModelPricingVersion{
			ID: newID("price"), Model: p.Model, InputKRWPer1M: *p.InputKRWPer1M, OutputKRWPer1M: *p.OutputKRWPer1M,
			CachedInputKRWPer1M: p.CachedInputKRWPer1M, Source: firstNonEmpty(strings.TrimSpace(p.Source), "manual"), Note: strings.TrimSpace(p.Note),
		}
		if err := s.db.InsertPricingVersion(r.Context(), v); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "pricing_save_failed")
			return
		}
		s.invalidatePricingCache()
		s.auditAdmin(r, "pricing.version.add", "", auditJSON(v))
		writeJSON(w, http.StatusCreated, map[string]any{"version": v})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handlePricingSeed inserts the researched built-in catalog as new price versions.
// This is the "auto-update from research" action — in a closed network the built-in
// catalog is the source; online it can be re-run after refreshing the catalog.
// POST /admin/pricing/seed[?overwrite=1]
func (s *Server) handlePricingSeed(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	existing, _ := s.db.LatestPricing(r.Context())
	overwrite := strings.TrimSpace(r.URL.Query().Get("overwrite")) == "1"
	added := 0
	for _, e := range builtinPricingCatalog {
		if _, ok := existing[e.model]; ok && !overwrite {
			continue // keep operator-managed prices unless overwrite requested
		}
		v := store.ModelPricingVersion{
			ID: newID("price"), Model: e.model,
			InputKRWPer1M: round2(e.inUSD * usdToKRW), OutputKRWPer1M: round2(e.outUSD * usdToKRW),
			CachedInputKRWPer1M: round2(e.cachedUSD * usdToKRW), Source: e.source,
			Note: "seeded from research catalog (USD×" + formatKRW(usdToKRW) + ")",
		}
		if err := s.db.InsertPricingVersion(r.Context(), v); err == nil {
			added++
		}
	}
	s.invalidatePricingCache()
	s.auditAdmin(r, "pricing.seed", "", auditJSON(map[string]any{"added": added, "overwrite": overwrite}))
	writeJSON(w, http.StatusOK, map[string]any{"added": added, "catalog_size": len(builtinPricingCatalog)})
}

// seedPricingIfEmpty inserts the built-in catalog at startup when no DB pricing versions
// exist yet, so current model prices are pre-applied out of the box (operators can still
// override per model via POST /admin/pricing, or re-run /admin/pricing/seed?overwrite=1).
func (s *Server) seedPricingIfEmpty(ctx context.Context) {
	existing, err := s.db.LatestPricing(ctx)
	if err != nil {
		return
	}
	if len(existing) > 0 {
		return // already has managed prices — never clobber on boot
	}
	seeded := 0
	for _, e := range builtinPricingCatalog {
		v := store.ModelPricingVersion{
			ID: newID("price"), Model: e.model,
			InputKRWPer1M: round2(e.inUSD * usdToKRW), OutputKRWPer1M: round2(e.outUSD * usdToKRW),
			CachedInputKRWPer1M: round2(e.cachedUSD * usdToKRW), Source: e.source,
			Note: "auto-seeded at startup from research catalog (USD×" + formatKRW(usdToKRW) + ")",
		}
		if err := s.db.InsertPricingVersion(ctx, v); err == nil {
			seeded++
		}
	}
	if seeded > 0 {
		s.invalidatePricingCache()
	}
}

func round2(v float64) float64 {
	return float64(int64(v*100+0.5)) / 100
}
