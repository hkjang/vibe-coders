package store

import (
	"encoding/json"
	"errors"
	"time"
)

var ErrNotFound = errors.New("not found")

type PromptSearch struct {
	Keyword  string
	APIKeyID string
	IP       string
	Language string
	Since    string
	Limit    int
}

type UsageFilter struct {
	Scope      string
	ScopeValue string
	Since      time.Time
}

type APIKeyRecord struct {
	ID               string
	Name             string
	KeyHash          string
	Owner            string
	Team             string
	UserID           string
	ServiceAccountID string
	Role             string
	Status           string
	Scopes           []string
	AllowedIPs       []string
	AllowedModels    []string
	DeniedModels     []string
	AllowedProviders []string
	DeniedProviders  []string
	BudgetLimitKRW   float64
	ExpiresAt        time.Time
	RevokedAt        time.Time
	CreatedAt        time.Time
}

type APIKeyPublic struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Owner            string   `json:"owner"`
	Team             string   `json:"team"`
	UserID           string   `json:"user_id"`
	ServiceAccountID string   `json:"service_account_id"`
	Role             string   `json:"role"`
	Status           string   `json:"status"`
	Scopes           []string `json:"scopes"`
	AllowedIPs       []string `json:"allowed_ips"`
	AllowedModels    []string `json:"allowed_models"`
	DeniedModels     []string `json:"denied_models"`
	AllowedProviders []string `json:"allowed_providers"`
	DeniedProviders  []string `json:"denied_providers"`
	BudgetLimitKRW   float64  `json:"budget_limit_krw"`
	ExpiresAt        string   `json:"expires_at"`
	RevokedAt        string   `json:"revoked_at"`
	CreatedAt        string   `json:"created_at"`
}

type AuthUser struct {
	ID           string    `json:"id"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"-"`
	Name         string    `json:"name"`
	Role         string    `json:"role"`
	Status       string    `json:"status"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type AuthTeam struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type UserTeamMembership struct {
	UserID    string    `json:"user_id"`
	TeamID    string    `json:"team_id"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"created_at"`
}

type AuthContext struct {
	UserID           string   `json:"user_id"`
	TeamID           string   `json:"team_id"`
	TeamName         string   `json:"team_name"`
	Role             string   `json:"role"`
	Scopes           []string `json:"scopes"`
	AllowedModels    []string `json:"allowed_models"`
	DeniedModels     []string `json:"denied_models"`
	AllowedProviders []string `json:"allowed_providers"`
	DeniedProviders  []string `json:"denied_providers"`
	BudgetLimitKRW   float64  `json:"budget_limit_krw"`
	AllowedIPs       []string `json:"allowed_ips"`
	APIKeyID         string   `json:"api_key_id"`
}

type AuthEvent struct {
	ID          string    `json:"id"`
	EventType   string    `json:"event_type"`
	ActorUserID string    `json:"actor_user_id"`
	APIKeyID    string    `json:"api_key_id"`
	TeamID      string    `json:"team_id"`
	IP          string    `json:"ip"`
	UserAgent   string    `json:"user_agent"`
	Detail      string    `json:"detail"`
	CreatedAt   time.Time `json:"created_at"`
}

type RefreshTokenRecord struct {
	ID          string
	UserID      string
	SessionID   string
	TokenHash   string
	RevokedAt   time.Time
	ExpiresAt   time.Time
	CreatedAt   time.Time
	RotatedFrom string
}

type ProviderConfig struct {
	Name            string
	BaseURL         string
	EncryptedAPIKey string
	TimeoutMS       int
	Enabled         bool
	ModelPatterns   string // comma-separated globs e.g. "claude-*,anthropic/*"
	CreatedAt       time.Time
}

type ProviderPublic struct {
	Name             string `json:"name"`
	BaseURL          string `json:"base_url"`
	APIKeyConfigured bool   `json:"api_key_configured"`
	TimeoutMS        int    `json:"timeout_ms"`
	Enabled          bool   `json:"enabled"`
	ModelPatterns    string `json:"model_patterns"`
	CreatedAt        string `json:"created_at"`
}

type AdminAuditLog struct {
	ID          string
	AdminID     string
	Action      string
	BeforeValue string
	AfterValue  string
	CreatedAt   time.Time
}

type AdminAuditPublic struct {
	ID          string `json:"id"`
	AdminID     string `json:"admin_id"`
	Action      string `json:"action"`
	BeforeValue string `json:"before_value"`
	AfterValue  string `json:"after_value"`
	CreatedAt   string `json:"created_at"`
}

type RequestLog struct {
	ID                  string
	TraceID             string
	APIKeyID            string
	ClientIP            string
	ForwardedFor        string
	UserAgent           string
	Hostname            string
	Model               string
	Endpoint            string
	Stream              bool
	Provider            string
	StatusCode          int
	LatencyMS           int64
	FirstChunkMS        int64
	SessionID           string
	PromptName          string
	PromptVersion       string
	PromptVariablesHash string
	ToolCount           int
	Error               string
	RequestHash         string
	BodyRaw             string // populated only when LOG_RAW_BODIES=true
	ReplayOf            string // request_id this row is a replay of, if any
	Failover            bool   // true when the request fell back to an alternate provider
	RouteReason         string // header | query | model_pattern | default
	RouteDetail         string // matched glob / header name
	Complexity          int    // 0-100 complexity proxy score
	FallbackFrom        string // original provider before failover
	FallbackReason      string // transport error that triggered failover
	RequestedModel      string // model the client asked for (before complexity routing)
	TaskType            string // heuristic task class (refactor/generate/debug/...) for routing learning
	PromptFingerprint   string // lexical fingerprint grouping near-identical task prompts
	Repo                string // X-Vibe-Repo / X-Repo — source repository
	Branch              string // X-Vibe-Branch / X-Branch — working branch
	Project             string // X-Vibe-Project / X-Project — logical project
	Service             string // X-Vibe-Service — calling service/app, for chargeback
	CostCenter          string // X-Vibe-Cost-Center / X-Budget-Code — budget allocation code
	CreatedAt           time.Time
}

type ComplexityAnalysis struct {
	Score               int     `json:"score"`
	Tier                string  `json:"tier"`
	PromptLength        int     `json:"prompt_length"`
	TokenEstimate       int     `json:"token_estimate"`
	CodeDensity         float64 `json:"code_density"`
	FileCount           int     `json:"file_count"`
	ConversationDepth   int     `json:"conversation_depth"`
	InstructionDensity  float64 `json:"instruction_density"`
	ReasoningKeywords   int     `json:"reasoning_keywords"`
	RefactoringKeywords int     `json:"refactoring_keywords"`
	DebuggingKeywords   int     `json:"debugging_keywords"`
}

type RiskAnalysis struct {
	Score      int      `json:"score"`
	Tier       string   `json:"tier"`
	Categories []string `json:"categories"`
}

type RoutingDecisionLog struct {
	ID               string             `json:"id"`
	RequestID        string             `json:"request_id"`
	TraceID          string             `json:"trace_id"`
	RequestedModel   string             `json:"requested_model"`
	SelectedModel    string             `json:"selected_model"`
	SelectedProvider string             `json:"selected_provider"`
	Complexity       ComplexityAnalysis `json:"complexity"`
	Risk             RiskAnalysis       `json:"risk"`
	HealthScore      int                `json:"health_score"`
	FallbackPath     []string           `json:"fallback_path"`
	DecisionReason   string             `json:"decision_reason"`
	CreatedAt        time.Time          `json:"created_at"`
}

type ProviderHealthScore struct {
	Provider         string  `json:"provider"`
	Score            int     `json:"score"`
	Requests         int64   `json:"requests"`
	AverageLatencyMS float64 `json:"average_latency_ms"`
	P95LatencyMS     int64   `json:"p95_latency_ms"`
	Timeouts         int64   `json:"timeouts"`
	Rate429          int64   `json:"rate_429"`
	Rate5xx          int64   `json:"rate_5xx"`
	Fallbacks        int64   `json:"fallbacks"`
	FallbackRate     float64 `json:"fallback_rate"`
}

type Budget struct {
	ID         string    `json:"id"`
	Scope      string    `json:"scope"` // global | api_key | team
	ScopeValue string    `json:"scope_value"`
	MonthlyKRW float64   `json:"monthly_krw"`
	Note       string    `json:"note"`
	CreatedAt  time.Time `json:"created_at"`
}

type BudgetStatus struct {
	Budget         Budget  `json:"budget"`
	SpentKRW       float64 `json:"spent_krw"`
	BurnRatio      float64 `json:"burn_ratio"`      // spent / monthly
	ProjectedKRW   float64 `json:"projected_krw"`   // run-rate extrapolated to month end
	ProjectedRatio float64 `json:"projected_ratio"` // projected / monthly
	DaysElapsed    float64 `json:"days_elapsed"`
	DaysInMonth    float64 `json:"days_in_month"`
	ExhaustionDate string  `json:"exhaustion_date"` // empty if not projected to exhaust this month
	OnTrack        bool    `json:"on_track"`        // projected <= monthly
}

type RoutingRule struct {
	ID             string    `json:"id"`
	Enabled        bool      `json:"enabled"`
	Priority       int       `json:"priority"`
	MatchPattern   string    `json:"match_pattern"` // glob on incoming model; "" or "*" = all
	MinComplexity  int       `json:"min_complexity"`
	MaxComplexity  int       `json:"max_complexity"`
	TargetModel    string    `json:"target_model"`
	TargetProvider string    `json:"target_provider"`
	Note           string    `json:"note"`
	CreatedAt      time.Time `json:"created_at"`
}

type PromptLog struct {
	ID           string
	RequestID    string
	Role         string
	ContentHash  string
	ContentText  string
	RedactedText string
	LanguageHint string
	CreatedAt    time.Time
}

type ResponseLog struct {
	ID                   string
	RequestID            string
	StatusCode           int
	FinishReason         string
	ResponseHash         string
	ResponseTextOptional string
	CreatedAt            time.Time
}

// CodeVerifyLog is the persisted verdict of the AI code output verification gate for one
// response. It stores only safe metadata — risk, counts, and per-finding rule/line/detail —
// never the raw code. FindingsJSON is a JSON array of {severity,category,rule,lang,line,detail}.
type CodeVerifyLog struct {
	ID            string
	RequestID     string
	TraceID       string
	HasCode       bool
	Risk          string
	BlockCount    int
	Languages     string // CSV of detected languages
	HighCount     int
	MediumCount   int
	SyntaxCount   int
	SecretCount   int
	TestableCount int
	FindingsJSON  string
	CreatedAt     time.Time
}

type TokenUsage struct {
	ID               string
	RequestID        string
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
	CachedTokens     int
	ReasoningTokens  int
	EstimatedCost    float64
	Currency         string
	Source           string
	CreatedAt        time.Time
}

type LanguageStat struct {
	ID         string
	RequestID  string
	Language   string
	Confidence float64
	Evidence   string
	CreatedAt  time.Time
}

type LogRecord struct {
	Request     RequestLog
	Prompts     []PromptLog
	Response    *ResponseLog
	Usage       *TokenUsage
	Languages   []LanguageStat
	Evaluations []LLMEvaluation
	Tools       []ToolInvocation
	Routing     *RoutingDecisionLog
	CodeVerify  *CodeVerifyLog
}

// ToolInvocation captures a single tool/MCP interaction observed in a request or
// response. Source is one of: definition (declared in request tools[]/functions[]),
// call (model invoked the tool), result (a role:tool result message in the request).
type ToolInvocation struct {
	ID           string    `json:"id"`
	RequestID    string    `json:"request_id"`
	TraceID      string    `json:"trace_id"`
	APIKeyID     string    `json:"api_key_id"`
	ServerLabel  string    `json:"server_label"` // MCP server name; "" for plain functions
	ToolName     string    `json:"tool_name"`
	Source       string    `json:"source"` // definition | call | result
	IsMCP        bool      `json:"is_mcp"`
	IsError      bool      `json:"is_error"`
	ArgSensitive bool      `json:"arg_sensitive"`
	ArgHash      string    `json:"arg_hash"`
	CreatedAt    time.Time `json:"created_at"`
}

type MCPCatalogEntry struct {
	ServerLabel string `json:"server_label"`
	ToolName    string `json:"tool_name"`
	IsMCP       bool   `json:"is_mcp"`
	FirstSeen   string `json:"first_seen"`
	LastSeen    string `json:"last_seen"`
	IsNew       bool   `json:"is_new"`   // first_seen within the query window
	IsStale     bool   `json:"is_stale"` // not seen recently
}

type MCPToolStat struct {
	ServerLabel  string  `json:"server_label"`
	ToolName     string  `json:"tool_name"`
	IsMCP        bool    `json:"is_mcp"`
	Definitions  int64   `json:"definitions"`
	Calls        int64   `json:"calls"`
	Results      int64   `json:"results"`
	Errors       int64   `json:"errors"`
	ErrorRate    float64 `json:"error_rate"`
	DistinctKeys int64   `json:"distinct_keys"`
	DistinctIPs  int64   `json:"distinct_ips"`
	SampleIP     string  `json:"sample_ip"`
	LastSeen     string  `json:"last_seen"`
}

type MCPPolicy struct {
	ServerLabel string    `json:"server_label"`
	Mode        string    `json:"mode"` // allow | block | warn
	Note        string    `json:"note"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type Policy struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
	Priority    int    `json:"priority"`
	// RolloutPercent gates canary enforcement: 100 = full enforce (default), 1-99 = enforce on
	// that share of matching traffic (deterministic bucket), 0 is treated as 100.
	RolloutPercent int          `json:"rollout_percent"`
	CreatedAt      time.Time    `json:"created_at"`
	UpdatedAt      time.Time    `json:"updated_at"`
	Rules          []PolicyRule `json:"rules,omitempty"`
}

type PolicyRule struct {
	ID         string         `json:"id"`
	PolicyID   string         `json:"policy_id"`
	Name       string         `json:"name"`
	Enabled    bool           `json:"enabled"`
	Priority   int            `json:"priority"`
	Conditions map[string]any `json:"conditions"`
	Actions    map[string]any `json:"actions"`
	// RolloutPercent is carried from the owning policy at active-rule load time so enforcement
	// can apply canary gating per rule. Not persisted on the rule itself.
	RolloutPercent int       `json:"rollout_percent,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type PolicyDecisionEvent struct {
	ID              string    `json:"id"`
	RequestID       string    `json:"request_id"`
	APIKeyID        string    `json:"api_key_id"`
	UserID          string    `json:"user_id"`
	TeamID          string    `json:"team_id"`
	Endpoint        string    `json:"endpoint"`
	Phase           string    `json:"phase"`
	PolicyID        string    `json:"policy_id"`
	RuleID          string    `json:"rule_id"`
	RuleName        string    `json:"rule_name"`
	Decision        string    `json:"decision"`
	Reason          string    `json:"reason"`
	Model           string    `json:"model"`
	Provider        string    `json:"provider"`
	RiskScore       int       `json:"risk_score"`
	ComplexityScore int       `json:"complexity_score"`
	CostKRW         float64   `json:"cost_krw"`
	CreatedAt       time.Time `json:"created_at"`
}

type PolicyDecisionFilter struct {
	Limit     int
	Since     time.Time
	RequestID string
	APIKeyID  string
	UserID    string
	TeamID    string
	Endpoint  string
	Phase     string
	PolicyID  string
	RuleID    string
	Decision  string
	Model     string
	Provider  string
}

type Approval struct {
	ID          string    `json:"id"`
	RequestID   string    `json:"request_id"`
	APIKeyID    string    `json:"api_key_id"`
	UserID      string    `json:"user_id"`
	TeamID      string    `json:"team_id"`
	SubjectType string    `json:"subject_type"`
	SubjectID   string    `json:"subject_id"`
	Status      string    `json:"status"` // pending | approved | rejected | expired
	Reason      string    `json:"reason"`
	RiskScore   int       `json:"risk_score"`
	CostKRW     float64   `json:"cost_krw"`
	Payload     string    `json:"payload"`
	ExpiresAt   time.Time `json:"expires_at"`
	DecidedBy   string    `json:"decided_by"`
	DecidedAt   time.Time `json:"decided_at"`
	CreatedAt   time.Time `json:"created_at"`
}

type ApprovalFilter struct {
	Limit       int
	Since       time.Time
	ID          string
	RequestID   string
	APIKeyID    string
	UserID      string
	TeamID      string
	SubjectType string
	SubjectID   string
	Status      string
	DecidedBy   string
	Reason      string
}

type SecretEvent struct {
	ID          string    `json:"id"`
	RequestID   string    `json:"request_id"`
	APIKeyID    string    `json:"api_key_id"`
	UserID      string    `json:"user_id"`
	TeamID      string    `json:"team_id"`
	SecretType  string    `json:"secret_type"`
	Action      string    `json:"action"` // detect | mask | block
	Location    string    `json:"location"`
	MatchedHash string    `json:"matched_hash"`
	CreatedAt   time.Time `json:"created_at"`
}

type SecretEventFilter struct {
	Limit       int
	Since       time.Time
	RequestID   string
	APIKeyID    string
	UserID      string
	TeamID      string
	SecretType  string
	Action      string
	Location    string
	MatchedHash string
}

type ToolRiskProfile struct {
	ID          string    `json:"id"`
	ServerLabel string    `json:"server_label"`
	ToolName    string    `json:"tool_name"`
	RiskLevel   string    `json:"risk_level"` // low | medium | high | critical
	Action      string    `json:"action"`     // allow | require_approval | block
	Note        string    `json:"note"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type MCPRouteDecision struct {
	ID             string    `json:"id"`
	RequestID      string    `json:"request_id"`
	TraceID        string    `json:"trace_id"`
	APIKeyID       string    `json:"api_key_id"`
	Method         string    `json:"method"`
	ExposedName    string    `json:"exposed_name"`
	UpstreamID     string    `json:"upstream_id"`
	UpstreamName   string    `json:"upstream_name"`
	TargetName     string    `json:"target_name"`
	ServerPolicy   string    `json:"server_policy"`
	ToolRiskLevel  string    `json:"tool_risk_level"`
	ToolRiskAction string    `json:"tool_risk_action"`
	FinalDecision  string    `json:"final_decision"`
	Reason         string    `json:"reason"`
	LatencyMS      int64     `json:"latency_ms"`
	CreatedAt      time.Time `json:"created_at"`
}

type MCPDiscoveryRun struct {
	ID            string    `json:"id"`
	UpstreamID    string    `json:"upstream_id"`
	UpstreamName  string    `json:"upstream_name"`
	Status        string    `json:"status"`
	ToolCount     int       `json:"tool_count"`
	PromptCount   int       `json:"prompt_count"`
	ResourceCount int       `json:"resource_count"`
	Error         string    `json:"error"`
	LatencyMS     int64     `json:"latency_ms"`
	CreatedAt     time.Time `json:"created_at"`
}

type ReplayJob struct {
	ID              string    `json:"id"`
	SourceRequestID string    `json:"source_request_id"`
	Prompt          string    `json:"prompt"`
	Models          []string  `json:"models"`
	Status          string    `json:"status"`
	Results         string    `json:"results"`
	CreatedBy       string    `json:"created_by"`
	CreatedAt       time.Time `json:"created_at"`
}

type GoldenPrompt struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Prompt    string    `json:"prompt"`
	Expected  string    `json:"expected"`
	Tags      []string  `json:"tags"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type GoldenPromptResult struct {
	ID        string    `json:"id"`
	PromptID  string    `json:"prompt_id"`
	Model     string    `json:"model"`
	Score     float64   `json:"score"`
	Passed    bool      `json:"passed"`
	CostKRW   float64   `json:"cost_krw"`
	LatencyMS int64     `json:"latency_ms"`
	Response  string    `json:"response"`
	CreatedAt time.Time `json:"created_at"`
}

// GoldenWorkflowStep is one ordered step of a Golden Workflow: a prompt and its
// expected substring/marker, scored independently (no inter-step output chaining).
type GoldenWorkflowStep struct {
	Name     string `json:"name"`
	Prompt   string `json:"prompt"`
	Expected string `json:"expected"`
	// Optional provenance/metadata captured when a step is promoted from a multi-model test,
	// for model-change regression (omitted from JSON when empty).
	TaskType      string  `json:"task_type,omitempty"`
	SelectedModel string  `json:"selected_model,omitempty"`
	BaselineScore float64 `json:"baseline_score,omitempty"`
	ContractID    string  `json:"contract_id,omitempty"`
	RubricID      string  `json:"rubric_id,omitempty"`
	SourceRunID   string  `json:"source_run_id,omitempty"`
}

// GoldenWorkflow is a named, ordered suite of golden steps run together as one
// regression unit — a first-class entity distinct from ad-hoc golden-prompt tags.
type GoldenWorkflow struct {
	ID          string               `json:"id"`
	Name        string               `json:"name"`
	Description string               `json:"description"`
	Steps       []GoldenWorkflowStep `json:"steps"`
	Tags        []string             `json:"tags"`
	CreatedAt   time.Time            `json:"created_at"`
	UpdatedAt   time.Time            `json:"updated_at"`
}

type AnomalyEvent struct {
	ID         string    `json:"id"`
	Scope      string    `json:"scope"`
	ScopeValue string    `json:"scope_value"`
	Metric     string    `json:"metric"`
	Value      float64   `json:"value"`
	Baseline   float64   `json:"baseline"`
	Severity   string    `json:"severity"`
	Channel    string    `json:"channel"`
	Status     string    `json:"status"`
	CreatedAt  time.Time `json:"created_at"`
}

type ContextRegistryEntry struct {
	ID            string    `json:"id"`
	Key           string    `json:"key"`
	Name          string    `json:"name"`
	Content       string    `json:"content"`
	Enabled       bool      `json:"enabled"`
	TokenEstimate int       `json:"token_estimate"`
	UseCount      int       `json:"use_count"`
	LastUsedAt    time.Time `json:"last_used_at"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type SessionToolLoop struct {
	SessionID   string `json:"session_id"`
	ServerLabel string `json:"server_label"`
	ToolName    string `json:"tool_name"`
	IsMCP       bool   `json:"is_mcp"`
	Calls       int64  `json:"calls"`
	Errors      int64  `json:"errors"`
	APIKeyID    string `json:"api_key_id"`
	FirstSeen   string `json:"first_seen"`
	LastSeen    string `json:"last_seen"`
}

type MCPServerStat struct {
	ServerLabel  string  `json:"server_label"`
	IsMCP        bool    `json:"is_mcp"`
	Tools        int64   `json:"tools"`
	Calls        int64   `json:"calls"`
	Errors       int64   `json:"errors"`
	ErrorRate    float64 `json:"error_rate"`
	DistinctKeys int64   `json:"distinct_keys"`
	DistinctIPs  int64   `json:"distinct_ips"`
	SampleIP     string  `json:"sample_ip"`
	LastSeen     string  `json:"last_seen"`
}

type SummaryStats struct {
	TotalRequests    int64             `json:"total_requests"`
	TotalTokens      int64             `json:"total_tokens"`
	TotalCostKRW     float64           `json:"total_cost_krw"`
	AverageLatencyMS float64           `json:"average_latency_ms"`
	ByIP             []GroupedStat     `json:"by_ip"`
	ByModel          []GroupedStat     `json:"by_model"`
	ByLanguage       []LanguageGrouped `json:"by_language"`
	ByStatus         []StatusBucket    `json:"by_status"`
	TopUsers         []UserSummary     `json:"top_users"`
}

type StatusBucket struct {
	Class    string `json:"class"` // 2xx / 3xx / 4xx / 5xx / quota
	Requests int64  `json:"requests"`
}

type TimeseriesQuery struct {
	Bucket     string // "hour" | "day"
	Since      time.Time
	Scope      string // optional: api_key / ip / model
	ScopeValue string
}

type HeatmapCell struct {
	Day      int   `json:"day"`  // 0=Sunday (KST)
	Hour     int   `json:"hour"` // 0-23
	Requests int64 `json:"requests"`
}

type Heatmap struct {
	Since string        `json:"since"`
	Cells []HeatmapCell `json:"cells"`
}

type GroupedStat struct {
	Key              string  `json:"key"`
	Requests         int64   `json:"requests"`
	Tokens           int64   `json:"tokens"`
	CostKRW          float64 `json:"cost_krw"`
	AverageLatencyMS float64 `json:"average_latency_ms"`
}

type LanguageGrouped struct {
	Language          string  `json:"language"`
	Requests          int64   `json:"requests"`
	AverageConfidence float64 `json:"average_confidence"`
}

type RequestFilter struct {
	Limit          int
	IP             string
	Model          string
	Language       string
	APIKeyID       string
	Team           string
	TraceID        string
	SessionID      string
	PromptName     string
	PromptVersion  string
	EvaluationName string
	ToolServer     string
	ToolName       string
	ToolErrorsOnly bool
}

type RecentRequest struct {
	ID                  string          `json:"id"`
	TraceID             string          `json:"trace_id"`
	APIKeyID            string          `json:"api_key_id"`
	ClientIP            string          `json:"client_ip"`
	ForwardedFor        string          `json:"forwarded_for"`
	UserAgent           string          `json:"user_agent"`
	Model               string          `json:"model"`
	Endpoint            string          `json:"endpoint"`
	Stream              bool            `json:"stream"`
	Provider            string          `json:"provider"`
	StatusCode          int             `json:"status_code"`
	LatencyMS           int64           `json:"latency_ms"`
	FirstChunkMS        int64           `json:"first_chunk_ms"`
	SessionID           string          `json:"session_id"`
	PromptName          string          `json:"prompt_name"`
	PromptVersion       string          `json:"prompt_version"`
	PromptVariablesHash string          `json:"prompt_variables_hash"`
	ToolCount           int             `json:"tool_count"`
	Error               string          `json:"error"`
	PromptTokens        int             `json:"prompt_tokens"`
	CompletionTokens    int             `json:"completion_tokens"`
	TotalTokens         int             `json:"total_tokens"`
	CachedTokens        int             `json:"cached_tokens"`
	ReasoningTokens     int             `json:"reasoning_tokens"`
	EstimatedCost       float64         `json:"estimated_cost"`
	Currency            string          `json:"currency"`
	TokenSource         string          `json:"token_source"`
	FinishReason        string          `json:"finish_reason"`
	Languages           []LanguageStat  `json:"languages"`
	Prompts             []PromptPreview `json:"prompts"`
	Tags                []string        `json:"tags,omitempty"`
	Note                string          `json:"note,omitempty"`
	CreatedAt           string          `json:"created_at"`
}

type PromptPreview struct {
	Role         string `json:"role"`
	RedactedText string `json:"redacted_text"`
	LanguageHint string `json:"language_hint"`
}

type PromptDetail struct {
	ID           string `json:"id"`
	RequestID    string `json:"request_id"`
	Role         string `json:"role"`
	ContentHash  string `json:"content_hash"`
	ContentText  string `json:"content_text"`
	RedactedText string `json:"redacted_text"`
	LanguageHint string `json:"language_hint"`
	CreatedAt    string `json:"created_at"`
}

type ResponseDetail struct {
	StatusCode           int    `json:"status_code"`
	FinishReason         string `json:"finish_reason"`
	ResponseHash         string `json:"response_hash"`
	ResponseTextOptional string `json:"response_text_optional"`
	CreatedAt            string `json:"created_at"`
}

// CodeVerifyDetail is the request-detail view of a persisted code verification verdict.
type CodeVerifyDetail struct {
	Risk          string          `json:"risk"`
	HasCode       bool            `json:"has_code"`
	BlockCount    int             `json:"block_count"`
	Languages     string          `json:"languages"`
	HighCount     int             `json:"high_count"`
	MediumCount   int             `json:"medium_count"`
	SyntaxCount   int             `json:"syntax_count"`
	SecretCount   int             `json:"secret_count"`
	TestableCount int             `json:"testable_count"`
	Findings      json.RawMessage `json:"findings"`
	CreatedAt     string          `json:"created_at"`
}

type RequestDetail struct {
	Request       RecentRequest     `json:"request"`
	Prompts       []PromptDetail    `json:"prompts"`
	Response      *ResponseDetail   `json:"response,omitempty"`
	Languages     []LanguageStat    `json:"languages"`
	Spans         []LLMSpan         `json:"spans"`
	Text2SQLSpans []Text2SQLSpan    `json:"text2sql_spans"`
	Evaluations   []LLMEvaluation   `json:"evaluations"`
	Feedback      []LLMFeedback     `json:"feedback"`
	Tools         []ToolInvocation  `json:"tools"`
	Governance    GovernanceEvents  `json:"governance"`
	CodeVerify    *CodeVerifyDetail `json:"code_verify,omitempty"`
}

type GovernanceEvents struct {
	SecretEvents    []SecretEvent         `json:"secret_events"`
	Approvals       []Approval            `json:"approvals"`
	AnomalyEvents   []AnomalyEvent        `json:"anomaly_events"`
	PolicyDecisions []PolicyDecisionEvent `json:"policy_decisions"`
}

type LLMSpan struct {
	ID               string  `json:"id"`
	TraceID          string  `json:"trace_id"`
	RequestID        string  `json:"request_id"`
	ParentID         string  `json:"parent_id"`
	Name             string  `json:"name"`
	Kind             string  `json:"kind"`
	Status           string  `json:"status"`
	Error            string  `json:"error"`
	LatencyMS        int64   `json:"latency_ms"`
	FirstChunkMS     int64   `json:"first_chunk_ms"`
	PromptTokens     int     `json:"prompt_tokens"`
	CompletionTokens int     `json:"completion_tokens"`
	TotalTokens      int     `json:"total_tokens"`
	EstimatedCost    float64 `json:"estimated_cost"`
	ToolCount        int     `json:"tool_count"`
	CreatedAt        string  `json:"created_at"`
}

type LLMEvaluation struct {
	ID        string    `json:"id"`
	RequestID string    `json:"request_id"`
	TraceID   string    `json:"trace_id"`
	Name      string    `json:"name"`
	Category  string    `json:"category"`
	Evaluator string    `json:"evaluator"`
	Score     float64   `json:"score"`
	Label     string    `json:"label"`
	Passed    bool      `json:"passed"`
	Reason    string    `json:"reason"`
	Metadata  string    `json:"metadata"`
	CreatedAt time.Time `json:"created_at"`
}

type LLMEvaluationSummary struct {
	Name         string  `json:"name"`
	Category     string  `json:"category"`
	Total        int64   `json:"total"`
	Passed       int64   `json:"passed"`
	Failed       int64   `json:"failed"`
	AverageScore float64 `json:"average_score"`
}

type LLMFeedback struct {
	ID        string    `json:"id"`
	RequestID string    `json:"request_id"`
	TraceID   string    `json:"trace_id"`
	Rating    int       `json:"rating"`
	Label     string    `json:"label"`
	Comment   string    `json:"comment"`
	Source    string    `json:"source"`
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
}

type LLMFeedbackSummary struct {
	Total         int64   `json:"total"`
	Positive      int64   `json:"positive"`
	Negative      int64   `json:"negative"`
	Neutral       int64   `json:"neutral"`
	AverageRating float64 `json:"average_rating"`
}

type LLMFeedbackLabelSummary struct {
	Label         string  `json:"label"`
	Total         int64   `json:"total"`
	Positive      int64   `json:"positive"`
	Negative      int64   `json:"negative"`
	Neutral       int64   `json:"neutral"`
	AverageRating float64 `json:"average_rating"`
}

type LLMFeedbackPromptSummary struct {
	PromptName    string  `json:"prompt_name"`
	PromptVersion string  `json:"prompt_version"`
	Total         int64   `json:"total"`
	Positive      int64   `json:"positive"`
	Negative      int64   `json:"negative"`
	Neutral       int64   `json:"neutral"`
	AverageRating float64 `json:"average_rating"`
	LastSeen      string  `json:"last_seen"`
}

type LLMAlignmentSummary struct {
	Total              int64   `json:"total"`
	Aligned            int64   `json:"aligned"`
	Misaligned         int64   `json:"misaligned"`
	AlignmentRate      float64 `json:"alignment_rate"`
	HumanNegativeCount int64   `json:"human_negative_count"`
}

type LLMAlignmentPromptSummary struct {
	PromptName      string  `json:"prompt_name"`
	PromptVersion   string  `json:"prompt_version"`
	Total           int64   `json:"total"`
	Aligned         int64   `json:"aligned"`
	Misaligned      int64   `json:"misaligned"`
	AlignmentRate   float64 `json:"alignment_rate"`
	HumanNegative   int64   `json:"human_negative"`
	EvalFailureRate float64 `json:"eval_failure_rate"`
	LastSeen        string  `json:"last_seen"`
}

type LLMTimeseriesPoint struct {
	Date                string  `json:"date"`
	Bucket              string  `json:"bucket"`
	Requests            int64   `json:"requests"`
	Tokens              int64   `json:"tokens"`
	CostKRW             float64 `json:"cost_krw"`
	Errors              int64   `json:"errors"`
	AverageFirstChunkMS float64 `json:"average_first_chunk_ms"`
	EvaluationFailures  int64   `json:"evaluation_failures"`
	FeedbackTotal       int64   `json:"feedback_total"`
	NegativeFeedback    int64   `json:"negative_feedback"`
	AlignmentSamples    int64   `json:"alignment_samples"`
	AlignmentRate       float64 `json:"alignment_rate"`
}

type LLMPromptSummary struct {
	PromptName       string  `json:"prompt_name"`
	PromptVersion    string  `json:"prompt_version"`
	Calls            int64   `json:"calls"`
	Tokens           int64   `json:"tokens"`
	CostKRW          float64 `json:"cost_krw"`
	AverageLatencyMS float64 `json:"average_latency_ms"`
	Errors           int64   `json:"errors"`
	EvalFailures     int64   `json:"eval_failures"`
	FirstSeen        string  `json:"first_seen"`
	LastSeen         string  `json:"last_seen"`
}

type LLMPromptComparisonDelta struct {
	Calls            int64   `json:"calls"`
	Tokens           int64   `json:"tokens"`
	CostKRW          float64 `json:"cost_krw"`
	AverageLatencyMS float64 `json:"average_latency_ms"`
	ErrorRate        float64 `json:"error_rate"`
	EvalFailureRate  float64 `json:"eval_failure_rate"`
}

type LLMPromptBaselineCandidate struct {
	PromptVersion    string  `json:"prompt_version"`
	Reason           string  `json:"reason"`
	Calls            int64   `json:"calls"`
	AverageLatencyMS float64 `json:"average_latency_ms"`
	ErrorRate        float64 `json:"error_rate"`
	EvalFailureRate  float64 `json:"eval_failure_rate"`
	LastSeen         string  `json:"last_seen"`
}

type LLMPromptComparison struct {
	PromptName         string                       `json:"prompt_name"`
	Candidate          LLMPromptSummary             `json:"candidate"`
	Baseline           *LLMPromptSummary            `json:"baseline,omitempty"`
	BaselineReason     string                       `json:"baseline_reason,omitempty"`
	BaselineCandidates []LLMPromptBaselineCandidate `json:"baseline_candidates,omitempty"`
	CandidateOrdering  string                       `json:"candidate_ordering,omitempty"`
	AvailableVersions  []string                     `json:"available_versions"`
	CandidateErrorRate float64                      `json:"candidate_error_rate"`
	BaselineErrorRate  float64                      `json:"baseline_error_rate"`
	CandidateEvalRate  float64                      `json:"candidate_eval_failure_rate"`
	BaselineEvalRate   float64                      `json:"baseline_eval_failure_rate"`
	Delta              LLMPromptComparisonDelta     `json:"delta"`
}

type LLMPatternSummary struct {
	Pattern          string  `json:"pattern"`
	Language         string  `json:"language"`
	Requests         int64   `json:"requests"`
	Tokens           int64   `json:"tokens"`
	CostKRW          float64 `json:"cost_krw"`
	Errors           int64   `json:"errors"`
	AverageLatencyMS float64 `json:"average_latency_ms"`
	Sample           string  `json:"sample"`
}

type LLMInsight struct {
	ID             string  `json:"id"`
	Severity       string  `json:"severity"`
	Kind           string  `json:"kind"`
	Title          string  `json:"title"`
	Detail         string  `json:"detail"`
	Scope          string  `json:"scope"`
	ScopeValue     string  `json:"scope_value"`
	ScopeDetail    string  `json:"scope_detail,omitempty"`
	Count          int64   `json:"count"`
	MetricValue    float64 `json:"metric_value"`
	Recommendation string  `json:"recommendation"`
	LastSeen       string  `json:"last_seen"`
}

type LLMSessionSummary struct {
	SessionID          string  `json:"session_id"`
	Requests           int64   `json:"requests"`
	Tokens             int64   `json:"tokens"`
	CostKRW            float64 `json:"cost_krw"`
	Errors             int64   `json:"errors"`
	EvaluationFailures int64   `json:"evaluation_failures"`
	FirstSeen          string  `json:"first_seen"`
	LastSeen           string  `json:"last_seen"`
}

type DomainRoutingDecision struct {
	ID                  string   `json:"id"`
	RequestID           string   `json:"request_id"`
	UserID              string   `json:"user_id"`
	TeamID              string   `json:"team_id"`
	QueryHash           string   `json:"query_hash"`
	Route               string   `json:"route"`
	Confidence          float64  `json:"confidence"`
	ToolNames           []string `json:"tool_names"`
	EvidenceScore       float64  `json:"evidence_score"`
	EvidenceCount       int      `json:"evidence_count"`
	FallbackUsed        bool     `json:"fallback_used"`
	BlockedByGovernance bool     `json:"blocked_by_governance"`
	Reason              string   `json:"reason"`
	CreatedAt           string   `json:"created_at"`
}

type DomainRoutingSignal struct {
	ID         string  `json:"id"`
	DecisionID string  `json:"decision_id"`
	Source     string  `json:"source"`
	Route      string  `json:"route"`
	Score      float64 `json:"score"`
	Reason     string  `json:"reason"`
	CreatedAt  string  `json:"created_at"`
}

type DomainExample struct {
	ID           string  `json:"id"`
	Route        string  `json:"route"`
	Text         string  `json:"text"`
	TextHash     string  `json:"text_hash"`
	Source       string  `json:"source"`
	Confidence   float64 `json:"confidence"`
	Approved     bool    `json:"approved"`
	AutoPromoted bool    `json:"auto_promoted"`
	CreatedAt    string  `json:"created_at"`
}

type DomainReviewQueueItem struct {
	ID             string `json:"id"`
	DecisionID     string `json:"decision_id"`
	QueryText      string `json:"query_text"`
	SuggestedRoute string `json:"suggested_route"`
	CurrentRoute   string `json:"current_route"`
	Reason         string `json:"reason"`
	Status         string `json:"status"`
	CreatedAt      string `json:"created_at"`
	ReviewedAt     string `json:"reviewed_at"`
}

type DomainRoutingFilter struct {
	Limit     int
	Route     string
	Status    string
	RequestID string
	Since     time.Time
}

type SessionTimelinePoint struct {
	RequestID         string  `json:"request_id"`
	TraceID           string  `json:"trace_id"`
	Model             string  `json:"model"`
	Provider          string  `json:"provider"`
	PromptName        string  `json:"prompt_name"`
	StatusCode        int     `json:"status_code"`
	LatencyMS         int64   `json:"latency_ms"`
	FirstChunkMS      int64   `json:"first_chunk_ms"`
	TotalTokens       int64   `json:"total_tokens"`
	CostKRW           float64 `json:"cost_krw"`
	ToolCalls         int64   `json:"tool_calls"`
	ToolErrors        int64   `json:"tool_errors"`
	EvalFailures      int64   `json:"eval_failures"`
	CreatedAt         string  `json:"created_at"`
	CumulativeCostKRW float64 `json:"cumulative_cost_krw"`
	CumulativeTokens  int64   `json:"cumulative_tokens"`
}

type ScatterPoint struct {
	RequestID           string  `json:"request_id"`
	TraceID             string  `json:"trace_id"`
	CreatedAt           string  `json:"created_at"`
	LatencyMS           int64   `json:"latency_ms"`
	FirstChunkMS        int64   `json:"first_chunk_ms"`
	StatusCode          int     `json:"status_code"`
	Provider            string  `json:"provider"`
	Model               string  `json:"model"`
	Endpoint            string  `json:"endpoint"`
	TotalTokens         int64   `json:"total_tokens"`
	CostKRW             float64 `json:"cost_krw"`
	Stream              bool    `json:"stream"`
	ToolCount           int     `json:"tool_count"`
	Failover            bool    `json:"failover"`
	Complexity          int     `json:"complexity"`
	RiskScore           int     `json:"risk_score"`
	HealthScore         int     `json:"health_score"`
	DecisionReason      string  `json:"decision_reason"`
	PolicyDecisionCount int     `json:"policy_decision_count"`
	PolicyDecision      string  `json:"policy_decision"`
	ApprovalCount       int     `json:"approval_count"`
	ApprovalStatus      string  `json:"approval_status"`
	SecretEventCount    int     `json:"secret_event_count"`
	SecretAction        string  `json:"secret_action"`
}

type ScatterFilter struct {
	Since    time.Time
	Endpoint string
	Model    string   // single model (backward compat); ignored when Models is non-empty
	Models   []string // multi-model filter; empty = all models
	APIKeyID string
	Limit    int
}

// ScatterModelGroup holds per-model aggregate statistics computed from scatter points.
type ScatterModelGroup struct {
	Model           string  `json:"model"`
	Count           int64   `json:"count"`
	ErrorRate       float64 `json:"error_rate"`
	P50             int64   `json:"p50"`
	P95             int64   `json:"p95"`
	P99             int64   `json:"p99"`
	AvgFirstChunkMS float64 `json:"avg_first_chunk_ms"`
	TotalTokens     int64   `json:"total_tokens"`
	TotalCostKRW    float64 `json:"total_cost_krw"`
	AvgCostKRW      float64 `json:"avg_cost_krw"`
	FailoverCount   int64   `json:"failover_count"`
	GovernanceCount int64   `json:"governance_count"`
	RiskP95         float64 `json:"risk_p95"`
	HealthAvg       float64 `json:"health_avg"`
}

type AnomalyFinding struct {
	Model           string  `json:"model"`
	Metric          string  `json:"metric"` // cost_per_request | latency_ms | first_chunk_ms
	BaselineMean    float64 `json:"baseline_mean"`
	BaselineStd     float64 `json:"baseline_std"`
	RecentMean      float64 `json:"recent_mean"`
	ZScore          float64 `json:"z_score"`
	Direction       string  `json:"direction"` // up | down
	BaselineSamples int64   `json:"baseline_samples"`
	RecentSamples   int64   `json:"recent_samples"`
}

type CostAnomalyFinding struct {
	Scope           string  `json:"scope"` // global | api_key | team | model
	ScopeValue      string  `json:"scope_value"`
	Metric          string  `json:"metric"` // cost_total
	BaselineMean    float64 `json:"baseline_mean"`
	BaselineStd     float64 `json:"baseline_std"`
	RecentValue     float64 `json:"recent_value"`
	ZScore          float64 `json:"z_score"`
	Direction       string  `json:"direction"` // up | down
	BaselineBuckets int64   `json:"baseline_buckets"`
	RecentSamples   int64   `json:"recent_samples"`
}

type SessionTimeline struct {
	SessionID       string                 `json:"session_id"`
	Requests        int                    `json:"requests"`
	TotalCostKRW    float64                `json:"total_cost_krw"`
	TotalTokens     int64                  `json:"total_tokens"`
	ToolCalls       int64                  `json:"tool_calls"`
	DurationSeconds int64                  `json:"duration_seconds"`
	Points          []SessionTimelinePoint `json:"points"`
}

type UserSummary struct {
	APIKeyID         string  `json:"api_key_id"`
	Name             string  `json:"name"`
	Owner            string  `json:"owner"`
	Team             string  `json:"team"`
	Status           string  `json:"status"`
	Requests         int64   `json:"requests"`
	Tokens           int64   `json:"tokens"`
	CostKRW          float64 `json:"cost_krw"`
	AverageLatencyMS float64 `json:"average_latency_ms"`
	LastSeen         string  `json:"last_seen"`
}

type IPSummary struct {
	IP               string  `json:"ip"`
	Requests         int64   `json:"requests"`
	Tokens           int64   `json:"tokens"`
	CostKRW          float64 `json:"cost_krw"`
	AverageLatencyMS float64 `json:"average_latency_ms"`
	LastSeen         string  `json:"last_seen"`
	DistinctKeys     int64   `json:"distinct_keys"`
}

type TimeseriesPoint struct {
	Date     string  `json:"date"`
	Bucket   string  `json:"bucket"`
	Requests int64   `json:"requests"`
	Tokens   int64   `json:"tokens"`
	CostKRW  float64 `json:"cost_krw"`
}

type UserAdvancedStats struct {
	Requests24h         int64   `json:"requests_24h"`
	Tokens24h           int64   `json:"tokens_24h"`
	CostKRW24h          float64 `json:"cost_krw_24h"`
	Errors              int64   `json:"errors"`
	ErrorRate           float64 `json:"error_rate"`
	LatencyP95MS        float64 `json:"latency_p95_ms"`
	FirstChunkP95MS     float64 `json:"first_chunk_p95_ms"`
	AverageFirstChunkMS float64 `json:"average_first_chunk_ms"`
	PromptTokens        int64   `json:"prompt_tokens"`
	CompletionTokens    int64   `json:"completion_tokens"`
	CachedTokens        int64   `json:"cached_tokens"`
	ReasoningTokens     int64   `json:"reasoning_tokens"`
	DistinctModels      int64   `json:"distinct_models"`
	DistinctIPs         int64   `json:"distinct_ips"`
}

type UserLLMStats struct {
	Requests            int64   `json:"requests"`
	Sessions            int64   `json:"sessions"`
	PromptVariants      int64   `json:"prompt_variants"`
	Evaluations         int64   `json:"evaluations"`
	EvalFailures        int64   `json:"eval_failures"`
	FeedbackTotal       int64   `json:"feedback_total"`
	NegativeFeedback    int64   `json:"negative_feedback"`
	AlignmentSamples    int64   `json:"alignment_samples"`
	AlignmentRate       float64 `json:"alignment_rate"`
	AverageFirstChunkMS float64 `json:"average_first_chunk_ms"`
	LastSeen            string  `json:"last_seen"`
}

type UserLLMDetail struct {
	Summary        UserLLMStats              `json:"summary"`
	Timeseries     []LLMTimeseriesPoint      `json:"timeseries"`
	Prompts        []LLMPromptSummary        `json:"prompts"`
	FeedbackLabels []LLMFeedbackLabelSummary `json:"feedback_labels"`
}

type UserDetail struct {
	APIKey     APIKeyPublic      `json:"api_key"`
	Stats      UserSummary       `json:"stats"`
	Advanced   UserAdvancedStats `json:"advanced"`
	LLM        UserLLMDetail     `json:"llm"`
	ByStatus   []StatusBucket    `json:"by_status"`
	Heatmap    Heatmap           `json:"heatmap"`
	Daily      []TimeseriesPoint `json:"daily"`
	ByModel    []GroupedStat     `json:"by_model"`
	ByLanguage []LanguageGrouped `json:"by_language"`
	ByIP       []GroupedStat     `json:"by_ip"`
	Recent     []RecentRequest   `json:"recent"`
}

type TeamSummary struct {
	Team             string  `json:"team"`
	Keys             int64   `json:"keys"`
	Requests         int64   `json:"requests"`
	Tokens           int64   `json:"tokens"`
	CostKRW          float64 `json:"cost_krw"`
	AverageLatencyMS float64 `json:"average_latency_ms"`
	LastSeen         string  `json:"last_seen"`
}

type TeamDetail struct {
	Stats      TeamSummary       `json:"stats"`
	Advanced   UserAdvancedStats `json:"advanced"`
	LLM        UserLLMDetail     `json:"llm"`
	ByStatus   []StatusBucket    `json:"by_status"`
	Heatmap    Heatmap           `json:"heatmap"`
	Daily      []TimeseriesPoint `json:"daily"`
	ByModel    []GroupedStat     `json:"by_model"`
	ByLanguage []LanguageGrouped `json:"by_language"`
	ByIP       []GroupedStat     `json:"by_ip"`
	ByKey      []GroupedStat     `json:"by_key"`
	Recent     []RecentRequest   `json:"recent"`
}

type IPDetail struct {
	Stats      IPSummary         `json:"stats"`
	Daily      []TimeseriesPoint `json:"daily"`
	ByModel    []GroupedStat     `json:"by_model"`
	ByLanguage []LanguageGrouped `json:"by_language"`
	ByKey      []GroupedStat     `json:"by_key"`
	Recent     []RecentRequest   `json:"recent"`
}

type QuotaRecord struct {
	ID         string
	Scope      string
	ScopeValue string
	Period     string
	TokenLimit int64
	KRWLimit   float64
	Enabled    bool
	Note       string
	CreatedAt  time.Time
}

type QuotaPublic struct {
	ID         string  `json:"id"`
	Scope      string  `json:"scope"`
	ScopeValue string  `json:"scope_value"`
	Period     string  `json:"period"`
	TokenLimit int64   `json:"token_limit"`
	KRWLimit   float64 `json:"krw_limit"`
	Enabled    bool    `json:"enabled"`
	Note       string  `json:"note"`
	CreatedAt  string  `json:"created_at"`
}

type QuotaUsage struct {
	Quota            QuotaPublic `json:"quota"`
	Tokens           int64       `json:"tokens"`
	CostKRW          float64     `json:"cost_krw"`
	Requests         int64       `json:"requests"`
	PeriodStart      string      `json:"period_start"`
	PeriodEnd        string      `json:"period_end"`
	TokenRemainRatio float64     `json:"token_remain_ratio"`
	KRWRemainRatio   float64     `json:"krw_remain_ratio"`
}

type RequestNote struct {
	RequestID string    `json:"request_id"`
	Tags      []string  `json:"tags"`
	Note      string    `json:"note"`
	CreatedBy string    `json:"created_by"`
	UpdatedAt time.Time `json:"updated_at"`
}

type SavedFilter struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	View      string    `json:"view"`   // requests | prompts
	Params    string    `json:"params"` // raw URL query string
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
}

type RuntimeFlag struct {
	Key       string    `json:"key"`
	Value     string    `json:"value"`
	UpdatedAt time.Time `json:"updated_at"`
	UpdatedBy string    `json:"updated_by"`
	Note      string    `json:"note"`
}

type AlertRule struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Metric        string     `json:"metric"`         // requests | errors | krw | tokens | latency_p95_ms | first_chunk_p95_ms | llm_eval_failures | llm_eval_failure_rate
	WindowSeconds int        `json:"window_seconds"` // evaluation window (e.g. 60, 300)
	Threshold     float64    `json:"threshold"`
	Scope         string     `json:"scope"` // global | api_key | team | ip | model
	ScopeValue    string     `json:"scope_value"`
	WebhookURL    string     `json:"webhook_url"`
	Enabled       bool       `json:"enabled"`
	Note          string     `json:"note"`
	CreatedAt     time.Time  `json:"created_at"`
	LastFiredAt   *time.Time `json:"last_fired_at,omitempty"`
	LastValue     float64    `json:"last_value"`
}

type AlertMetricSnapshot struct {
	Requests           int64
	Errors             int64
	CostKRW            float64
	Tokens             int64
	LatencyP95MS       float64
	FirstChunkP95MS    float64
	LLMEvaluations     int64
	LLMEvalFailures    int64
	ToolCalls          int64
	ToolErrors         int64
	MaxSessionToolCall int64
	NewCatalogTools    int64
	MaxAnomalyZ        float64
	MaxBudgetRatio     float64
}

type AlertEvent struct {
	ID            string    `json:"id"`
	RuleID        string    `json:"rule_id"`
	RuleName      string    `json:"rule_name"`
	Metric        string    `json:"metric"`
	Value         float64   `json:"value"`
	Threshold     float64   `json:"threshold"`
	Delivered     bool      `json:"delivered"`
	DeliveryError string    `json:"delivery_error,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
}

type RetentionStatus struct {
	RequestDays  int    `json:"request_days"`
	PromptDays   int    `json:"prompt_days"`
	ResponseDays int    `json:"response_days"`
	Requests     int64  `json:"requests"`
	Prompts      int64  `json:"prompts"`
	Responses    int64  `json:"responses"`
	LastRunAt    string `json:"last_run_at"`
	LastDeleted  int64  `json:"last_deleted"`
}
