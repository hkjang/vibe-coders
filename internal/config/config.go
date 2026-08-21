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
	ListenAddr  string
	Upstream    UpstreamConfig
	Database    DatabaseConfig
	Logging     LoggingConfig
	Retention   RetentionConfig
	Cache       CacheConfig
	Auth        AuthConfig
	Secret      SecretConfig
	Session     SessionConfig
	VCS         VCSConfig
	Text2SQL    Text2SQLConfig
	ClickHouse  ClickHouseConfig
	Carbon      CarbonConfig
	Insurance   InsuranceConfig
	Pricing     map[string]ModelPrice
	PricingConf PricingConfig
	Skills      SkillsConfig
	Limits      LimitsConfig
	MCP         MCPConfig
	RedTeam     RedTeamConfig
	Keycloak    KeycloakConfig
	// RuntimeReloadInterval is how often each pod polls the DB for admin-settings changes made on
	// other pods (multi-replica convergence). 0 disables polling (single-pod / local dev).
	RuntimeReloadInterval time.Duration
}

// KeycloakConfig configures OIDC SSO via Keycloak (Authorization Code + PKCE). When
// Enabled, the admin UI offers an "SSO 로그인" button and accepts Keycloak-issued logins;
// AllowLocalLogin keeps the built-in email/password login available as a fallback.
type KeycloakConfig struct {
	Enabled         bool
	IssuerURL       string // e.g. https://keycloak.example.com/realms/vibe
	ClientID        string
	ClientSecret    string
	RedirectURI     string
	Scopes          []string // default: openid profile email
	DefaultRole     string   // internal role when no mapping matches; "" = block login
	RoleClaim       string   // dotted path to roles, e.g. realm_access.roles
	GroupClaim      string   // claim holding group paths, e.g. groups
	AllowLocalLogin bool
	RoleMap         map[string]string // Keycloak role → internal role; nil = use built-in defaults
}

// MCPConfig parameterizes the MCP discovery / grounding virtual models (vibe/grounded,
// vibe/research, vibe/all-mcp, ...). The agentic loop hands the selected upstreams' MCP
// tools to a backing LLM that decides which to call; this config picks that backing LLM.
type MCPConfig struct {
	// AgenticModel is the upstream model that drives the MCP discovery tool-calling loop.
	// When empty, the gateway falls back to the auto-router's policy-aware model selection
	// (same logic as vibe/auto). Set it to pin a specific model (e.g. "claude-sonnet-4",
	// "gpt-4.1") whose provider is configured.
	AgenticModel string
	// MaxAgentSteps caps how many LLM turns (tool-calling rounds) the agentic loop runs
	// before forcing a final answer. Each turn may issue several tool calls. Default 8.
	MaxAgentSteps int
	// MaxTokens is the per-turn completion token budget for the backing model. Too small a
	// value truncates tool-call argument JSON (causing dropped/garbled tool calls) and final
	// answers. Default 2048.
	MaxTokens int
	// ForceToolFirst, when true, forces the backing model to issue at least one MCP tool
	// call on the first turn (tool_choice=required) so the answer is actually grounded
	// instead of free-form from the model's own knowledge. Default true.
	ForceToolFirst bool
	// MaxTools caps how many MCP tools are exposed to the backing model in one loop. Too
	// many tools (e.g. vibe/all-mcp across dozens of upstreams) degrade tool-selection
	// accuracy and inflate token cost; the highest-ranked candidates' tools are kept.
	// Default 32.
	MaxTools int
}

// RedTeamConfig controls the bounded, simulation-only security regression campaign
// automatically created after security-sensitive admin changes.
type RedTeamConfig struct {
	PostChangeEnabled    bool
	PostChangeCooldown   time.Duration
	PostChangeMaxTargets int
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
	Provider      string
	BaseURL       string
	APIKey        string
	Timeout       time.Duration
	ModelPatterns string // comma-separated model globs routed to the default provider
	// ResponseHeaderTimeout bounds how long the gateway waits for an upstream's
	// response headers. Timeout covers the whole exchange (a long stream included),
	// so without this a hung provider holds a request for the full Timeout before
	// failover can start. Bounding only the header wait fails fast without
	// truncating legitimate long streams.
	ResponseHeaderTimeout time.Duration
	// FailoverBudget caps the total time spent trying alternate providers. Once the
	// budget is spent the gateway stops failing over and returns the last error
	// instead of walking the whole candidate list. Zero disables the cap.
	FailoverBudget time.Duration
	// Circuit breaker: after BreakerThreshold consecutive failures a provider is
	// skipped as a candidate for BreakerCooldown, then probed once.
	BreakerEnabled   bool
	BreakerThreshold int
	BreakerCooldown  time.Duration
	// LoadBalance selects how a model with several matching providers is served:
	// "first" (default, historical: always the first match by name) or "round_robin"
	// (spread across the matching providers).
	LoadBalance string
	// StickySessions keeps a session on the provider that first served it, so an
	// agentic client's turns do not bounce between nodes and lose their prefix cache.
	StickySessions bool
	StickyTTL      time.Duration
	// HealthDemoteThreshold moves a provider scoring below it to the back of the
	// candidate list. It never removes one — health is a lagging average, and a
	// recovered provider has to be tried to be observed recovering. Zero disables.
	HealthDemoteThreshold int
	// DefaultModel is the concrete model vibe/auto resolves to when set, so deployments whose
	// upstream is not OpenAI don't fall back to the built-in gpt-4.1* names. Empty → built-in list.
	DefaultModel string
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
	ChatSemanticMultiTurn     bool    // also embed multi-turn/tool requests (default off: single-turn only)
	// Optional dedicated embedding endpoint for the semantic cache. When empty, embedding
	// calls fall back to the normal provider selection (model glob → default upstream).
	EmbeddingProvider string // force this configured provider for embedding calls
	EmbeddingBaseURL  string // call this base URL directly (e.g. a local embedding server)
	EmbeddingAPIKey   string // bearer key for EmbeddingBaseURL (secret); empty → no/default auth
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

// PricingConfig holds runtime-adjustable pricing policy: the fallback model whose price
// costs unmatched models, and the USD→KRW rate used when seeding the built-in catalog.
type PricingConfig struct {
	FallbackModel string  // model name used to cost unmatched models; "" → qwen-plus
	USDToKRW      float64 // USD→KRW conversion applied at catalog seed time
}

// LimitsConfig holds request-shaping guardrails applied in the pipeline. MaxOutputTokens,
// when > 0, clamps a chat request's max_tokens/max_completion_tokens to that ceiling
// (injecting it when the client omits one) — a cost/runaway-generation guard.
type LimitsConfig struct {
	MaxOutputTokens int
	MaxRequestBytes int // reject chat request bodies larger than this many bytes; 0 = disabled
	MaxMessages     int // reject chat requests with more than this many messages; 0 = disabled
}

// SkillsConfig controls the Skill policy enforcement engine. A request opts into a skill
// via the X-Vibe-Skill header; the gateway then checks the requested model/tools against
// the skill's allowed_models/allowed_tools policy. Enforcement is a runtime-tunable mode so
// operators can roll it out as warn-only before blocking.
type SkillsConfig struct {
	Enforcement string // "off" | "warn" | "enforce" — default "warn"
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
	// Per-request fact sink (detailed behavioral DW). When RequestFactTable is set, every
	// completed request is shipped as one row via an async batch queue (never on the hot path).
	RequestFactTable    string        // e.g. ai_request_fact; empty disables the request-fact sink
	ToolFactTable       string        // e.g. ai_tool_fact; empty disables (one row per tool invocation)
	RoutingFactTable    string        // e.g. ai_routing_fact; empty disables (one row per routing decision)
	EvalFactTable       string        // e.g. ai_eval_fact; empty disables (one row per LLM evaluation)
	FeedbackFactTable   string        // e.g. ai_feedback_fact; empty disables (one row per human feedback)
	PolicyFactTable     string        // e.g. ai_policy_fact; empty disables (one row per policy decision)
	SkillFactTable      string        // e.g. ai_skill_fact; empty disables (one row per skill run)
	MultiModelFactTable string        // e.g. ai_multimodel_fact; empty disables (run + per-model result rows)
	RedTeamFactTable    string        // e.g. ai_redteam_fact; empty disables (one row per red-team case result)
	BatchSize           int           // rows per ClickHouse insert (queue flush)
	FlushInterval       time.Duration // max time a row waits in the queue before a flush
	MaxQueueSize        int           // bounded in-memory queue; excess is dropped (counted)
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
		ListenAddr:            getEnv("LISTEN_ADDR", ":8080"),
		RuntimeReloadInterval: durationEnv("SETTINGS_RELOAD_INTERVAL", 10*time.Second),
		Upstream: UpstreamConfig{
			Provider:      getEnv("UPSTREAM_PROVIDER", "openai"),
			BaseURL:       strings.TrimRight(getEnv("UPSTREAM_BASE_URL", "https://api.openai.com"), "/"),
			APIKey:        firstNonEmpty(os.Getenv("UPSTREAM_API_KEY"), os.Getenv("OPENAI_API_KEY")),
			Timeout:       durationEnv("UPSTREAM_TIMEOUT", 10*time.Minute),
			ModelPatterns: strings.TrimSpace(os.Getenv("UPSTREAM_MODEL_PATTERNS")),

			ResponseHeaderTimeout: durationEnv("UPSTREAM_RESPONSE_HEADER_TIMEOUT", 60*time.Second),
			FailoverBudget:        durationEnv("UPSTREAM_FAILOVER_BUDGET", 0),
			BreakerEnabled:        boolEnv("UPSTREAM_BREAKER_ENABLED", true),
			BreakerThreshold:      intEnv("UPSTREAM_BREAKER_THRESHOLD", 5),
			BreakerCooldown:       durationEnv("UPSTREAM_BREAKER_COOLDOWN", 30*time.Second),
			LoadBalance:           strings.ToLower(strings.TrimSpace(getEnv("UPSTREAM_LOAD_BALANCE", "first"))),
			StickySessions:        boolEnv("UPSTREAM_STICKY_SESSIONS", true),
			StickyTTL:             durationEnv("UPSTREAM_STICKY_TTL", 30*time.Minute),
			HealthDemoteThreshold: intEnv("UPSTREAM_HEALTH_DEMOTE_THRESHOLD", 50),
			DefaultModel:          strings.TrimSpace(os.Getenv("UPSTREAM_DEFAULT_MODEL")),
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
			ChatSemanticMultiTurn:     boolEnv("CACHE_CHAT_SEMANTIC_MULTITURN", false),
			EmbeddingProvider:         os.Getenv("CACHE_EMBEDDING_PROVIDER"),
			EmbeddingBaseURL:          os.Getenv("CACHE_EMBEDDING_BASE_URL"),
			EmbeddingAPIKey:           os.Getenv("CACHE_EMBEDDING_API_KEY"),
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
		Keycloak: KeycloakConfig{
			Enabled:         boolEnv("SSO_KEYCLOAK_ENABLED", false),
			IssuerURL:       strings.TrimRight(os.Getenv("SSO_KEYCLOAK_ISSUER_URL"), "/"),
			ClientID:        os.Getenv("SSO_KEYCLOAK_CLIENT_ID"),
			ClientSecret:    os.Getenv("SSO_KEYCLOAK_CLIENT_SECRET"),
			RedirectURI:     os.Getenv("SSO_KEYCLOAK_REDIRECT_URI"),
			Scopes:          keycloakScopes(),
			DefaultRole:     getEnv("SSO_KEYCLOAK_DEFAULT_ROLE", "developer"),
			RoleClaim:       getEnv("SSO_KEYCLOAK_ROLE_CLAIM", "realm_access.roles"),
			GroupClaim:      getEnv("SSO_KEYCLOAK_GROUP_CLAIM", "groups"),
			AllowLocalLogin: boolEnv("SSO_KEYCLOAK_ALLOW_LOCAL_LOGIN", true),
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
			URL:                 strings.TrimRight(os.Getenv("CLICKHOUSE_URL"), "/"),
			Database:            getEnv("CLICKHOUSE_DB", "default"),
			Table:               getEnv("CLICKHOUSE_TABLE", "analytics_daily"),
			User:                os.Getenv("CLICKHOUSE_USER"),
			Password:            os.Getenv("CLICKHOUSE_PASSWORD"),
			SinkInterval:        durationEnv("CLICKHOUSE_SINK_INTERVAL", 0),
			SinkDays:            intEnv("CLICKHOUSE_SINK_DAYS", 3),
			Text2SQLFactTable:   os.Getenv("CLICKHOUSE_TEXT2SQL_FACT_TABLE"),
			RequestFactTable:    os.Getenv("CLICKHOUSE_REQUEST_FACT_TABLE"),
			ToolFactTable:       os.Getenv("CLICKHOUSE_TOOL_FACT_TABLE"),
			RoutingFactTable:    os.Getenv("CLICKHOUSE_ROUTING_FACT_TABLE"),
			EvalFactTable:       os.Getenv("CLICKHOUSE_EVAL_FACT_TABLE"),
			FeedbackFactTable:   os.Getenv("CLICKHOUSE_FEEDBACK_FACT_TABLE"),
			SkillFactTable:      os.Getenv("CLICKHOUSE_SKILL_FACT_TABLE"),
			MultiModelFactTable: os.Getenv("CLICKHOUSE_MULTIMODEL_FACT_TABLE"),
			PolicyFactTable:     os.Getenv("CLICKHOUSE_POLICY_FACT_TABLE"),
			RedTeamFactTable:    os.Getenv("CLICKHOUSE_REDTEAM_FACT_TABLE"),
			BatchSize:           intEnv("CLICKHOUSE_BATCH_SIZE", 200),
			FlushInterval:       durationEnv("CLICKHOUSE_FLUSH_INTERVAL", 5*time.Second),
			MaxQueueSize:        intEnv("CLICKHOUSE_MAX_QUEUE_SIZE", 10000),
		},
		Pricing: map[string]ModelPrice{},
		PricingConf: PricingConfig{
			FallbackModel: getEnv("PRICING_FALLBACK_MODEL", "qwen-plus"),
			USDToKRW:      floatEnv("PRICING_USD_KRW", 1380.0),
		},
		Skills: SkillsConfig{
			Enforcement: getEnv("SKILLS_ENFORCEMENT", "warn"),
		},
		Limits: LimitsConfig{
			MaxOutputTokens: intEnv("LIMITS_MAX_OUTPUT_TOKENS", 0),
			MaxRequestBytes: intEnv("LIMITS_MAX_REQUEST_BYTES", 0),
			MaxMessages:     intEnv("LIMITS_MAX_MESSAGES", 0),
		},
		MCP: MCPConfig{
			AgenticModel:   os.Getenv("MCP_AGENTIC_MODEL"),
			MaxAgentSteps:  intEnv("MCP_MAX_AGENT_STEPS", 8),
			MaxTokens:      intEnv("MCP_MAX_TOKENS", 2048),
			ForceToolFirst: boolEnv("MCP_FORCE_TOOL_FIRST", true),
			MaxTools:       intEnv("MCP_MAX_TOOLS", 32),
		},
		RedTeam: RedTeamConfig{
			PostChangeEnabled:    boolEnv("REDTEAM_POST_CHANGE_ENABLED", true),
			PostChangeCooldown:   durationEnv("REDTEAM_POST_CHANGE_COOLDOWN", 10*time.Minute),
			PostChangeMaxTargets: intEnv("REDTEAM_POST_CHANGE_MAX_TARGETS", 20),
		},
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
// keycloakScopes parses SSO_KEYCLOAK_SCOPES (space- or comma-separated); defaults to the
// standard OIDC set. "openid" is always included.
func keycloakScopes() []string {
	raw := strings.TrimSpace(os.Getenv("SSO_KEYCLOAK_SCOPES"))
	if raw == "" {
		return []string{"openid", "profile", "email"}
	}
	fields := strings.FieldsFunc(raw, func(r rune) bool { return r == ' ' || r == ',' })
	hasOpenID := false
	out := []string{}
	for _, f := range fields {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		if f == "openid" {
			hasOpenID = true
		}
		out = append(out, f)
	}
	if !hasOpenID {
		out = append([]string{"openid"}, out...)
	}
	return out
}

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
