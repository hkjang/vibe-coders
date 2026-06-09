package store

import (
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
	ID        string
	Name      string
	KeyHash   string
	Owner     string
	Team      string
	Status    string
	CreatedAt time.Time
}

type APIKeyPublic struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Owner     string `json:"owner"`
	Team      string `json:"team"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
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
	CreatedAt           time.Time
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
	LastSeen     string  `json:"last_seen"`
}

type MCPPolicy struct {
	ServerLabel string    `json:"server_label"`
	Mode        string    `json:"mode"` // allow | block | warn
	Note        string    `json:"note"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
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

type RequestDetail struct {
	Request     RecentRequest    `json:"request"`
	Prompts     []PromptDetail   `json:"prompts"`
	Response    *ResponseDetail  `json:"response,omitempty"`
	Languages   []LanguageStat   `json:"languages"`
	Spans       []LLMSpan        `json:"spans"`
	Evaluations []LLMEvaluation  `json:"evaluations"`
	Feedback    []LLMFeedback    `json:"feedback"`
	Tools       []ToolInvocation `json:"tools"`
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
	RequestID    string  `json:"request_id"`
	TraceID      string  `json:"trace_id"`
	CreatedAt    string  `json:"created_at"`
	LatencyMS    int64   `json:"latency_ms"`
	FirstChunkMS int64   `json:"first_chunk_ms"`
	StatusCode   int     `json:"status_code"`
	Provider     string  `json:"provider"`
	Model        string  `json:"model"`
	Endpoint     string  `json:"endpoint"`
	TotalTokens  int64   `json:"total_tokens"`
	CostKRW      float64 `json:"cost_krw"`
	Stream       bool    `json:"stream"`
	ToolCount    int     `json:"tool_count"`
	Failover     bool    `json:"failover"`
}

type ScatterFilter struct {
	Since    time.Time
	Endpoint string
	Model    string
	APIKeyID string
	Limit    int
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
