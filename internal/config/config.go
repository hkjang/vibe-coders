package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddr string
	Upstream   UpstreamConfig
	Database   DatabaseConfig
	Logging    LoggingConfig
	Retention  RetentionConfig
	Cache      CacheConfig
	Auth       AuthConfig
	Secret     SecretConfig
	Session    SessionConfig
	VCS        VCSConfig
	Text2SQL   Text2SQLConfig
	ClickHouse ClickHouseConfig
	Carbon     CarbonConfig
	Insurance  InsuranceConfig
	Pricing    map[string]ModelPrice
}

// InsuranceConfig parameterizes the AI Request Insurance view: an SLA-claims ledger
// that treats degraded outcomes (4xx/5xx/failover/error) as "claims" against the
// "covered" requests of an insured scope and compares the claim rate to an SLA target.
// Read-only — nothing enforces on it.
type InsuranceConfig struct {
	// SLATarget is the reliability promise (0..1) used as the default claim-rate
	// allowance: a scope is "met" when its claim rate <= (1 - SLATarget). Default 0.99.
	SLATarget float64
	// FastBurnThreshold / SlowBurnThreshold are error-budget burn-rate multipliers
	// (claim_rate / allowance) that classify a scope as fast-burning (page) or
	// slow-burning (ticket). Defaults 14.4 and 3.0 follow the Google SRE workbook.
	FastBurnThreshold float64
	SlowBurnThreshold float64
}

// CarbonConfig parameterizes the Prompt Carbon Score: an estimate of the electricity
// (Wh) and operational carbon (gCO2e) attributable to LLM token throughput. The
// estimate is intentionally coarse and fully configurable — published per-token energy
// figures vary by an order of magnitude — so treat the output as a relative signal for
// comparing subjects, not an audited measurement.
type CarbonConfig struct {
	// WhPer1KTokens is the default electricity (watt-hours) drawn per 1,000 tokens
	// processed (prompt+completion). Default 0.4 Wh/1K is a mid-range public estimate.
	WhPer1KTokens float64
	// PerModelWhPer1K overrides WhPer1KTokens per model (name → Wh/1K), since larger
	// models draw far more. Parsed from CARBON_MODEL_WH_PER_1K
	// ("gpt-4.1=0.8,gpt-4.1-mini=0.2").
	PerModelWhPer1K map[string]float64
	// PUE (Power Usage Effectiveness) scales IT energy up to include datacenter overhead
	// (cooling, etc.). Default 1.2 reflects efficient cloud datacenters.
	PUE float64
	// GridIntensityG is the grid carbon intensity in gCO2e per kWh used to convert energy
	// to emissions. Default 475 is a commonly cited global-average figure.
	GridIntensityG float64
}

// VCSConfig gates the VCS correlation ingest endpoints. When WebhookSecret is empty
// the public /vcs/* endpoints are disabled (admins can still ingest via /admin/vcs).
// InferFromContent mines git activity (git commit/push) out of the LLM traffic the
// gateway already sees, so the VCS tab shows commits even without any webhook setup.
type VCSConfig struct {
	WebhookSecret    string
	InferFromContent bool
}

type UpstreamConfig struct {
	Provider string
	BaseURL  string
	APIKey   string
	Timeout  time.Duration
}

type DatabaseConfig struct {
	Driver string
	DSN    string
}

type LoggingConfig struct {
	RawPrompts       bool
	RawBodies        bool
	ResponseText     bool
	ResponseMaxBytes int
	QueueSize        int
	FallbackPath     string
}

type RetentionConfig struct {
	RequestDays        int
	PromptDays         int
	ResponseDays       int
	Text2SQLReplayDays int // retention for Text2SQL replay bundles (audit artifacts)
	Interval           time.Duration
}

type CacheConfig struct {
	EmbeddingEnabled  bool
	EmbeddingTTL      time.Duration
	EmbeddingMaxBytes int
	ChatEnabled       bool
	ChatTTL           time.Duration
	// Semantic (embedding-based near-duplicate) chat cache. Opt-in: requires both
	// ChatSemanticEnabled and an embedding model. On an exact-cache miss, the prompt is
	// embedded and matched against recent entries by cosine similarity.
	ChatSemanticEnabled       bool
	ChatSemanticModel         string  // embedding model used to vectorize prompts
	ChatSemanticThreshold     float64 // cosine similarity required for a hit (0..1)
	ChatSemanticMaxCandidates int     // max recent entries scanned per model
}

type AuthConfig struct {
	ProxyAPIKeys       []ProxyAPIKey
	AdminToken         string
	AdminReadonlyToken string
	// AttributeExternalKeys: when a request carries a bearer key that is NOT a
	// registered proxy key (e.g. the client sends its own upstream key), attribute
	// it to a stable per-key identity (ext_<hash>) instead of lumping all such
	// traffic into one shared "passthrough" bucket. Lets per-user keys show up as
	// distinct users even when they were never registered in the gateway.
	AttributeExternalKeys bool
	Enabled               bool
	JWTSecret             string
	AccessTokenTTL        time.Duration
	RefreshTokenTTL       time.Duration
	APIKeyPrefix          string
	ServiceKeyPrefix      string
	BootstrapEmail        string
	BootstrapPassword     string
	// SelfServiceKeys lets an authenticated user manage their OWN API keys via /me/keys
	// (list/create/rotate/revoke), capped to their own role's scopes. Default off.
	SelfServiceKeys bool
}

type SecretConfig struct {
	GatewaySecret string
}

// Text2SQLConfig controls the Text2SQL virtual-model pipeline. When Enabled, a
// request whose model is vibe/text2sql-* is generated as read-only SQL by an
// internal upstream model instead of being proxied verbatim.
type Text2SQLConfig struct {
	Enabled           bool
	PreviewModel      string
	ExecuteModel      string
	AccurateModel     string
	LocalModel        string
	SummaryModel      string
	Dialect           string // e.g. "PostgreSQL"
	Schema            string // inline schema/catalog context injected into the prompt
	DefaultLimit      int
	MaxLimit          int
	MaxExplainCost    float64       // when > 0 (postgres), reject queries whose EXPLAIN total cost exceeds this
	MaskResults       bool          // mask secrets/PII in executed result cells
	ExecDriver        string        // database/sql driver for execute mode (e.g. "postgres", "sqlite")
	ExecDSN           string        // read-only DSN for execute mode; empty disables execution
	CacheEnabled      bool          // cache generated preview SQL by question+schema+mode
	CacheTTL          time.Duration // preview SQL cache TTL
	ClarifyEnabled    bool          // ask a clarification question instead of guessing on vague prompts
	RequireDateFilter bool          // when clarifying, require a time qualifier
	StatementTimeout  time.Duration // (postgres execute) per-statement timeout
	WorkMem           string        // (postgres execute) SET LOCAL work_mem, e.g. "64MB"
	ShadowModels      []string      // candidate upstream models to shadow-evaluate on preview (quality data)
	ShadowSampleRate  float64       // 0..1 fraction of eligible preview requests to shadow-evaluate
	ReplayBundles     bool          // persist full generation context (prompt/schema/glossary/permissions) per query for audit/replay
	DailyRiskLimit    int           // per-API-key daily risky-request cap for the cumulative_risk_enforce toggle (0 disables enforcement)
	DailyRiskWarn     int           // warn threshold below the cap; in [warn, limit) the response is served with a caution (0 → limit/2)
	// SQL Digital Twin: an optional masked/sample database used for safe validation
	// (e.g. golden result-equivalence) instead of the production execute DB. Empty
	// falls back to the execute DB.
	TwinDSN    string
	TwinDriver string
}

// ClickHouseConfig configures the long-term analytics sink. When URL is empty the
// sink is disabled; the PostgreSQL/SQLite rollup ledger remains the source of truth.
type ClickHouseConfig struct {
	URL               string // HTTP endpoint, e.g. http://clickhouse:8123
	Database          string
	Table             string
	User              string
	Password          string
	SinkInterval      time.Duration // > 0 enables the background auto-sink worker
	SinkDays          int           // how many recent days each auto-sink covers
	Text2SQLFactTable string        // when set, per-query Text2SQL facts are shipped here (detailed fact table); empty disables
}

// DefaultGatewaySecret is the insecure development fallback used when
// GATEWAY_SECRET is unset. Operational tooling flags it as a risk in production.
const DefaultGatewaySecret = "dev-local-insecure-secret-change-me"

// SessionConfig controls how requests are grouped into sessions. Most AI coding
// tools (Claude Code, Cursor, Roo, Qwen) send no session id at the API level, so
// the gateway infers one from client identity + a sliding inactivity window when
// no explicit id (header or body) is present.
type SessionConfig struct {
	InferenceEnabled bool          // infer a session when the client sends none
	IdleTimeout      time.Duration // gap of inactivity that starts a new inferred session
}

type ProxyAPIKey struct {
	ID      string
	Name    string
	KeyHash string
	Owner   string
	Team    string
}

type ModelPrice struct {
	InputKRWPer1M       float64 `json:"input_krw_per_1m"`
	OutputKRWPer1M      float64 `json:"output_krw_per_1m"`
	CachedInputKRWPer1M float64 `json:"cached_input_krw_per_1m"`
}

func Load() (Config, error) {
	cfg := Config{
		ListenAddr: getEnv("LISTEN_ADDR", ":8080"),
		Upstream: UpstreamConfig{
			Provider: getEnv("UPSTREAM_PROVIDER", "openai"),
			BaseURL:  strings.TrimRight(getEnv("UPSTREAM_BASE_URL", "https://api.openai.com"), "/"),
			APIKey:   firstNonEmpty(os.Getenv("UPSTREAM_API_KEY"), os.Getenv("OPENAI_API_KEY")),
			Timeout:  durationEnv("UPSTREAM_TIMEOUT", 10*time.Minute),
		},
		Database: databaseConfig(),
		Logging: LoggingConfig{
			RawPrompts:       boolEnv("LOG_RAW_PROMPTS", false),
			RawBodies:        boolEnv("LOG_RAW_BODIES", false),
			ResponseText:     boolEnv("LOG_RESPONSE_TEXT", false),
			ResponseMaxBytes: intEnv("LOG_RESPONSE_MAX_BYTES", 1<<20),
			QueueSize:        intEnv("LOG_QUEUE_SIZE", 4096),
			FallbackPath:     getEnv("LOG_FALLBACK_PATH", filepath.Join("data", "fallback.ndjson")),
		},
		Retention: RetentionConfig{
			RequestDays:        intEnv("RETENTION_REQUEST_DAYS", 90),
			PromptDays:         intEnv("RETENTION_PROMPT_DAYS", 30),
			ResponseDays:       intEnv("RETENTION_RESPONSE_DAYS", 30),
			Text2SQLReplayDays: intEnv("RETENTION_TEXT2SQL_REPLAY_DAYS", 30),
			Interval:           durationEnv("RETENTION_INTERVAL", time.Hour),
		},
		Cache: CacheConfig{
			EmbeddingEnabled:          boolEnv("CACHE_EMBEDDING_ENABLED", true),
			EmbeddingTTL:              durationEnv("CACHE_EMBEDDING_TTL", 24*time.Hour),
			EmbeddingMaxBytes:         intEnv("CACHE_EMBEDDING_MAX_BYTES", 1<<20), // 1 MB per entry
			ChatEnabled:               boolEnv("CACHE_CHAT_ENABLED", false),       // opt-in: chat responses are non-deterministic
			ChatTTL:                   durationEnv("CACHE_CHAT_TTL", time.Hour),
			ChatSemanticEnabled:       boolEnv("CACHE_CHAT_SEMANTIC_ENABLED", false),
			ChatSemanticModel:         os.Getenv("CACHE_CHAT_SEMANTIC_MODEL"),
			ChatSemanticThreshold:     floatEnv("CACHE_CHAT_SEMANTIC_THRESHOLD", 0.95),
			ChatSemanticMaxCandidates: intEnv("CACHE_CHAT_SEMANTIC_MAX_CANDIDATES", 200),
		},
		Auth: AuthConfig{
			ProxyAPIKeys:          parseProxyKeys(os.Getenv("PROXY_API_KEYS")),
			AdminToken:            os.Getenv("ADMIN_TOKEN"),
			AdminReadonlyToken:    os.Getenv("ADMIN_READONLY_TOKEN"),
			AttributeExternalKeys: boolEnv("ATTRIBUTE_EXTERNAL_KEYS", true),
			Enabled:               boolEnv("AUTH_ENABLED", false),
			JWTSecret:             os.Getenv("AUTH_JWT_SECRET"),
			AccessTokenTTL:        durationEnv("AUTH_ACCESS_TOKEN_TTL", 15*time.Minute),
			RefreshTokenTTL:       durationEnv("AUTH_REFRESH_TOKEN_TTL", 168*time.Hour),
			APIKeyPrefix:          getEnv("AUTH_API_KEY_PREFIX", "vc_sk_"),
			ServiceKeyPrefix:      getEnv("AUTH_SERVICE_KEY_PREFIX", "vc_sa_"),
			BootstrapEmail:        strings.TrimSpace(os.Getenv("AUTH_ADMIN_BOOTSTRAP_EMAIL")),
			BootstrapPassword:     os.Getenv("AUTH_ADMIN_BOOTSTRAP_PASSWORD"),
			SelfServiceKeys:       boolEnv("SELF_SERVICE_KEYS_ENABLED", false),
		},
		Secret: SecretConfig{
			GatewaySecret: getEnv("GATEWAY_SECRET", DefaultGatewaySecret),
		},
		Session: SessionConfig{
			InferenceEnabled: boolEnv("SESSION_INFERENCE_ENABLED", true),
			IdleTimeout:      durationEnv("SESSION_IDLE_TIMEOUT", 30*time.Minute),
		},
		VCS: VCSConfig{
			WebhookSecret:    os.Getenv("VCS_WEBHOOK_SECRET"),
			InferFromContent: boolEnv("VCS_INFER_FROM_CONTENT", true),
		},
		Text2SQL: Text2SQLConfig{
			Enabled:           boolEnv("TEXT2SQL_ENABLED", false),
			PreviewModel:      getEnv("TEXT2SQL_PREVIEW_MODEL", "gpt-4.1-mini"),
			ExecuteModel:      getEnv("TEXT2SQL_EXECUTE_MODEL", "gpt-4.1-mini"),
			AccurateModel:     getEnv("TEXT2SQL_ACCURATE_MODEL", "claude-sonnet-4"),
			LocalModel:        getEnv("TEXT2SQL_LOCAL_MODEL", "qwen-coder"),
			SummaryModel:      getEnv("TEXT2SQL_SUMMARY_MODEL", "gpt-4.1-mini"),
			Dialect:           getEnv("TEXT2SQL_DIALECT", "PostgreSQL"),
			Schema:            os.Getenv("TEXT2SQL_SCHEMA"),
			DefaultLimit:      intEnv("TEXT2SQL_DEFAULT_LIMIT", 100),
			MaxLimit:          intEnv("TEXT2SQL_MAX_LIMIT", 1000),
			MaxExplainCost:    floatEnv("TEXT2SQL_MAX_EXPLAIN_COST", 0),
			MaskResults:       boolEnv("TEXT2SQL_MASK_RESULTS", true),
			ExecDriver:        getEnv("TEXT2SQL_EXEC_DRIVER", "postgres"),
			ExecDSN:           os.Getenv("TEXT2SQL_EXEC_DSN"),
			CacheEnabled:      boolEnv("TEXT2SQL_CACHE_ENABLED", true),
			CacheTTL:          durationEnv("TEXT2SQL_CACHE_TTL", time.Hour),
			ClarifyEnabled:    boolEnv("TEXT2SQL_CLARIFY_ENABLED", false),
			RequireDateFilter: boolEnv("TEXT2SQL_REQUIRE_DATE_FILTER", false),
			StatementTimeout:  durationEnv("TEXT2SQL_STATEMENT_TIMEOUT", 15*time.Second),
			WorkMem:           os.Getenv("TEXT2SQL_WORK_MEM"),
			ShadowModels:      csvEnv("TEXT2SQL_SHADOW_MODELS"),
			ShadowSampleRate:  floatEnv("TEXT2SQL_SHADOW_SAMPLE_RATE", 0),
			ReplayBundles:     boolEnv("TEXT2SQL_REPLAY_BUNDLES", false),
			DailyRiskLimit:    intEnv("TEXT2SQL_DAILY_RISK_LIMIT", 20),
			DailyRiskWarn:     intEnv("TEXT2SQL_DAILY_RISK_WARN", 0),
			TwinDSN:           os.Getenv("TEXT2SQL_TWIN_DSN"),
			TwinDriver:        getEnv("TEXT2SQL_TWIN_DRIVER", "postgres"),
		},
		Carbon: CarbonConfig{
			WhPer1KTokens:   floatEnv("CARBON_WH_PER_1K_TOKENS", 0.4),
			PerModelWhPer1K: floatMapEnv("CARBON_MODEL_WH_PER_1K"),
			PUE:             floatEnv("CARBON_PUE", 1.2),
			GridIntensityG:  floatEnv("CARBON_GRID_INTENSITY_G", 475),
		},
		Insurance: InsuranceConfig{
			SLATarget:         floatEnv("INSURANCE_SLA_TARGET", 0.99),
			FastBurnThreshold: floatEnv("INSURANCE_FAST_BURN", 14.4),
			SlowBurnThreshold: floatEnv("INSURANCE_SLOW_BURN", 3.0),
		},
		ClickHouse: ClickHouseConfig{
			URL:               strings.TrimRight(os.Getenv("CLICKHOUSE_URL"), "/"),
			Database:          getEnv("CLICKHOUSE_DB", "default"),
			Table:             getEnv("CLICKHOUSE_TABLE", "analytics_daily"),
			User:              os.Getenv("CLICKHOUSE_USER"),
			Password:          os.Getenv("CLICKHOUSE_PASSWORD"),
			SinkInterval:      durationEnv("CLICKHOUSE_SINK_INTERVAL", 0),
			SinkDays:          intEnv("CLICKHOUSE_SINK_DAYS", 3),
			Text2SQLFactTable: os.Getenv("CLICKHOUSE_TEXT2SQL_FACT_TABLE"),
		},
		Pricing: map[string]ModelPrice{},
	}

	if cfg.Upstream.BaseURL == "" {
		return Config{}, fmt.Errorf("UPSTREAM_BASE_URL cannot be empty")
	}
	if cfg.Logging.ResponseMaxBytes < 0 {
		return Config{}, fmt.Errorf("LOG_RESPONSE_MAX_BYTES must be non-negative")
	}
	if cfg.Logging.QueueSize <= 0 {
		return Config{}, fmt.Errorf("LOG_QUEUE_SIZE must be positive")
	}
	if err := json.Unmarshal([]byte(getEnv("MODEL_PRICING_KRW_PER_1M", "{}")), &cfg.Pricing); err != nil {
		return Config{}, fmt.Errorf("parse MODEL_PRICING_KRW_PER_1M: %w", err)
	}
	if cfg.Auth.Enabled && cfg.Auth.JWTSecret == "" {
		return Config{}, fmt.Errorf("AUTH_JWT_SECRET is required when AUTH_ENABLED=true")
	}

	return cfg, nil
}

func databaseConfig() DatabaseConfig {
	// 1. Precedence 1: Auto-detect PostgreSQL if any key DSN environment variable starts with postgres:// or postgresql://.
	// This ensures that even if DB_DRIVER=sqlite is hardcoded in Docker, it will be overridden if PostgreSQL DSN is supplied.
	for _, envName := range []string{"POSTGRES_DSN", "DATABASE_URL", "DB_DSN"} {
		if dsn := os.Getenv(envName); dsn != "" {
			if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
				return DatabaseConfig{Driver: "postgres", DSN: dsn}
			}
		}
	}

	// 2. Precedence 2: If DB_DRIVER is explicitly configured as postgres or postgresql.
	driver := strings.ToLower(os.Getenv("DB_DRIVER"))
	if driver == "postgres" || driver == "postgresql" {
		dsn := firstNonEmpty(os.Getenv("DB_DSN"), os.Getenv("POSTGRES_DSN"), os.Getenv("DATABASE_URL"))
		return DatabaseConfig{Driver: "postgres", DSN: dsn}
	}

	// 3. Fallback: Default to SQLite.
	// Uses DB_DSN if set, otherwise falls back to the default "data/gateway.db".
	return DatabaseConfig{Driver: "sqlite", DSN: getEnv("DB_DSN", filepath.Join("data", "gateway.db"))}
}

func parseProxyKeys(raw string) []ProxyAPIKey {
	if strings.TrimSpace(raw) == "" {
		return nil
	}

	parts := strings.Split(raw, ",")
	keys := make([]ProxyAPIKey, 0, len(parts))
	for i, part := range parts {
		fields := strings.Split(strings.TrimSpace(part), ":")
		if len(fields) == 0 || strings.TrimSpace(fields[0]) == "" {
			continue
		}

		key := fields[0]
		name := fmt.Sprintf("key-%d", i+1)
		owner := ""
		team := ""
		if len(fields) >= 2 {
			name = fields[0]
			key = fields[1]
		}
		if len(fields) >= 3 {
			owner = fields[2]
		}
		if len(fields) >= 4 {
			team = fields[3]
		}
		sum := sha256.Sum256([]byte(key))
		keyHash := hex.EncodeToString(sum[:])
		keys = append(keys, ProxyAPIKey{
			ID:      "key_" + keyHash[:16],
			Name:    name,
			KeyHash: keyHash,
			Owner:   owner,
			Team:    team,
		})
	}
	return keys
}

func getEnv(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func boolEnv(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func intEnv(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func floatEnv(key string, fallback float64) float64 {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

// floatMapEnv parses a comma-separated "key=float" env var into a map (e.g.
// "gpt-4.1=0.8,gpt-4.1-mini=0.2"). Malformed pairs are skipped; returns nil if empty.
func floatMapEnv(key string) map[string]float64 {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return nil
	}
	out := map[string]float64{}
	for _, pair := range strings.Split(raw, ",") {
		kv := strings.SplitN(pair, "=", 2)
		if len(kv) != 2 {
			continue
		}
		name := strings.TrimSpace(kv[0])
		v, err := strconv.ParseFloat(strings.TrimSpace(kv[1]), 64)
		if name == "" || err != nil {
			continue
		}
		out[name] = v
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// csvEnv parses a comma-separated env var into a trimmed, non-empty slice.
func csvEnv(key string) []string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err == nil {
		return parsed
	}
	seconds, err := strconv.Atoi(value)
	if err == nil {
		return time.Duration(seconds) * time.Second
	}
	return fallback
}
