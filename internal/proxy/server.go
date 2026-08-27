package proxy

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"sync"
	"sync/atomic"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/config"
	"vibe-coders/internal/secret"
	"vibe-coders/internal/store"
)

// AppVersion is the gateway build version, surfaced in /auth/me and the admin UI.
const AppVersion = "v0.79.8"

type Server struct {
	cfg      config.Config
	db       *store.SQLStore
	logger   *store.AsyncLogger
	client   *http.Client
	metrics  *Metrics
	breakers *providerBreakers
	balancer *providerBalancer
	// instanceID identifies this process in shared breaker rows, so an operator can see
	// which instance reported an outage.
	instanceID      string
	secrets         atomic.Pointer[secret.Cipher]
	secretsMu       sync.Mutex // guards concurrent rotation
	retention       *store.RetentionWorker
	killState       atomicKillState
	loggedRequests  sync.Map
	mcpPolicy       atomic.Pointer[mcpPolicySnapshot]
	routingRules    atomic.Pointer[routingRulesSnapshot]
	knowledge       atomic.Pointer[knowledgeSnapshot]
	deprecations    atomic.Pointer[deprecationSnapshot]
	costCache       atomic.Pointer[costSnapshot]
	learnCache      atomic.Pointer[routingLearnSnapshot]
	priceCache      atomic.Pointer[pricingSnapshot]
	mmCache         atomic.Pointer[mattermostSnapshot]
	t2sExec         atomic.Pointer[sql.DB]                  // lazily-opened read-only DB for Text2SQL execute mode (default / env)
	t2sExecConns    sync.Map                                // named exec connections: connID → *sql.DB
	t2sTwin         atomic.Pointer[sql.DB]                  // lazily-opened SQL Digital Twin DB (masked/sample) for safe validation
	t2sKilled       atomic.Bool                             // runtime kill switch: when set, Text2SQL is disabled regardless of config
	t2sFeatures     atomic.Pointer[map[string]bool]         // runtime Text2SQL feature toggles (admin-managed)
	t2sRuntime      atomic.Pointer[config.Text2SQLConfig]   // admin-settings overlay over cfg.Text2SQL (runtime snapshot)
	chRuntime       atomic.Pointer[config.ClickHouseConfig] // admin-settings overlay over cfg.ClickHouse (runtime snapshot)
	chSinkMu        sync.Mutex                              // guards the managed ClickHouse sink worker lifecycle
	chSinkStop      context.CancelFunc                      // cancels the running sink worker (nil when stopped)
	chSinkStarted   bool                                    // true once the startup worker apply has run (gates reload-time restarts)
	carbonRuntime   atomic.Pointer[config.CarbonConfig]     // admin-settings overlay over cfg.Carbon
	insRuntime      atomic.Pointer[config.InsuranceConfig]  // admin-settings overlay over cfg.Insurance
	cacheRuntime    atomic.Pointer[config.CacheConfig]      // admin-settings overlay over cfg.Cache
	pricingRuntime  atomic.Pointer[config.PricingConfig]    // admin-settings overlay over cfg.PricingConf
	skillsRuntime   atomic.Pointer[config.SkillsConfig]     // admin-settings overlay over cfg.Skills
	limitsRuntime   atomic.Pointer[config.LimitsConfig]     // admin-settings overlay over cfg.Limits
	loggingRuntime  atomic.Pointer[config.LoggingConfig]    // admin-settings overlay over cfg.Logging
	mcpRuntime      atomic.Pointer[config.MCPConfig]        // admin-settings overlay over cfg.MCP
	upstreamRuntime atomic.Pointer[config.UpstreamConfig]   // admin-settings overlay over cfg.Upstream (operational knobs only)
	quotaRuntime    atomic.Pointer[config.QuotaConfig]      // admin-settings overlay over cfg.Quota
	keycloakCfg     atomic.Pointer[config.KeycloakConfig]   // DB-backed Keycloak provider overlay over cfg.Keycloak (secret decrypted)
	chFactQueue     chan store.LogRecord                    // async per-request fact ingest queue (bounded)
	chFactDropped   atomic.Int64                            // requests dropped when the fact queue was full
	dwCache         *dwQueryCache                           // short-TTL cache for DW dashboard ClickHouse reads
	sessions        *sessionInferer
	sessionGCAt     atomic.Int64
	extSeen         sync.Map // external key id -> struct{}; dedupes lazy registration
	mcpConns        sync.Map // upstream id -> *mcpUpstreamConn (MCP gateway session state)
	mcpTools        atomic.Pointer[mcpToolsSnapshot]
	mcpRefresh      atomic.Bool
	lastReloadNano  atomic.Int64           // unix nanos of this pod's last runtime-config reload (convergence observability)
	lastReloadTok   atomic.Pointer[string] // admin_settings change token this pod last applied
}

type atomicKillState struct {
	value atomic.Pointer[killSnapshot]
}

type killSnapshot struct {
	disabled  bool
	reason    string
	updatedBy string
	updatedAt time.Time
	fetchedAt time.Time
}

func NewServer(cfg config.Config, db *store.SQLStore, logger *store.AsyncLogger, retention *store.RetentionWorker) (*Server, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = false
	// Client.Timeout covers the whole exchange including a long stream body, so it
	// cannot be lowered to make failover snappy. ResponseHeaderTimeout bounds only
	// the wait for response headers, which is exactly the phase where a dead
	// provider stalls a request.
	if cfg.Upstream.ResponseHeaderTimeout > 0 {
		transport.ResponseHeaderTimeout = cfg.Upstream.ResponseHeaderTimeout
	}
	secrets, err := secret.New(cfg.Secret.GatewaySecret)
	if err != nil {
		return nil, fmt.Errorf("create secret cipher: %w", err)
	}
	server := &Server{
		cfg:    cfg,
		db:     db,
		logger: logger,
		client: &http.Client{
			Timeout:   cfg.Upstream.Timeout,
			Transport: transport,
		},
		metrics:    newMetrics(),
		breakers:   newProviderBreakers(),
		balancer:   newProviderBalancer(),
		instanceID: instanceIdentity(),
		retention:  retention,
		sessions:   newSessionInferer(cfg.Session.IdleTimeout),
		dwCache:    newDWQueryCache(0),
	}
	server.secrets.Store(secrets)

	// Build the runtime config snapshot (env defaults overlaid with admin settings)
	// before starting workers, so workers and handlers see admin-managed values.
	server.reloadRuntimeConfig(context.Background())

	// Background ClickHouse auto-sink, managed so it can be (re)started/stopped when
	// settings change (only runs when URL + interval are configured).
	server.applyClickHouseSinkWorker()
	server.startBreakerSync()
	server.startQuotaReservationSweeper()

	// Async per-request fact ingest queue + batch worker (ships ai_request_fact rows off
	// the hot path). The queue is always allocated; the worker no-ops until configured.
	qsize := cfg.ClickHouse.MaxQueueSize
	if qsize <= 0 {
		qsize = 10000
	}
	server.chFactQueue = make(chan store.LogRecord, qsize)
	go server.clickhouseFactLoop(db.LifecycleContext())

	// Pre-apply current model prices when the pricing table is empty (first boot).
	server.seedPricingIfEmpty(context.Background())

	// Load admin-managed Text2SQL feature toggles into the in-memory cache.
	server.reloadText2SQLFeatures(context.Background())

	// Load the DB-backed Keycloak provider overlay (decrypts the stored client secret),
	// falling back to environment config when no row exists.
	server.reloadKeycloakConfig(context.Background())

	// Multi-pod convergence: poll the admin_settings change token so a settings change made on any
	// pod (or via direct DB edit) is applied on every pod within one interval, without a restart.
	go server.runtimeReloadLoop(db.LifecycleContext(), cfg.RuntimeReloadInterval)

	// Background scheduler for due saved Text2SQL reports (self-disables without an
	// execute DB).
	go server.text2sqlReportScheduler(db.LifecycleContext())
	go server.redTeamScheduler(db.LifecycleContext())

	if cfg.Upstream.APIKey != "" {
		encrypted, err := secrets.Encrypt(cfg.Upstream.APIKey)
		if err != nil {
			return nil, fmt.Errorf("encrypt default provider key: %w", err)
		}
		// The environment bootstraps connection details on every start, while model
		// patterns may be managed later from the admin UI. Preserve the stored value
		// unless UPSTREAM_MODEL_PATTERNS explicitly supplies an override.
		modelPatterns := strings.TrimSpace(cfg.Upstream.ModelPatterns)
		if modelPatterns == "" {
			if existing, found, getErr := db.GetProvider(context.Background(), cfg.Upstream.Provider); getErr != nil {
				return nil, fmt.Errorf("read default provider: %w", getErr)
			} else if found {
				modelPatterns = existing.ModelPatterns
			}
		}
		if err := db.UpsertProvider(context.Background(), store.ProviderConfig{
			Name:            cfg.Upstream.Provider,
			BaseURL:         cfg.Upstream.BaseURL,
			EncryptedAPIKey: encrypted,
			TimeoutMS:       int(cfg.Upstream.Timeout / time.Millisecond),
			Enabled:         true,
			ModelPatterns:   modelPatterns,
		}); err != nil {
			return nil, fmt.Errorf("upsert default provider: %w", err)
		}
	}

	for _, key := range cfg.Auth.ProxyAPIKeys {
		err := db.UpsertAPIKey(context.Background(), store.APIKeyRecord{
			ID:      key.ID,
			Name:    key.Name,
			KeyHash: key.KeyHash,
			Owner:   key.Owner,
			Team:    key.Team,
			Status:  "active",
			Scopes:  defaultAPIKeyScopes("", false),
		})
		if err != nil {
			return nil, fmt.Errorf("upsert proxy api key %s: %w", key.Name, err)
		}
	}
	if err := server.bootstrapAdmin(context.Background()); err != nil {
		return nil, fmt.Errorf("bootstrap admin: %w", err)
	}

	return server, nil
}

func (s *Server) MetricsHandle() *Metrics { return s.metrics }

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/favicon.ico", s.handleFavicon)
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/ready", s.handleReady)
	mux.HandleFunc("/metrics", s.handleMetrics)
	mux.HandleFunc("/openapi.json", s.handleOpenAPISpec)
	mux.HandleFunc("/swagger", s.handleSwaggerUI)
	mux.HandleFunc("/auth/login", s.handleAuthLogin)
	mux.HandleFunc("/auth/logout", s.handleAuthLogout)
	mux.HandleFunc("/auth/refresh", s.handleAuthRefresh)
	mux.HandleFunc("/auth/me", s.handleAuthMe)
	mux.HandleFunc("/auth/sso/status", s.handleSSOStatus)
	mux.HandleFunc("/auth/keycloak/login", s.handleKeycloakLogin)
	mux.HandleFunc("/auth/keycloak/callback", s.handleKeycloakCallback)
	mux.HandleFunc("/auth/keycloak/logout", s.handleKeycloakLogout)
	mux.HandleFunc("/auth/keycloak/backchannel-logout", s.handleKeycloakBackchannelLogout)
	mux.HandleFunc("/auth/keycloak/frontchannel-logout", s.handleKeycloakFrontchannelLogout)
	mux.HandleFunc("/admin/sso/keycloak/config", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut || r.Method == http.MethodPost {
			s.handleKeycloakConfigSave(w, r)
			return
		}
		s.handleKeycloakConfig(w, r)
	})
	mux.HandleFunc("/admin/sso/keycloak/test", s.handleKeycloakTest)
	mux.HandleFunc("/admin", s.handleAdminUI)
	mux.HandleFunc("/admin/", s.handleAdminUI)
	mux.HandleFunc("/admin/stats", s.handleStats)
	mux.HandleFunc("/admin/requests", s.handleRequests)
	mux.HandleFunc("/admin/api-keys", s.handleAPIKeys)
	mux.HandleFunc("/admin/api-keys/", s.handleAPIKeyByID)
	mux.HandleFunc("/admin/providers", s.handleProviders)
	mux.HandleFunc("/admin/providers/", s.handleProviderByName)
	mux.HandleFunc("/admin/chat-test/targets", s.handleChatTestTargets)
	mux.HandleFunc("/admin/chat-test/run", s.handleChatTestRun)
	mux.HandleFunc("/admin/chat-test/multi-run", s.handleChatTestMultiRun)
	mux.HandleFunc("/admin/chat-test/multi-run/predict", s.handleChatTestMultiRunPredict)
	mux.HandleFunc("/admin/chat-test/multi-run/judge", s.handleMultiRunJudge)
	mux.HandleFunc("/admin/chat-test/multi-run/leaderboard", s.handleMultiModelLeaderboard)
	mux.HandleFunc("/admin/chat-test/multi-run/runs", s.handleChatTestMultiRuns)
	mux.HandleFunc("/admin/chat-test/multi-run/runs/", s.handleChatTestMultiRunByID)
	mux.HandleFunc("/admin/prompt-lab/experiments", s.handlePromptLabExperiments)
	mux.HandleFunc("/admin/prompt-lab/experiments/", s.handlePromptLabExperimentByID)
	mux.HandleFunc("/admin/prompt-lab/rubrics", s.handlePromptLabRubrics)
	mux.HandleFunc("/admin/prompt-lab/contracts", s.handlePromptLabContracts)
	mux.HandleFunc("/admin/prompt-lab/test-cases", s.handlePromptLabTestCases)
	mux.HandleFunc("/admin/prompt-lab/test-cases/", s.handlePromptLabTestCaseByID)
	mux.HandleFunc("/admin/chat-test/stream", s.handleChatTestStream)
	mux.HandleFunc("/admin/audit-logs", s.handleAuditLogs)
	mux.HandleFunc("/admin/audit/auth-events", s.handleAuthAuditEvents)
	mux.HandleFunc("/admin/audit/anomalies", s.handleAuditAnomalies)
	mux.HandleFunc("/admin/users", s.handleUsers)
	mux.HandleFunc("/admin/users/", s.handleUserDetail)
	mux.HandleFunc("/admin/teams", s.handleTeams)
	mux.HandleFunc("/admin/teams/", s.handleTeamDetail)
	mux.HandleFunc("/admin/ips", s.handleIPs)
	mux.HandleFunc("/admin/ips/", s.handleIPDetail)
	mux.HandleFunc("/admin/requests/", s.handleRequestDetail)
	mux.HandleFunc("/admin/traces/", s.handleTraceByID)
	mux.HandleFunc("/admin/code-verify", s.handleCodeVerify)
	mux.HandleFunc("/admin/code-verify/stats", s.handleCodeVerifyStats)
	mux.HandleFunc("/admin/sbom", s.handleSBOM)
	mux.HandleFunc("/admin/journey-probe", s.handleJourneyProbe)
	mux.HandleFunc("/admin/pods", s.handlePods)
	mux.HandleFunc("/admin/privacy-ledger", s.handlePrivacyLedger)
	mux.HandleFunc("/admin/productivity", s.handleProductivity)
	mux.HandleFunc("/admin/apps/onboarding-check", s.handleAppOnboardingCheck)
	mux.HandleFunc("/admin/mcp/onboarding-check", s.handleMCPOnboardingCheck)
	mux.HandleFunc("/admin/sessions", s.handleSessionList)
	mux.HandleFunc("/admin/sessions/", s.handleSessionFlightRecorder)
	mux.HandleFunc("/admin/prompts", s.handlePromptSearch)
	mux.HandleFunc("/admin/quotas", s.handleQuotas)
	mux.HandleFunc("/admin/quotas/", s.handleQuotaByID)
	mux.HandleFunc("/admin/retention", s.handleRetention)
	mux.HandleFunc("/admin/system-errors", s.handleSystemErrors)
	mux.HandleFunc("/admin/system-errors/clear", s.handleSystemErrors)
	mux.HandleFunc("/admin/dw/rollups", s.handleDWRollups)
	mux.HandleFunc("/admin/okf/documents", s.handleOKFDocuments)
	mux.HandleFunc("/admin/okf/documents/by-id/", s.handleOKFDocumentByID)
	mux.HandleFunc("/admin/okf/links", s.handleOKFLinks)
	mux.HandleFunc("/admin/okf/export", s.handleOKFExport)
	mux.HandleFunc("/admin/okf/import", s.handleOKFImport)
	mux.HandleFunc("/admin/okf/text2sql/sync", s.handleOKFText2SQLSync)
	mux.HandleFunc("/admin/okf/graph/sync", s.handleOKFGraphSync)
	mux.HandleFunc("/admin/okf/propose", s.handleOKFPropose)
	mux.HandleFunc("/admin/skills", s.handleSkills)
	mux.HandleFunc("/admin/skills/by-name/", s.handleSkillByName)
	mux.HandleFunc("/admin/skills/runs", s.handleSkillRuns)
	mux.HandleFunc("/admin/skills/stats", s.handleSkillStats)
	mux.HandleFunc("/admin/skills/promote", s.handleSkillPromote)
	mux.HandleFunc("/admin/skills/fitness", s.handleSkillFitness)
	mux.HandleFunc("/admin/skills/adoption", s.handleAdminSkillAdoption)
	mux.HandleFunc("/admin/skills/dependency-graph", s.handleSkillDependencyGraph)
	mux.HandleFunc("/me/skills", s.handleMeSkills)
	mux.HandleFunc("/me/skills/", s.handleMeSkillAction)
	mux.HandleFunc("/admin/data-products", s.handleAdminDataProducts)
	mux.HandleFunc("/admin/data-products/candidates", s.handleAdminDataProductCandidates)
	mux.HandleFunc("/admin/data-products/requests", s.handleAdminDataProductRequests)
	mux.HandleFunc("/me/data-products", s.handleMeDataProducts)
	mux.HandleFunc("/me/data-products/", s.handleMeDataProductAccess)
	mux.HandleFunc("/me/onboarding-pack", s.handleMyOnboardingPack)
	mux.HandleFunc("/me/connection-doctor", s.handleConnectionDoctor)
	mux.HandleFunc("/me/app-runs", s.handleMyAppRuns)
	mux.HandleFunc("/v1/app-runs/", s.handleAppRunReceipt)
	mux.HandleFunc("/v1/workflow-runs/", s.handleWorkflowRunReceipt)
	mux.HandleFunc("/me/requests", s.handleMyRecentRequests)
	mux.HandleFunc("/me/requests/", s.handleMyRequestReceipt)
	mux.HandleFunc("/admin/workflows", s.handleAdminWorkflows)
	mux.HandleFunc("/admin/workflows/", s.handleAdminWorkflowDryRun)
	mux.HandleFunc("/v1/workflows/", s.handleV1WorkflowRun)
	mux.HandleFunc("/me/workflow-runs", s.handleMyWorkflowRuns)
	mux.HandleFunc("/admin/app-templates", s.handleAppTemplates)
	mux.HandleFunc("/admin/app-templates/instantiate", s.handleAppTemplateInstantiate)
	mux.HandleFunc("/admin/apps", s.handleAdminApps)
	mux.HandleFunc("/admin/apps/", s.handleAdminAppByID)
	mux.HandleFunc("/v1/apps", s.handleUserApps)
	mux.HandleFunc("/v1/apps/", s.handleUserAppByID)
	mux.HandleFunc("/admin/change-sets", s.handleAdminChangeSets)
	mux.HandleFunc("/admin/change-sets/", s.handleAdminChangeSetByID)
	mux.HandleFunc("/admin/change-impact/simulate", s.handleChangeImpactSimulate)
	mux.HandleFunc("/admin/capabilities", s.handleCapabilities)
	mux.HandleFunc("/admin/capabilities/", s.handleCapabilityByKey)
	mux.HandleFunc("/admin/incidents/candidates", s.handleIncidentCandidates)
	mux.HandleFunc("/admin/teams/scorecard", s.handleTeamScorecard)
	mux.HandleFunc("/admin/reports/narrative", s.handleNarrativeReport)
	mux.HandleFunc("/admin/cost/chargeback-pack", s.handleChargebackPack)
	mux.HandleFunc("/admin/models/contracts", s.handleModelContracts)
	mux.HandleFunc("/admin/models/contracts/run", s.handleModelContractsRun)
	mux.HandleFunc("/admin/sandbox/preview", s.handleSandboxPreview)
	mux.HandleFunc("/admin/remediation/playbooks", s.handleRemediationPlaybooks)
	mux.HandleFunc("/admin/remediation/apply", s.handleRemediationApply)
	mux.HandleFunc("/admin/redteam/dashboard", s.handleRedTeamDashboard)
	mux.HandleFunc("/admin/redteam/kill-switch", s.handleRedTeamKillSwitch)
	mux.HandleFunc("/admin/agent-routes", s.handleAgentRoutes)
	mux.HandleFunc("/admin/agent-routes/", s.handleAgentRouteByID)
	mux.HandleFunc("/admin/redteam/targets", s.handleRedTeamTargets)
	mux.HandleFunc("/admin/redteam/targets/", s.handleRedTeamTargetByID)
	mux.HandleFunc("/admin/redteam/probe-packs", s.handleRedTeamProbePacks)
	mux.HandleFunc("/admin/redteam/probe-packs/", s.handleRedTeamProbePacksSub)
	mux.HandleFunc("/admin/redteam/probe-cases", s.handleRedTeamProbeCases)
	mux.HandleFunc("/admin/redteam/probe-cases/", s.handleRedTeamProbeCases)
	mux.HandleFunc("/admin/redteam/campaigns", s.handleRedTeamCampaigns)
	mux.HandleFunc("/admin/redteam/campaigns/", s.handleRedTeamCampaignByID)
	mux.HandleFunc("/admin/redteam/runs", s.handleRedTeamRuns)
	mux.HandleFunc("/admin/redteam/runs/", s.handleRedTeamRunByID)
	mux.HandleFunc("/admin/redteam/results/", s.handleRedTeamResultByID)
	mux.HandleFunc("/admin/redteam/remediations", s.handleRedTeamRemediations)
	mux.HandleFunc("/admin/redteam/remediations/", s.handleRedTeamRemediationByID)
	mux.HandleFunc("/admin/redteam/schedules", s.handleRedTeamSchedules)
	mux.HandleFunc("/admin/redteam/baselines", s.handleRedTeamBaselines)
	mux.HandleFunc("/admin/redteam/export", s.handleRedTeamExport)
	mux.HandleFunc("/admin/ops/home", s.handleOpsHome)
	mux.HandleFunc("/admin/ops/workers", s.handleOpsWorkers)
	mux.HandleFunc("/admin/index-health", s.handleIndexHealth)
	mux.HandleFunc("/admin/migration-sql", s.handleMigrationSQL)
	mux.HandleFunc("/admin/ops/preflight", s.handleOpsPreflight)
	mux.HandleFunc("/admin/flow-map", s.handleFlowMap)
	mux.HandleFunc("/admin/mcp/agentic-runs", s.handleMCPAgenticRuns)
	mux.HandleFunc("/admin/mcp/trust-scores", s.handleMCPTrustScores)
	mux.HandleFunc("/admin/dw/metrics", s.handleAdminMetrics)
	mux.HandleFunc("/admin/dw/metrics/", s.handleAdminMetricByID)
	mux.HandleFunc("/admin/model-tags", s.handleAdminModelTags)
	mux.HandleFunc("/admin/model-tags/", s.handleAdminModelTagByID)
	mux.HandleFunc("/v1/model-tags", s.handleModelTags)
	mux.HandleFunc("/admin/skills/promotions", s.handleSkillPromotions)
	mux.HandleFunc("/admin/skills/scan", s.handleSkillScan)
	mux.HandleFunc("/admin/skills/recommend", s.handleSkillRecommend)
	mux.HandleFunc("/admin/skills/export", s.handleSkillExport)
	mux.HandleFunc("/admin/skills/import", s.handleSkillImport)
	mux.HandleFunc("/admin/skills/evaluate", s.handleSkillEvaluate)
	mux.HandleFunc("/admin/skills/seed-recommended", s.handleSkillSeedRecommended)
	mux.HandleFunc("/admin/skill-studio/candidates", s.handleSkillStudioCandidates)
	mux.HandleFunc("/admin/skill-studio/adopt", s.handleSkillStudioAdopt)
	mux.HandleFunc("/admin/skill-studio/readiness", s.handleSkillStudioReadiness)
	mux.HandleFunc("/admin/dw/dashboard/overview", s.handleDWDashboardOverview)
	mux.HandleFunc("/admin/dw/dashboard/timeseries", s.handleDWDashboardTimeseries)
	mux.HandleFunc("/admin/dw/dashboard/dimensions", s.handleDWDashboardDimensions)
	mux.HandleFunc("/admin/dw/dashboard/text2sql", s.handleDWDashboardText2SQL)
	mux.HandleFunc("/admin/dw/dashboard/routing", s.handleDWDashboardRouting)
	mux.HandleFunc("/admin/dw/dashboard/latency", s.handleDWDashboardLatency)
	mux.HandleFunc("/admin/dw/dashboard/quality", s.handleDWDashboardQuality)
	mux.HandleFunc("/admin/dw/dashboard/refresh", s.handleDWDashboardRefresh)
	mux.HandleFunc("/admin/dw/dashboard/export.csv", s.handleDWDashboardExportCSV)
	mux.HandleFunc("/admin/dw/clickhouse", s.handleClickHouseSink)
	mux.HandleFunc("/admin/dw/clickhouse/bootstrap", s.handleClickHouseBootstrap)
	mux.HandleFunc("/admin/dw/clickhouse/overview", s.handleClickHouseOverview)
	mux.HandleFunc("/admin/dw/clickhouse/fact-retry", s.handleClickHouseFactRetry)
	mux.HandleFunc("/admin/dw/clickhouse/lag", s.handleClickHouseLag)
	mux.HandleFunc("/admin/dw/clickhouse/events", s.handleClickHouseEvents)
	mux.HandleFunc("/admin/dw/consistency", s.handleClickHouseConsistency)
	mux.HandleFunc("/admin/dw/sink-status", s.handleClickHouseSinkStatus)
	mux.HandleFunc("/admin/dw/sink-retry", s.handleClickHouseSinkRetry)
	mux.HandleFunc("/admin/dw/table-info", s.handleClickHouseTableInfo)
	mux.HandleFunc("/admin/dw/text2sql-fact", s.handleClickHouseText2SQLFact)
	mux.HandleFunc("/admin/dw/redteam", s.handleClickHouseRedTeamFact)
	mux.HandleFunc("/admin/text2sql", s.handleText2SQLAdmin)
	mux.HandleFunc("/admin/text2sql/spans", s.handleText2SQLSpans)
	mux.HandleFunc("/admin/text2sql/schemas", s.handleText2SQLSchemas)
	mux.HandleFunc("/admin/text2sql/profiles", s.handleText2SQLProfiles)
	mux.HandleFunc("/admin/text2sql/tables", s.handleText2SQLTables)
	mux.HandleFunc("/admin/text2sql/columns", s.handleText2SQLColumns)
	mux.HandleFunc("/admin/text2sql/connections", s.handleText2SQLConnections)
	mux.HandleFunc("/admin/text2sql/collect", s.handleText2SQLCollect)
	mux.HandleFunc("/admin/text2sql/registry/export", s.handleText2SQLRegistryExport)
	mux.HandleFunc("/admin/text2sql/registry/import", s.handleText2SQLRegistryImport)
	mux.HandleFunc("/admin/text2sql/permissions", s.handleText2SQLPermissions)
	mux.HandleFunc("/admin/text2sql/glossary", s.handleText2SQLGlossary)
	mux.HandleFunc("/admin/text2sql/risk-queue", s.handleText2SQLRiskQueue)
	mux.HandleFunc("/admin/text2sql/healthcheck", s.handleText2SQLHealthcheck)
	mux.HandleFunc("/admin/text2sql/schema-impact", s.handleText2SQLSchemaImpact)
	mux.HandleFunc("/admin/text2sql/replay", s.handleText2SQLReplay)
	mux.HandleFunc("/admin/text2sql/kill-switch", s.handleText2SQLKillSwitch)
	mux.HandleFunc("/admin/text2sql/miners", s.handleText2SQLMiners)
	mux.HandleFunc("/admin/text2sql/anomalies", s.handleText2SQLAnomalies)
	mux.HandleFunc("/admin/text2sql/prompt-dna", s.handleText2SQLPromptDNA)
	mux.HandleFunc("/admin/text2sql/promote", s.handleText2SQLPromote)
	mux.HandleFunc("/admin/text2sql/reports", s.handleText2SQLReports)
	mux.HandleFunc("/admin/text2sql/features", s.handleText2SQLFeatures)
	mux.HandleFunc("/admin/text2sql/golden", s.handleText2SQLGolden)
	mux.HandleFunc("/admin/text2sql/golden/", s.handleText2SQLGolden)
	mux.HandleFunc("/admin/export.csv", s.handleExportCSV)
	mux.HandleFunc("/admin/timeseries", s.handleTimeseries)
	mux.HandleFunc("/admin/heatmap", s.handleHeatmap)
	mux.HandleFunc("/admin/anomalies", s.handleAnomalies)
	mux.HandleFunc("/admin/ai-credit-score", s.handleAICreditScore)
	mux.HandleFunc("/admin/carbon-score", s.handleCarbonScore)
	mux.HandleFunc("/admin/work-map", s.handleWorkMap)
	mux.HandleFunc("/admin/insurance/claims", s.handleInsuranceClaims)
	mux.HandleFunc("/admin/insurance/burn-rate", s.handleErrorBudgetBurn)
	mux.HandleFunc("/admin/savings", s.handleSavings)
	mux.HandleFunc("/admin/model-migration", s.handleModelMigration)
	mux.HandleFunc("/admin/invoices", s.handleInvoices)
	mux.HandleFunc("/admin/personalization/coaching", s.handlePersonalizationCoaching)
	mux.HandleFunc("/admin/personalization/model-affinity", s.handlePersonalizationModelAffinity)
	mux.HandleFunc("/admin/personalization/mcp-affinity", s.handlePersonalizationMCPAffinity)
	mux.HandleFunc("/admin/personalization/text2sql-hints", s.handlePersonalizationText2SQLHints)
	mux.HandleFunc("/admin/personalization/profiles", s.handlePersonalProfiles)
	mux.HandleFunc("/admin/personalization/profiles/", s.handlePersonalProfileDetail)
	mux.HandleFunc("/me/navigation", s.handleMeNavigation)
	mux.HandleFunc("/me/access-denied", s.handleMeAccessDenied)
	mux.HandleFunc("/me/actions", s.handleMeActions)
	mux.HandleFunc("/me/actions/snooze", s.handleMeActionSnooze)
	mux.HandleFunc("/me/notifications", s.handleMeNotifications)
	mux.HandleFunc("/me/recommended-models", s.handleMeRecommendedModels)
	mux.HandleFunc("/me/overlay", s.handleMeOverlay)
	mux.HandleFunc("/me/sessions", s.handleMeSessions)
	mux.HandleFunc("/me/sessions/revoke-others", s.handleMeSessionsRevokeOthers)
	mux.HandleFunc("/me/sessions/", s.handleMeSessionByID)
	mux.HandleFunc("/me/report", s.handleMeReport)
	mux.HandleFunc("/team/portal", s.handleTeamPortal)
	mux.HandleFunc("/team/dashboard", s.handleTeamDashboard)
	mux.HandleFunc("/team/skills/popular", s.handleTeamPopularSkills)
	mux.HandleFunc("/team/templates/candidates", s.handleTeamTemplateCandidates)
	mux.HandleFunc("/team/risk", s.handleTeamRisk)
	mux.HandleFunc("/team/onboarding", s.handleTeamOnboarding)
	mux.HandleFunc("/team/savings-challenge", s.handleTeamSavingsChallenge)
	mux.HandleFunc("/team/reports", s.handleTeamReports)
	mux.HandleFunc("/me/reports/submit-to-team", s.handleSubmitReportToTeam)
	mux.HandleFunc("/security/dashboard", s.handleSecurityDashboard)
	mux.HandleFunc("/billing/dashboard", s.handleBillingDashboard)
	mux.HandleFunc("/admin/roles", s.handleAdminRoles)
	mux.HandleFunc("/permissions/effective", s.handlePermissionsEffective)
	mux.HandleFunc("/me/dashboard", s.handleMyDashboard)
	mux.HandleFunc("/me/recommendations", s.handleMyRecommendations)
	mux.HandleFunc("/me/recommendations/feedback", s.handleMyRecommendationFeedback)
	mux.HandleFunc("/me/recommendations/", s.handleMyRecommendationFeedbackByPath)
	mux.HandleFunc("/me/keys", s.handleMyKeys)
	mux.HandleFunc("/me/keys/", s.handleMyKeyByID)
	mux.HandleFunc("/admin/keys/health", s.handleKeyHealth)
	mux.HandleFunc("/admin/recommendations/adoption", s.handleRecommendationAdoption)
	mux.HandleFunc("/admin/secrets/rotate", s.handleSecretsRotate)
	mux.HandleFunc("/admin/settings/effective", s.handleAdminSettingsEffective)
	mux.HandleFunc("/admin/settings", s.handleAdminSettings)
	mux.HandleFunc("/admin/settings/", s.handleAdminSettings)
	mux.HandleFunc("/admin/settings/by-key/", s.handleAdminSettingByKey)
	mux.HandleFunc("/admin/settings/validate", s.handleAdminSettingsValidate)
	mux.HandleFunc("/admin/settings/history", s.handleAdminSettingsHistory)
	mux.HandleFunc("/admin/settings/rollback", s.handleAdminSettingsRollback)
	mux.HandleFunc("/admin/settings/bulk", s.handleAdminSettingsBulk)
	mux.HandleFunc("/admin/settings/export", s.handleAdminSettingsExport)
	mux.HandleFunc("/admin/settings/import", s.handleAdminSettingsImport)
	mux.HandleFunc("/admin/settings/test/clickhouse", s.handleSettingsTestClickHouse)
	mux.HandleFunc("/admin/settings/test/text2sql-exec", s.handleSettingsTestText2SQLExec)
	mux.HandleFunc("/admin/settings/test/text2sql-twin", s.handleSettingsTestText2SQLTwin)
	mux.HandleFunc("/admin/policies/decisions", s.handlePolicyDecisions)
	mux.HandleFunc("/admin/policies/simulate", s.handlePolicySimulate)
	mux.HandleFunc("/admin/policies/canary-status", s.handleCanaryStatus)
	mux.HandleFunc("/admin/policy-advisor/suggestions", s.handlePolicyAdvisorSuggestions)
	mux.HandleFunc("/admin/policy-advisor/apply", s.handlePolicyAdvisorApply)
	mux.HandleFunc("/admin/policies/regression/cases", s.handlePolicyRegressionCases)
	mux.HandleFunc("/admin/policies/regression/run", s.handlePolicyRegressionRun)
	mux.HandleFunc("/admin/policies/export", s.handlePolicyExport)
	mux.HandleFunc("/admin/policies/import", s.handlePolicyImport)
	mux.HandleFunc("/admin/policies", s.handlePolicies)
	mux.HandleFunc("/admin/approvals", s.handleApprovals)
	mux.HandleFunc("/admin/approvals/", s.handleApprovalDecision)
	mux.HandleFunc("/admin/security/secrets", s.handleSecretEvents)
	mux.HandleFunc("/admin/replay", s.handleReplay)
	mux.HandleFunc("/admin/golden-prompts", s.handleGoldenPrompts)
	mux.HandleFunc("/admin/golden-prompts/run", s.handleGoldenRun)
	mux.HandleFunc("/admin/golden-workflows", s.handleGoldenWorkflows)
	mux.HandleFunc("/admin/golden-workflows/run", s.handleGoldenWorkflowRun)
	mux.HandleFunc("/admin/prompt-products", s.handlePromptProducts)
	mux.HandleFunc("/admin/prompt-products/candidates", s.handlePromptProductCandidates)
	mux.HandleFunc("/admin/contexts", s.handleContexts)
	mux.HandleFunc("/admin/scatter", s.handleScatter)
	mux.HandleFunc("/admin/xview/delta", s.handleXViewDelta)
	mux.HandleFunc("/admin/xview/models", s.handleXViewModels)
	mux.HandleFunc("/admin/xview/model-series", s.handleXViewModelSeries)
	mux.HandleFunc("/admin/xview/model-outliers", s.handleXViewModelOutliers)
	mux.HandleFunc("/admin/routing-rules", s.handleRoutingRules)
	mux.HandleFunc("/admin/routing-rules/", s.handleRoutingRuleByID)
	mux.HandleFunc("/admin/budgets", s.handleBudgets)
	mux.HandleFunc("/admin/budgets/", s.handleBudgetByID)
	mux.HandleFunc("/admin/model-deprecations", s.handleModelDeprecations)
	mux.HandleFunc("/admin/model-deprecations/", s.handleModelDeprecationByID)
	mux.HandleFunc("/admin/waterfall", s.handleWaterfall)
	mux.HandleFunc("/admin/routing/learning", s.handleRoutingLearning)
	mux.HandleFunc("/admin/routing/learning/auto", s.handleRoutingLearningAuto)
	mux.HandleFunc("/admin/routing/domain-decisions", s.handleDomainRoutingDecisions)
	mux.HandleFunc("/admin/routing/domain-examples", s.handleDomainExamples)
	mux.HandleFunc("/admin/routing/domain-review", s.handleDomainReviewQueue)
	mux.HandleFunc("/admin/routing/domain-review/", s.handleDomainReviewAction)
	mux.HandleFunc("/admin/routing/pattern-conflicts", s.handleProviderPatternConflicts)
	mux.HandleFunc("/admin/routing/preview", s.handleRoutingPreview)
	mux.HandleFunc("/admin/routing/decisions", s.handleRoutingDecisions)
	mux.HandleFunc("/admin/routing/decisions/", s.handleRoutingDecisionByID)
	mux.HandleFunc("/admin/routing/health", s.handleRoutingHealth)
	mux.HandleFunc("/admin/routing/breaker-reset", s.handleRoutingBreakerReset)
	mux.HandleFunc("/admin/routing/balancer", s.handleRoutingBalancer)
	mux.HandleFunc("/admin/routing/failover-drill", s.handleRoutingFailoverDrill)
	mux.HandleFunc("/admin/providers/slo", s.handleProviderSLOs)
	mux.HandleFunc("/admin/agents", s.handleAgents)
	mux.HandleFunc("/admin/models/quality", s.handleModelQuality)
	mux.HandleFunc("/admin/cost", s.handleCostGuard)
	mux.HandleFunc("/admin/cost/predict", s.handleCostPredict)
	mux.HandleFunc("/admin/cost/allocation", s.handleCostAllocation)
	mux.HandleFunc("/admin/cost/anomalies", s.handleCostAnomalies)
	mux.HandleFunc("/admin/pricing", s.handlePricing)
	mux.HandleFunc("/admin/pricing/seed", s.handlePricingSeed)
	mux.HandleFunc("/admin/benchmark/teams", s.handleTeamBenchmark)
	mux.HandleFunc("/admin/benchmark/users", s.handleUserProductivity)
	mux.HandleFunc("/admin/incidents", s.handleIncidents)
	mux.HandleFunc("/admin/prompts/fingerprints", s.handlePromptFingerprints)
	mux.HandleFunc("/admin/prompts/debt", s.handlePromptDebt)
	mux.HandleFunc("/admin/prompts/promotions", s.handlePromptPromotions)
	mux.HandleFunc("/admin/knowledge", s.handleKnowledge)
	mux.HandleFunc("/admin/knowledge/", s.handleKnowledgeByID)
	mux.HandleFunc("/admin/templates", s.handleTemplates)
	mux.HandleFunc("/admin/templates/", s.handleTemplateByID)
	mux.HandleFunc("/admin/prompt-assets", s.handlePromptAssets)
	mux.HandleFunc("/admin/mcp/upstreams", s.handleMCPUpstreams)
	mux.HandleFunc("/admin/mcp/upstreams/", s.handleMCPUpstreamByID)
	mux.HandleFunc("/mcp", s.handleMCPGateway)
	mux.HandleFunc("/mcp/gateway", s.handleGatewayMCP)
	mux.HandleFunc("/admin/gateway-mcp/info", s.handleGatewayMCPInfo)
	mux.HandleFunc("/admin/mcp/gateway/test", s.handleGatewayMCPTest)
	mux.HandleFunc("/admin/mcp/contracts", s.handleAdminMCPContracts)
	mux.HandleFunc("/admin/mcp/contracts/validate", s.handleAdminMCPContractsValidate)
	mux.HandleFunc("/vcs/events", s.handleVCSWebhook)
	mux.HandleFunc("/vcs/webhook/", s.handleVCSWebhook)
	mux.HandleFunc("/admin/vcs/events", s.handleVCSEvents)
	mux.HandleFunc("/admin/llm/traces", s.handleLLMTraces)
	mux.HandleFunc("/admin/llm/traces/", s.handleLLMTraceDetail)
	mux.HandleFunc("/admin/llm/sessions", s.handleLLMSessions)
	mux.HandleFunc("/admin/llm/session", s.handleLLMSessionTimeline)
	mux.HandleFunc("/admin/llm/prompts", s.handleLLMPrompts)
	mux.HandleFunc("/admin/llm/prompts/compare", s.handleLLMPromptCompare)
	mux.HandleFunc("/admin/llm/patterns", s.handleLLMPatterns)
	mux.HandleFunc("/admin/llm/insights", s.handleLLMInsights)
	mux.HandleFunc("/admin/llm/timeseries", s.handleLLMTimeseries)
	mux.HandleFunc("/admin/llm/feedback", s.handleLLMFeedback)
	mux.HandleFunc("/admin/llm/evaluations", s.handleLLMEvaluations)
	mux.HandleFunc("/admin/mcp/tools", s.handleMCPTools)
	mux.HandleFunc("/admin/mcp/servers", s.handleMCPServers)
	mux.HandleFunc("/admin/mcp/overview", s.handleMCPOverview)
	mux.HandleFunc("/admin/mcp/routes", s.handleMCPRoutes)
	mux.HandleFunc("/admin/mcp/route/explain", s.handleMCPRouteExplain)
	mux.HandleFunc("/admin/mcp/test", s.handleMCPTest)
	mux.HandleFunc("/admin/mcp/effective-policy", s.handleMCPEffectivePolicy)
	mux.HandleFunc("/admin/mcp/topology", s.handleMCPTopology)
	mux.HandleFunc("/admin/mcp/requests", s.handleMCPRequests)
	mux.HandleFunc("/admin/mcp/requests/", s.handleMCPRequestWaterfall)
	mux.HandleFunc("/admin/mcp/policies", s.handleMCPPolicies)
	mux.HandleFunc("/admin/mcp/policies/", s.handleMCPPolicyByServer)
	mux.HandleFunc("/admin/mcp/loops", s.handleMCPLoops)
	mux.HandleFunc("/admin/mcp/catalog", s.handleMCPCatalog)
	mux.HandleFunc("/admin/kill-switch", s.handleKillSwitch)
	mux.HandleFunc("/admin/notifications/mattermost", s.handleMattermostConfig)
	mux.HandleFunc("/admin/notifications/mattermost/test", s.handleMattermostTest)
	mux.HandleFunc("/admin/alerts", s.handleAlertRules)
	mux.HandleFunc("/admin/alerts/", s.handleAlertRuleByID)
	mux.HandleFunc("/admin/saved-filters", s.handleSavedFilters)
	mux.HandleFunc("/admin/saved-filters/", s.handleSavedFilterByID)
	mux.HandleFunc("/admin/audit-logs.csv", s.handleAuditExportCSV)
	mux.HandleFunc("/admin/fallback", s.handleFallback)
	mux.HandleFunc("/admin/ops/status", s.handleOpsStatus)
	mux.HandleFunc("/admin/ops/risk", s.handleOpsRisk)
	mux.HandleFunc("/admin/requests/diff", s.handleRequestDiff)
	mux.HandleFunc("/admin/suggest", s.handleSuggest)
	mux.HandleFunc("/v1/chat/completions", s.handleOpenAI)
	mux.HandleFunc("/v1/models", s.handleOpenAI)
	mux.HandleFunc("/v1/embeddings", s.handleOpenAI)
	mux.HandleFunc("/v1/", s.handleOpenAI)
	mux.HandleFunc("/v1", s.handleOpenAI)
	mux.HandleFunc("/v1/skills", s.handlePublicSkills)
	mux.HandleFunc("/v1/skills/", s.handlePublicSkills)
	// Keep the bare service URL useful without turning unknown paths into admin routes.
	// The admin UI already owns authentication and the branded login experience.
	mux.HandleFunc("/", s.handleRoot)
	return withTrace(mux)
}

func (s *Server) handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, "/admin", http.StatusFound)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleFavicon(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="vibePurpleCyan" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#D946EF"/><stop offset="50%" stop-color="#8B5CF6"/><stop offset="100%" stop-color="#06B6D4"/></linearGradient><linearGradient id="waveGrad" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#8B5CF6" stop-opacity="0.2"/><stop offset="50%" stop-color="#06B6D4" stop-opacity="1"/><stop offset="100%" stop-color="#3B82F6" stop-opacity="0.2"/></linearGradient><filter id="neonGlow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><polygon points="60,10 105,35 105,85 60,110 15,85 15,35" stroke="url(#vibePurpleCyan)" stroke-width="2" stroke-opacity="0.3" fill="none"/><circle cx="60" cy="10" r="2.5" fill="#D946EF"/><circle cx="105" cy="35" r="2.5" fill="#8B5CF6"/><circle cx="15" cy="35" r="2.5" fill="#8B5CF6"/><circle cx="105" cy="85" r="2.5" fill="#06B6D4"/><circle cx="15" cy="85" r="2.5" fill="#06B6D4"/><circle cx="60" cy="110" r="2.5" fill="#06B6D4"/><path d="M 40,35 L 60,75 L 80,35" stroke="url(#vibePurpleCyan)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none" filter="url(#neonGlow)"/><path d="M 45,35 L 60,65 L 75,35" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.9"/><path d="M 32,45 L 20,55 L 32,65" stroke="#D946EF" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M 88,45 L 100,55 L 88,65" stroke="#06B6D4" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M 10,78 C 30,60 50,90 70,68 C 85,50 100,85 110,68" stroke="url(#waveGrad)" stroke-width="4.5" stroke-linecap="round" fill="none" filter="url(#neonGlow)"/><circle cx="45" cy="73" r="2" fill="#FFFFFF"/><circle cx="75" cy="65" r="2" fill="#FFFFFF"/></svg>`))
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	if err := s.db.Ping(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	_, _ = w.Write([]byte(s.metrics.Prometheus(s.logger.QueueDepth(), s.logger.Dropped(), s.logger.Written())))
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	stats, err := s.db.Summary(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "stats_failed")
		return
	}
	cacheStats, err := s.db.EmbeddingCacheStats(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "stats_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"total_requests":        stats.TotalRequests,
		"total_tokens":          stats.TotalTokens,
		"total_cost_krw":        stats.TotalCostKRW,
		"average_latency_ms":    stats.AverageLatencyMS,
		"by_ip":                 stats.ByIP,
		"by_model":              stats.ByModel,
		"by_language":           stats.ByLanguage,
		"by_status":             stats.ByStatus,
		"top_users":             stats.TopUsers,
		"latency_quantiles":     s.metrics.LatencyQuantiles(),
		"first_chunk_quantiles": s.metrics.FirstChunkQuantiles(),
		"cache":                 cacheStats,
		"failover_total":        s.metrics.failovers.Load(),
		"cache_hits":            s.metrics.cacheHits.Load(),
		"cache_misses":          s.metrics.cacheMisses.Load(),
	})
}

// searchLocation resolves a timezone query parameter to a *time.Location, defaulting to
// Asia/Seoul (KST) — the operational timezone of this gateway. Asia/Seoul and UTC are
// resolved without the OS tzdata; any other IANA name falls back to LoadLocation, and an
// unknown/unloadable zone falls back to Seoul rather than silently using UTC.
func searchLocation(tz string) *time.Location {
	tz = strings.TrimSpace(tz)
	switch {
	case tz == "", strings.EqualFold(tz, "Asia/Seoul"), strings.EqualFold(tz, "KST"):
		return seoulZone
	case strings.EqualFold(tz, "UTC"):
		return time.UTC
	}
	if loc, err := time.LoadLocation(tz); err == nil {
		return loc
	}
	return seoulZone
}

// parseRangeBound parses a from/to filter value. Values carrying an explicit offset
// (RFC3339) are treated as absolute; bare wall-clock values (datetime-local inputs like
// "2006-01-02T15:04", or a plain date) are interpreted in loc. A date-only upper bound
// (endOfDay=true) expands to the last instant of that day so a "to" date is inclusive.
// A zero time (returned for empty/unparseable input) disables the bound.
func parseRangeBound(value string, loc *time.Location, endOfDay bool) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, value); err == nil {
			return t
		}
	}
	for _, layout := range []string{"2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02 15:04"} {
		if t, err := time.ParseInLocation(layout, value, loc); err == nil {
			return t
		}
	}
	if t, err := time.ParseInLocation("2006-01-02", value, loc); err == nil {
		if endOfDay {
			return t.AddDate(0, 0, 1).Add(-time.Nanosecond)
		}
		return t
	}
	return time.Time{}
}

func (s *Server) handleRequests(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	limit := 50
	if value := strings.TrimSpace(r.URL.Query().Get("limit")); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil {
			limit = parsed
		}
	}
	ids := splitCSV(r.URL.Query().Get("ids"))
	if len(ids) > 0 && limit < len(ids) {
		limit = len(ids)
	}
	// from/to are wall-clock instants interpreted in the caller's timezone (tz), which
	// defaults to Asia/Seoul (KST) so operators searching by local time get correct
	// bounds without a 9-hour off-by-one against the UTC-stored created_at column.
	loc := searchLocation(r.URL.Query().Get("tz"))
	from := parseRangeBound(r.URL.Query().Get("from"), loc, false)
	to := parseRangeBound(r.URL.Query().Get("to"), loc, true)
	teams, teamScoped := requestTeamScopeForCaller(s, r)
	requests, err := s.db.RecentRequests(r.Context(), store.RequestFilter{
		Limit:      limit,
		IDs:        ids,
		IP:         strings.TrimSpace(r.URL.Query().Get("ip")),
		Model:      strings.TrimSpace(r.URL.Query().Get("model")),
		Language:   strings.TrimSpace(r.URL.Query().Get("language")),
		Teams:      teams,
		TeamScoped: teamScoped,
		From:       from,
		To:         to,
	})
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "requests_failed")
		return
	}
	if requests == nil {
		requests = []store.RecentRequest{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": requests})
}

func (s *Server) handleAPIKeys(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		keys, err := s.db.ListAPIKeys(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "api_keys_failed")
			return
		}
		if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" {
			filtered := keys[:0]
			for _, key := range keys {
				if key.Team == claims.TeamID {
					filtered = append(filtered, key)
				}
			}
			keys = filtered
		}
		writeJSON(w, http.StatusOK, map[string]any{"api_keys": keys})
	case http.MethodPost:
		var payload struct {
			Name             string    `json:"name"`
			Key              string    `json:"key"`
			Owner            string    `json:"owner"`
			Team             string    `json:"team"`
			UserID           string    `json:"user_id"`
			ServiceAccountID string    `json:"service_account_id"`
			Role             string    `json:"role"`
			Scopes           *[]string `json:"scopes"`
			AllowedIPs       []string  `json:"allowed_ips"`
			AllowedModels    []string  `json:"allowed_models"`
			DeniedModels     []string  `json:"denied_models"`
			AllowedProviders []string  `json:"allowed_providers"`
			DeniedProviders  []string  `json:"denied_providers"`
			BudgetLimitKRW   float64   `json:"budget_limit_krw"`
			ExpiresAt        string    `json:"expires_at"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		payload.Name = strings.TrimSpace(payload.Name)
		payload.Key = strings.TrimSpace(payload.Key)
		if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" {
			payload.Team = claims.TeamID
		}
		if payload.Name == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name is required", "invalid_request_error", "missing_name")
			return
		}
		plainKey := payload.Key
		generated := false
		if plainKey == "" {
			var err error
			prefix := s.cfg.Auth.APIKeyPrefix
			if payload.Role == "service_account" || payload.ServiceAccountID != "" {
				prefix = s.cfg.Auth.ServiceKeyPrefix
			}
			plainKey, err = generateAuthAPIKey(prefix)
			if err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "key_generation_failed")
				return
			}
			generated = true
		}
		role := strings.TrimSpace(payload.Role)
		if role != "" && !s.effectiveValidRole(r.Context(), role) {
			writeOpenAIError(w, http.StatusBadRequest, "invalid role", "invalid_request_error", "invalid_role")
			return
		}
		if role != "" && !s.canAssignRole(r, role) {
			s.auditAuthEvent(r.Context(), "role_denied", "", "", strings.TrimSpace(payload.Team), "create api key role "+role)
			writeOpenAIError(w, http.StatusForbidden, "cannot assign role at or above your role", "permission_error", "role_escalation_denied")
			return
		}
		serviceAccount := role == "service_account" || strings.TrimSpace(payload.ServiceAccountID) != ""
		scopes := defaultAPIKeyScopes(role, serviceAccount)
		if payload.Scopes != nil {
			normalized, ok := normalizeScopes(*payload.Scopes)
			if !ok {
				writeOpenAIError(w, http.StatusBadRequest, "invalid scope", "invalid_request_error", "invalid_scope")
				return
			}
			if !s.scopesAssignable(r, normalized) {
				s.auditAuthEvent(r.Context(), "scope_denied", "", "", strings.TrimSpace(payload.Team), "create api key scopes")
				writeOpenAIError(w, http.StatusForbidden, "cannot assign scopes outside your role", "permission_error", "scope_denied")
				return
			}
			scopes = normalized
		} else if !s.scopesAssignable(r, scopes) {
			s.auditAuthEvent(r.Context(), "scope_denied", "", "", strings.TrimSpace(payload.Team), "create api key default scopes")
			writeOpenAIError(w, http.StatusForbidden, "cannot assign default scopes for requested role", "permission_error", "scope_denied")
			return
		}
		record := store.APIKeyRecord{
			ID:               "key_" + hashProxyKey(plainKey)[:16],
			Name:             payload.Name,
			KeyHash:          hashProxyKey(plainKey),
			Owner:            strings.TrimSpace(payload.Owner),
			Team:             strings.TrimSpace(payload.Team),
			UserID:           strings.TrimSpace(payload.UserID),
			ServiceAccountID: strings.TrimSpace(payload.ServiceAccountID),
			Role:             role,
			Status:           "active",
			Scopes:           scopes,
			AllowedIPs:       payload.AllowedIPs,
			AllowedModels:    payload.AllowedModels,
			DeniedModels:     payload.DeniedModels,
			AllowedProviders: payload.AllowedProviders,
			DeniedProviders:  payload.DeniedProviders,
			BudgetLimitKRW:   payload.BudgetLimitKRW,
			ExpiresAt:        parseAPITime(payload.ExpiresAt),
		}
		if err := s.db.UpsertAPIKey(r.Context(), record); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "api_key_create_failed")
			return
		}
		s.auditAdmin(r, "api_key.upsert", "", auditJSON(map[string]any{"id": record.ID, "name": record.Name, "owner": record.Owner, "team": record.Team, "generated": generated}))
		_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "api_key_created", APIKeyID: record.ID, TeamID: record.Team, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: record.Name, CreatedAt: time.Now().UTC()})
		writeJSON(w, http.StatusCreated, map[string]any{
			"api_key": map[string]any{
				"id": record.ID, "name": record.Name, "owner": record.Owner, "team": record.Team, "user_id": record.UserID,
				"service_account_id": record.ServiceAccountID, "role": record.Role, "status": record.Status,
				"scopes": record.Scopes, "allowed_ips": record.AllowedIPs,
			},
			"secret": plainKey,
		})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleAPIKeyByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/admin/api-keys/")
	id := rest
	action := ""
	if idx := strings.Index(rest, "/"); idx >= 0 {
		id = rest[:idx]
		action = rest[idx+1:]
	}
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid API key id", "invalid_request_error", "invalid_api_key_id")
		return
	}
	existing, found, err := s.db.GetAPIKey(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "api_key_lookup_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "api key not found", "invalid_request_error", "api_key_not_found")
		return
	}
	if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" && existing.Team != claims.TeamID {
		writeOpenAIError(w, http.StatusForbidden, "team_admin can only manage own team api keys", "permission_error", "team_scope_denied")
		return
	}
	existingRole := existing.Role
	if existingRole == "" {
		if existing.ServiceAccountID != "" {
			existingRole = "service_account"
		} else {
			existingRole = "developer"
		}
	}
	if !s.canModifySubjectRole(r, existingRole) {
		s.auditAuthEvent(r.Context(), "role_denied", "", id, existing.Team, "modify api key role "+existingRole)
		writeOpenAIError(w, http.StatusForbidden, "cannot modify an api key at or above your role", "permission_error", "role_escalation_denied")
		return
	}
	if action == "revoke" {
		if r.Method != http.MethodPost {
			writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
			return
		}
		if err := s.db.RevokeAPIKey(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "api_key_revoke_failed")
			return
		}
		_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "api_key_revoked", APIKeyID: id, IP: clientIP(r), UserAgent: r.UserAgent(), CreatedAt: time.Now().UTC()})
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "revoked"})
		return
	}
	if action != "" {
		writeOpenAIError(w, http.StatusNotFound, "not found", "invalid_request_error", "not_found")
		return
	}
	switch r.Method {
	case http.MethodDelete:
		// ?hard=1 → permanent row delete; super_admin only when auth is enabled
		// (legacy ADMIN_TOKEN mode: the full-access token is the super user).
		if r.URL.Query().Get("hard") == "1" {
			if claims, ok := s.currentAccessClaims(r); s.cfg.Auth.Enabled && (!ok || claims.Role != "super_admin") {
				writeOpenAIError(w, http.StatusForbidden, "hard delete requires super_admin", "permission_error", "super_admin_required")
				return
			}
			if err := s.db.DeleteAPIKey(r.Context(), id); err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "api_key_delete_failed")
				return
			}
			s.auditAdmin(r, "api_key.delete", auditJSON(map[string]string{"id": id}), "")
			_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "api_key_revoked", APIKeyID: id, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "hard_delete", CreatedAt: time.Now().UTC()})
			writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
			return
		}
		if err := s.db.RevokeAPIKey(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "api_key_update_failed")
			return
		}
		s.auditAdmin(r, "api_key.status", "", auditJSON(map[string]any{"id": id, "status": "revoked"}))
		_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "api_key_revoked", APIKeyID: id, IP: clientIP(r), UserAgent: r.UserAgent(), CreatedAt: time.Now().UTC()})
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "revoked"})
	case http.MethodPatch:
		// Partial update: status and/or label (name/owner/team). This is also how an
		// observed external key (ext_…, whose hash the gateway already stored) is
		// promoted to a named, active managed user — no plaintext needed.
		var payload struct {
			Status *string  `json:"status"`
			Name   *string  `json:"name"`
			Owner  *string  `json:"owner"`
			Team   *string  `json:"team"`
			Role   *string  `json:"role"`
			Scopes []string `json:"scopes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		updated := existing
		if payload.Status != nil {
			st := strings.TrimSpace(*payload.Status)
			if st != "active" && st != "disabled" {
				writeOpenAIError(w, http.StatusBadRequest, "status must be active or disabled", "invalid_request_error", "invalid_status")
				return
			}
			updated.Status = st
		}
		if payload.Name != nil {
			updated.Name = strings.TrimSpace(*payload.Name)
		}
		if payload.Owner != nil {
			updated.Owner = strings.TrimSpace(*payload.Owner)
		}
		if payload.Team != nil {
			nextTeam := strings.TrimSpace(*payload.Team)
			if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" && nextTeam != claims.TeamID {
				writeOpenAIError(w, http.StatusForbidden, "team_admin cannot move api keys across teams", "permission_error", "team_scope_denied")
				return
			}
			updated.Team = nextTeam
		}
		if payload.Role != nil {
			nextRole := strings.TrimSpace(*payload.Role)
			if nextRole != "" && !s.effectiveValidRole(r.Context(), nextRole) {
				writeOpenAIError(w, http.StatusBadRequest, "invalid role", "invalid_request_error", "invalid_role")
				return
			}
			if nextRole != "" && !s.canAssignRole(r, nextRole) {
				s.auditAuthEvent(r.Context(), "role_denied", "", id, updated.Team, "assign api key role "+nextRole)
				writeOpenAIError(w, http.StatusForbidden, "cannot assign role at or above your role", "permission_error", "role_escalation_denied")
				return
			}
			updated.Role = nextRole
		}
		if payload.Scopes != nil {
			normalized, ok := normalizeScopes(payload.Scopes)
			if !ok {
				writeOpenAIError(w, http.StatusBadRequest, "invalid scope", "invalid_request_error", "invalid_scope")
				return
			}
			if !s.scopesAssignable(r, normalized) {
				s.auditAuthEvent(r.Context(), "scope_denied", "", id, updated.Team, "update api key scopes")
				writeOpenAIError(w, http.StatusForbidden, "cannot assign scopes outside your role", "permission_error", "scope_denied")
				return
			}
			updated.Scopes = normalized
		}
		if err := s.db.UpsertAPIKey(r.Context(), updated); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "api_key_update_failed")
			return
		}
		s.auditAdmin(r, "api_key.update", auditJSON(existing), auditJSON(updated))
		if existing.Role != updated.Role {
			_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "role_changed", APIKeyID: id, TeamID: updated.Team, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: existing.Role + " -> " + updated.Role, CreatedAt: time.Now().UTC()})
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": updated.ID, "name": updated.Name, "owner": updated.Owner, "team": updated.Team, "role": updated.Role, "scopes": updated.Scopes, "status": updated.Status})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleProviders(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		providers, err := s.db.ListProviders(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "providers_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"providers": providers})
	case http.MethodPost:
		var payload struct {
			Name          string `json:"name"`
			BaseURL       string `json:"base_url"`
			APIKey        string `json:"api_key"`
			TimeoutMS     int    `json:"timeout_ms"`
			Enabled       *bool  `json:"enabled"`
			ModelPatterns string `json:"model_patterns"`
			FailoverGroup string `json:"failover_group"`
			Priority      *int   `json:"priority"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		payload.Name = strings.TrimSpace(payload.Name)
		payload.BaseURL = strings.TrimRight(strings.TrimSpace(payload.BaseURL), "/")
		if payload.Name == "" || payload.BaseURL == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name and base_url are required", "invalid_request_error", "missing_provider_fields")
			return
		}
		if _, err := url.ParseRequestURI(payload.BaseURL); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "base_url must be an absolute URL", "invalid_request_error", "invalid_base_url")
			return
		}
		if payload.TimeoutMS <= 0 {
			payload.TimeoutMS = int(s.cfg.Upstream.Timeout / time.Millisecond)
		}
		enabled := true
		if payload.Enabled != nil {
			enabled = *payload.Enabled
		}

		before, _, _ := s.db.GetProvider(r.Context(), payload.Name)
		encryptedKey := before.EncryptedAPIKey
		if strings.TrimSpace(payload.APIKey) != "" {
			var err error
			encryptedKey, err = s.secrets.Load().Encrypt(strings.TrimSpace(payload.APIKey))
			if err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "provider_encrypt_failed")
				return
			}
		}
		provider := store.ProviderConfig{
			Name:            payload.Name,
			BaseURL:         payload.BaseURL,
			EncryptedAPIKey: encryptedKey,
			TimeoutMS:       payload.TimeoutMS,
			Enabled:         enabled,
			ModelPatterns:   strings.TrimSpace(payload.ModelPatterns),
			FailoverGroup:   strings.TrimSpace(payload.FailoverGroup),
			Priority:        store.DefaultProviderPriority,
		}
		if payload.Priority != nil && *payload.Priority > 0 {
			provider.Priority = *payload.Priority
		} else if before.Priority > 0 && payload.Priority == nil {
			// Editing a provider without sending priority keeps the stored value, so a
			// form that omits the field cannot silently reset a deliberate ordering.
			provider.Priority = before.Priority
		}
		if err := s.db.UpsertProvider(r.Context(), provider); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "provider_save_failed")
			return
		}
		s.auditAdmin(r, "provider.upsert", providerAuditJSON(before), providerAuditJSON(provider))
		writeJSON(w, http.StatusOK, map[string]any{
			"provider": map[string]any{
				"name":               provider.Name,
				"base_url":           provider.BaseURL,
				"api_key_configured": provider.EncryptedAPIKey != "",
				"timeout_ms":         provider.TimeoutMS,
				"enabled":            provider.Enabled,
				"model_patterns":     provider.ModelPatterns,
				"failover_group":     provider.FailoverGroup,
				"priority":           provider.Priority,
			},
		})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleProviderByName(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/admin/providers/")
	if name == "" || strings.Contains(name, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid provider name", "invalid_request_error", "invalid_provider_name")
		return
	}
	switch r.Method {
	case http.MethodDelete:
		before, found, _ := s.db.GetProvider(r.Context(), name)
		if !found {
			writeOpenAIError(w, http.StatusNotFound, "provider not found: "+name, "invalid_request_error", "provider_not_found")
			return
		}
		deleted, err := s.db.DeleteProvider(r.Context(), name)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "provider_delete_failed")
			return
		}
		if !deleted {
			writeOpenAIError(w, http.StatusNotFound, "provider not found: "+name, "invalid_request_error", "provider_not_found")
			return
		}
		s.auditAdmin(r, "provider.delete", providerAuditJSON(before), "")
		writeJSON(w, http.StatusOK, map[string]string{"deleted": name})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleAuditLogs(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	limit := 50
	if value := strings.TrimSpace(r.URL.Query().Get("limit")); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil {
			limit = parsed
		}
	}
	logs, err := s.db.ListAdminAudit(r.Context(), limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "audit_logs_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"audit_logs": logs})
}

type statusResponseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (w *statusResponseWriter) WriteHeader(code int) {
	w.statusCode = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusResponseWriter) Write(b []byte) (int, error) {
	if w.statusCode == 0 {
		w.statusCode = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

func (w *statusResponseWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *Server) handleOpenAI(w http.ResponseWriter, r *http.Request) {
	sw := &statusResponseWriter{ResponseWriter: w}
	rc := &requestPipeline{s: s, w: sw, r: r}

	defer func() {
		// The single exit point for every path through the pipeline, including the ones
		// that halt early and an unwinding panic. A reservation released anywhere else
		// would be missed by whichever branch was overlooked, and would then count
		// against the quota until it expired.
		s.releaseQuota(rc.quotaReserved)

		// The governance decisions of every phase, written once. Detached from the
		// request context on purpose: enforcement has already happened, and an audit
		// record that disappears because the client hung up is the one worth keeping.
		s.writePolicyDecisionEvents(context.WithoutCancel(r.Context()), rc.policyEvents)

		if r.Method == http.MethodGet && r.URL.Path == "/v1/models" && sw.statusCode == http.StatusOK {
			return
		}

		meta := rc.meta
		if meta.Request.ID != "" {
			if _, logged := s.loggedRequests.LoadAndDelete(meta.Request.ID); !logged {
				statusCode := sw.statusCode
				if statusCode == 0 {
					statusCode = http.StatusBadRequest
				}
				meta.Request.StatusCode = statusCode
				if meta.Request.Error == "" {
					meta.Request.Error = "pipeline_blocked"
				}
				s.enqueue(meta)
			}
		} else {
			traceID := rc.traceID
			if traceID == "" {
				traceID = traceIDFromRequest(r)
			}
			meta = s.auditRequest(r.URL.Path, rc.body, rc.apiKeyID, traceID, r)
			statusCode := sw.statusCode
			if statusCode == 0 {
				statusCode = http.StatusBadRequest
			}
			meta.Request.StatusCode = statusCode
			if meta.Request.Error == "" {
				meta.Request.Error = "early_blocked"
			}
			s.enqueue(meta)
			s.loggedRequests.Delete(meta.Request.ID)
		}
	}()

	if r.Method != http.MethodPost && !(r.Method == http.MethodGet && r.URL.Path == "/v1/models") {
		writeOpenAIError(sw, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}

	if snap := s.killSnapshot(r.Context()); snap != nil && snap.disabled {
		sw.Header().Set("Retry-After", "60")
		sw.Header().Set("X-Kill-Switch", "global")
		if snap.reason != "" {
			sw.Header().Set("X-Kill-Reason", snap.reason)
		}
		s.metrics.IncKillSwitch()
		writeOpenAIError(sw, http.StatusServiceUnavailable, "gateway is disabled by admin kill switch: "+snap.reason, "server_error", "kill_switch_active")
		return
	}

	// The request flows through an explicit, ordered pipeline:
	//   Auth → Quota → Routing → Governance → Cache → Cost → Upstream
	// Each step shares the requestPipeline state and halts the chain (after
	// writing its own response) by returning false. See pipeline.go.
	for _, step := range rc.steps() {
		if !step.Run(rc) {
			return
		}
	}
}

func (s *Server) copyResponse(w http.ResponseWriter, body io.Reader, analyzer *ResponseAnalyzer, flush bool, start time.Time) (int64, bool, error) {
	flusher, _ := w.(http.Flusher)
	buffer := make([]byte, 32*1024)
	var firstChunkMS int64
	firstChunkSeen := false
	for {
		n, readErr := body.Read(buffer)
		if n > 0 {
			if !firstChunkSeen {
				firstChunkMS = time.Since(start).Milliseconds()
				firstChunkSeen = true
			}
			chunk := buffer[:n]
			analyzer.Write(chunk)
			if _, err := w.Write(chunk); err != nil {
				return firstChunkMS, firstChunkSeen, err
			}
			if flush && flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				return firstChunkMS, firstChunkSeen, nil
			}
			return firstChunkMS, firstChunkSeen, readErr
		}
	}
}

func (s *Server) enqueue(record store.LogRecord) {
	if record.Request.ID != "" {
		s.loggedRequests.Store(record.Request.ID, true)
	}
	s.logger.Enqueue(record)
	s.enqueueClickHouseFact(record)
}

func (s *Server) upstreamURL(baseURL string, incoming *url.URL) (string, error) {
	base, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	base.Path = strings.TrimRight(base.Path, "/") + incoming.Path
	base.RawQuery = incoming.RawQuery
	return base.String(), nil
}

func (s *Server) authenticateProxy(r *http.Request) (string, bool) {
	id, _, ok := s.authenticateProxyContext(r)
	return id, ok
}

// authOutcome distinguishes "this caller is not allowed" from "we could not find out".
//
// Both refuse the request — failing closed when credentials cannot be verified is the
// only safe choice — but they are different events and deserve different answers. A
// database outage used to be reported to the client as 401 "invalid proxy API key",
// which is wrong twice over: it tells an operator their key is bad while the real
// problem is the store, and 401 tells clients and SDKs the request is not worth
// retrying, so a transient outage reads as a permanent credential failure.
type authOutcome int

const (
	authDenied      authOutcome = iota // the caller is genuinely not allowed
	authOK                             // the caller is identified and allowed
	authUnavailable                    // the store could not be consulted; unknown, so refused
)

// authenticateProxyContext keeps the boolean shape used by the handlers that only need
// to know whether a caller was identified.
func (s *Server) authenticateProxyContext(r *http.Request) (string, *store.AuthContext, bool) {
	id, ctx, outcome := s.authenticateProxyContextWithOutcome(r)
	return id, ctx, outcome == authOK
}

func (s *Server) authenticateProxyContextWithOutcome(r *http.Request) (string, *store.AuthContext, authOutcome) {
	token := bearerToken(r.Header.Get("Authorization"))
	if token == "" {
		hasKeys, err := s.db.HasActiveAPIKeys(r.Context())
		if err != nil {
			slog.Warn("check active proxy keys failed", "error", err)
			return "", nil, authUnavailable
		}
		if !hasKeys && !s.cfg.Auth.Enabled {
			return "anonymous", nil, authOK
		}
		_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "api_key_denied", IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "missing bearer token", CreatedAt: time.Now().UTC()})
		return "", nil, authDenied
	}
	keyHash := hashProxyKey(token)
	key, found, err := s.db.FindActiveAPIKeyByHash(r.Context(), keyHash)
	if err != nil {
		slog.Warn("lookup proxy api key failed", "error", err)
		return "", nil, authUnavailable
	}
	if found {
		authCtx := authContextFromAPIKey(key)
		s.enrichAuthContextTeam(r.Context(), &authCtx)
		if !key.RevokedAt.IsZero() || key.Status != "active" {
			_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "api_key_denied", APIKeyID: key.ID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "revoked_or_inactive", CreatedAt: time.Now().UTC()})
			return "", nil, authDenied
		}
		if !key.ExpiresAt.IsZero() && key.ExpiresAt.Before(time.Now().UTC()) {
			_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "api_key_denied", APIKeyID: key.ID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "expired", CreatedAt: time.Now().UTC()})
			return "", nil, authDenied
		}
		if !ipAllowed(clientIP(r), key.AllowedIPs) {
			_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "ip_denied", APIKeyID: key.ID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: strings.Join(key.AllowedIPs, ","), CreatedAt: time.Now().UTC()})
			return "", nil, authDenied
		}
		scope := apiScopeForRequest(r)
		if s.cfg.Auth.Enabled && scope != "" && !hasScope(key.Scopes, scope) {
			_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "scope_denied", APIKeyID: key.ID, TeamID: key.Team, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: scope, CreatedAt: time.Now().UTC()})
			return "", nil, authDenied
		}
		return key.ID, &authCtx, authOK
	}
	// 토큰이 proxy key(pcg_ 접두사)가 아니면 upstream API key passthrough 로 허용
	// 이를 통해 Roo Code / Cursor 등이 upstream key 를 직접 보내도 프록시가 작동함
	if !s.cfg.Auth.Enabled && !strings.HasPrefix(token, "pcg_") {
		return s.attributeExternalKey(r, keyHash), nil, authOK
	}
	hasKeys, err := s.db.HasActiveAPIKeys(r.Context())
	if err != nil {
		slog.Warn("check active proxy keys failed", "error", err)
		return "", nil, authUnavailable
	}
	if !hasKeys && !s.cfg.Auth.Enabled {
		return "anonymous", nil, authOK
	}
	_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "api_key_denied", IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "unknown key", CreatedAt: time.Now().UTC()})
	return "", nil, authDenied
}

// attributeExternalKey maps an unregistered (non-proxy) bearer key to a stable
// per-key identity so distinct client keys appear as distinct users in history,
// instead of collapsing into one shared "passthrough" bucket. The id is derived
// from the key hash (the gateway never stores the plaintext) and uses the same
// "key_" prefix as issued keys — registration is distinguished by status
// ("external" vs "active"), not by id prefix — so promoting an external key to a
// managed one is just a status flip on the same identity. On first sight it lazily
// registers a labeled api_keys row (status "external") with name/team from an
// optional X-Vibe-User / X-Vibe-Team header.
func (s *Server) attributeExternalKey(r *http.Request, keyHash string) string {
	if !s.cfg.Auth.AttributeExternalKeys {
		return "passthrough"
	}
	id := "key_" + keyHash[:16]
	if _, seen := s.extSeen.Load(id); !seen {
		name := firstNonEmptyHeader(r, "X-Vibe-User", "X-User-Id", "X-Title")
		if name == "" {
			name = "external-" + keyHash[:8]
		}
		rec := store.APIKeyRecord{
			ID:      id,
			Name:    name,
			KeyHash: keyHash,
			Team:    firstNonEmptyHeader(r, "X-Vibe-Team", "X-Team"),
			Status:  "external",
		}
		if err := s.db.EnsureExternalAPIKey(r.Context(), rec); err != nil {
			slog.Warn("register external api key failed", "error", err)
		} else {
			s.extSeen.Store(id, struct{}{})
		}
	}
	return id
}

type resolvedProvider struct {
	Name    string
	BaseURL string
	APIKey  string
	Timeout time.Duration
	Reason  string // header | query | model_pattern | default
	Detail  string // e.g. matched glob pattern, or header name
}

// dialUpstream sends the request to `primary`. On transport-level failure (timeout,
// connection refused, EOF before any response) it falls back to the next candidate
// in `failoverCandidates`, in order. Returns the live response, the name of the
// provider that actually answered, and (if a failover occurred) the original primary's
// name in `failoverFrom`.
func (s *Server) dialUpstream(reqCtx context.Context, r *http.Request, body []byte, primary resolvedProvider, traceID string, failoverCandidates []string) (*http.Response, string, string, string, []string, []byte, string, http.Header, error) {
	attempts := []providerAttempt{{provider: primary}}
	for _, name := range failoverCandidates {
		// Re-resolve each candidate so we get its decrypted key and timeout.
		fakeReq := r.Clone(reqCtx)
		fakeReq.Header.Set("X-Proxy-Provider", name)
		cand, err := s.selectProvider(reqCtx, fakeReq, "")
		if err != nil {
			slog.Warn("failover candidate unavailable", "name", name, "error", err)
			continue
		}
		attempts = append(attempts, providerAttempt{provider: cand})
	}

	breakerEnabled, breakerThreshold, breakerCooldown := s.breakerConfig()
	if breakerEnabled {
		attempts = s.filterOpenBreakers(attempts, breakerThreshold, breakerCooldown, traceID)
	}

	// Failover budget: how long the gateway may keep trying alternates. Checked
	// between attempts so an in-flight response is never cut short; a request that
	// has already spent the budget returns the last error instead of walking the
	// remaining candidates.
	failoverDeadline := time.Time{}
	if budget := s.upstreamConf().FailoverBudget; budget > 0 {
		failoverDeadline = time.Now().Add(budget)
	}
	if raw := strings.TrimSpace(r.Header.Get("X-Failover-Budget-MS")); raw != "" {
		if ms, convErr := strconv.Atoi(raw); convErr == nil && ms > 0 {
			failoverDeadline = time.Now().Add(time.Duration(ms) * time.Millisecond)
		}
	}
	budgetSpent := func() bool {
		return !failoverDeadline.IsZero() && !time.Now().Before(failoverDeadline)
	}

	var lastErr error
	failoverPath := []string{}
	currentBody := body
	// Only the model name is wanted here. Reading it used to go through
	// previewModelComplexity, which extracted and redacted every prompt to compute a
	// complexity score this caller discarded -- and it was the only caller, so the score
	// was never used at all.
	currentModel := extractModel(currentBody)
	usedLongContext := false
	var lastUpstreamHeaders http.Header
	for i := 0; i < len(attempts); {
		att := attempts[i]
		upstreamURL, err := s.upstreamURL(att.provider.BaseURL, r.URL)
		if err != nil {
			return nil, "", "", "", failoverPath, currentBody, currentModel, lastUpstreamHeaders, err
		}
		ctx := reqCtx
		var cancel context.CancelFunc
		if att.provider.Timeout > 0 {
			ctx, cancel = context.WithTimeout(reqCtx, att.provider.Timeout)
		}
		upstreamReq, err := http.NewRequestWithContext(ctx, r.Method, upstreamURL, bytes.NewReader(currentBody))
		if err != nil {
			if cancel != nil {
				cancel()
			}
			return nil, "", "", "", failoverPath, currentBody, currentModel, lastUpstreamHeaders, err
		}
		copyUpstreamHeaders(upstreamReq.Header, r.Header)
		upstreamReq.Header.Set("Authorization", "Bearer "+att.provider.APIKey)
		upstreamReq.Header.Set("X-Request-ID", traceID)
		if r.Method == http.MethodPost && upstreamReq.Header.Get("Content-Type") == "" {
			upstreamReq.Header.Set("Content-Type", "application/json")
		}
		lastUpstreamHeaders = upstreamReq.Header.Clone()

		resp, doErr := s.client.Do(upstreamReq)
		if doErr == nil {
			if breakerEnabled {
				if breakerCountsAsFailure(resp.StatusCode) {
					s.noteBreakerFailure(att.provider.Name, fallbackReasonForStatus(resp.StatusCode), breakerThreshold, traceID)
				} else {
					s.noteBreakerSuccess(att.provider.Name)
				}
			}
			if statusFallbackAllowed(resp.StatusCode) && i+1 < len(attempts) && !budgetSpent() {
				reason := fallbackReasonForStatus(resp.StatusCode)
				_, _ = io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				if cancel != nil {
					cancel()
				}
				failoverPath = append(failoverPath, reason+":"+att.provider.Name+"->"+attempts[i+1].provider.Name)
				slog.Warn("upstream status fallback", "provider", att.provider.Name, "status", resp.StatusCode, "next", attempts[i+1].provider.Name)
				i++
				continue
			}
			if statusFallbackAllowed(resp.StatusCode) && i+1 < len(attempts) && budgetSpent() {
				failoverPath = append(failoverPath, "failover_budget_exhausted:"+att.provider.Name)
				slog.Warn("failover budget exhausted", "provider", att.provider.Name, "status", resp.StatusCode, "trace_id", traceID)
			}
			if resp.StatusCode == http.StatusBadRequest && !usedLongContext {
				sniff, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
				_ = resp.Body.Close()
				if cancel != nil {
					cancel()
				}
				if contextOverflowBody(sniff) {
					longModel := defaultAutoModel("reasoning")
					if longModel != "" && longModel != currentModel {
						failoverPath = append(failoverPath, "context_overflow:"+currentModel+"->"+longModel)
						currentBody = rewriteModelField(currentBody, longModel)
						currentModel = longModel
						usedLongContext = true
						continue
					}
				}
				resp.Body = io.NopCloser(bytes.NewReader(sniff))
			}
			// Note: ctx must outlive resp.Body reads, so we do NOT call cancel() here.
			_ = cancel
			from := ""
			reason := ""
			if i > 0 {
				from = primary.Name
				if len(failoverPath) > 0 {
					reason = failoverPath[len(failoverPath)-1]
				}
			}
			return resp, att.provider.Name, from, reason, failoverPath, currentBody, currentModel, lastUpstreamHeaders, nil
		}
		if cancel != nil {
			cancel()
		}
		lastErr = doErr
		reason := fallbackReasonForError(doErr)
		if breakerEnabled {
			s.noteBreakerFailure(att.provider.Name, reason, breakerThreshold, traceID)
		}
		slog.Warn("upstream call failed", "provider", att.provider.Name, "attempt", i, "error", doErr)
		if i+1 < len(attempts) {
			if budgetSpent() {
				failoverPath = append(failoverPath, "failover_budget_exhausted:"+att.provider.Name)
				slog.Warn("failover budget exhausted", "provider", att.provider.Name, "trace_id", traceID)
				break
			}
			failoverPath = append(failoverPath, reason+":"+att.provider.Name+"->"+attempts[i+1].provider.Name)
		}
		i++
	}
	if lastErr == nil {
		lastErr = errors.New("no provider attempts made")
	}
	return nil, "", "", fallbackReasonForError(lastErr), failoverPath, currentBody, currentModel, lastUpstreamHeaders, lastErr
}

// selectProviderForced resolves a provider, optionally pinned to forceProvider
// (set by a complexity routing rule's target_provider). When forceProvider is empty
// it behaves exactly like selectProvider.
func (s *Server) selectProviderForced(ctx context.Context, r *http.Request, model, forceProvider string) (resolvedProvider, error) {
	if strings.TrimSpace(forceProvider) != "" {
		clone := r.Clone(ctx)
		clone.Header.Set("X-Proxy-Provider", forceProvider)
		rp, err := s.selectProvider(ctx, clone, model)
		if err == nil {
			rp.Reason, rp.Detail = "rule_provider", forceProvider
		}
		return rp, err
	}
	return s.selectProvider(ctx, r, model)
}

func (s *Server) selectProvider(ctx context.Context, r *http.Request, model string) (resolvedProvider, error) {
	reason, detail := "default", ""
	name := strings.TrimSpace(r.Header.Get("X-Proxy-Provider"))
	if name != "" {
		reason, detail = "header", "X-Proxy-Provider"
	}
	if name == "" {
		if q := strings.TrimSpace(r.URL.Query().Get("provider")); q != "" {
			name, reason, detail = q, "query", "?provider="
		}
	}

	// If the client did not pin a provider, try to auto-route by model glob.
	if name == "" && model != "" {
		if matched, pattern, ok, err := s.matchProviderByModelDetail(ctx, model); err == nil && ok {
			name, reason, detail = matched, "model_pattern", pattern
		}
	}
	if name == "" {
		name = s.cfg.Upstream.Provider
		reason, detail = "default", "UPSTREAM_PROVIDER"
	}

	provider, found, err := s.db.GetProvider(ctx, name)
	if err != nil {
		return resolvedProvider{}, err
	}
	if !found {
		return resolvedProvider{}, fmt.Errorf("provider %q is not configured", name)
	}
	if !provider.Enabled {
		return resolvedProvider{}, fmt.Errorf("provider %q is disabled", name)
	}
	apiKey, err := s.secrets.Load().Decrypt(provider.EncryptedAPIKey)
	if err != nil {
		return resolvedProvider{}, fmt.Errorf("provider %q API key cannot be decrypted", name)
	}
	if apiKey == "" {
		return resolvedProvider{}, fmt.Errorf("provider %q API key is not configured", name)
	}
	timeout := time.Duration(provider.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = s.cfg.Upstream.Timeout
	}
	return resolvedProvider{Name: provider.Name, BaseURL: provider.BaseURL, APIKey: apiKey, Timeout: timeout, Reason: reason, Detail: detail}, nil
}

// matchProviderByModelDetail is matchProviderByModel but also returns the matched glob.
func (s *Server) matchProviderByModelDetail(ctx context.Context, model string) (string, string, bool, error) {
	providers, err := s.db.ListProviderConfigs(ctx)
	if err != nil || len(providers) == 0 {
		return "", "", false, err
	}
	normalized := strings.ToLower(strings.TrimSpace(model))
	for _, p := range providers {
		if p.ModelPatterns == "" {
			continue
		}
		for _, raw := range strings.Split(p.ModelPatterns, ",") {
			pattern := strings.ToLower(strings.TrimSpace(raw))
			if pattern == "" {
				continue
			}
			if matchGlob(pattern, normalized) {
				return p.Name, pattern, true, nil
			}
		}
	}
	return "", "", false, nil
}

func (s *Server) matchProviderByModel(ctx context.Context, model string) (string, bool, error) {
	matches, err := s.providersForModel(ctx, model)
	if err != nil || len(matches) == 0 {
		return "", false, err
	}
	return matches[0], true, nil
}

// providersForModel returns all enabled providers whose model_patterns match the
// given model, in DB-listed order. The first element is the primary choice; the
// rest are valid failover targets.
func (s *Server) providersForModel(ctx context.Context, model string) ([]string, error) {
	if model == "" {
		return nil, nil
	}
	providers, err := s.db.ListProviderConfigs(ctx)
	if err != nil {
		return nil, err
	}
	normalized := strings.ToLower(strings.TrimSpace(model))
	matches := []string{}
	groups := map[string]bool{}
	for _, p := range providers {
		if !providerServesModel(p, normalized) {
			continue
		}
		matches = append(matches, p.Name)
		if g := strings.TrimSpace(p.FailoverGroup); g != "" {
			groups[g] = true
		}
	}
	// Anything in the same failover group is a candidate too, even if its patterns do
	// not match this model. That is the point of the group: an operator declaring
	// "these three serve the same traffic" should not also have to keep their globs
	// identical for redundancy to exist. Group members are appended after the pattern
	// matches, so an exact match is still preferred, and the list stays priority-ordered
	// within each half because ListProviderConfigs already sorted it.
	if len(groups) > 0 {
		seen := map[string]bool{}
		for _, name := range matches {
			seen[name] = true
		}
		for _, p := range providers {
			if seen[p.Name] || !groups[strings.TrimSpace(p.FailoverGroup)] {
				continue
			}
			matches = append(matches, p.Name)
			seen[p.Name] = true
		}
	}
	return matches, nil
}

// providerServesModel reports whether any of a provider's model globs match.
func providerServesModel(p store.ProviderConfig, normalizedModel string) bool {
	if p.ModelPatterns == "" {
		return false
	}
	for _, raw := range strings.Split(p.ModelPatterns, ",") {
		pattern := strings.ToLower(strings.TrimSpace(raw))
		if pattern != "" && matchGlob(pattern, normalizedModel) {
			return true
		}
	}
	return false
}

// matchGlob implements a tiny case-insensitive glob with `*` as the wildcard.
// It supports patterns like "claude-*", "anthropic/*", "*-mini", "*o3*".
func matchGlob(pattern, value string) bool {
	if pattern == "*" {
		return true
	}
	if !strings.Contains(pattern, "*") {
		return pattern == value
	}
	parts := strings.Split(pattern, "*")
	pos := 0
	for i, part := range parts {
		if part == "" {
			continue
		}
		idx := strings.Index(value[pos:], part)
		if idx < 0 {
			return false
		}
		if i == 0 && idx != 0 {
			return false
		}
		pos += idx + len(part)
	}
	if !strings.HasSuffix(pattern, "*") && pos != len(value) {
		return false
	}
	return true
}

func hashProxyKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func generateProxyKey() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "pcg_" + base64.RawURLEncoding.EncodeToString(raw), nil
}

func (s *Server) auditAdmin(r *http.Request, action string, before string, after string) {
	if err := s.db.InsertAdminAudit(r.Context(), store.AdminAuditLog{
		ID:          newID("audit"),
		AdminID:     adminID(r),
		Action:      action,
		BeforeValue: before,
		AfterValue:  after,
	}); err != nil {
		slog.Warn("write admin audit failed", "action", action, "error", err)
	}
	if err := s.maybeRunPostChangeRedTeam(r, action, before, after); err != nil {
		// The admin mutation has already succeeded. Surface the regression trigger failure
		// operationally without turning a successful configuration write into an HTTP error.
		slog.Warn("post-change redteam trigger failed", "action", action, "error", err)
	}
}

func adminID(r *http.Request) string {
	token := bearerToken(r.Header.Get("Authorization"))
	if token == "" {
		return "anonymous"
	}
	return "admin_" + hashProxyKey(token)[:12]
}

func auditJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}

func providerAuditJSON(provider store.ProviderConfig) string {
	if provider.Name == "" {
		return ""
	}
	return auditJSON(map[string]any{
		"name":               provider.Name,
		"base_url":           provider.BaseURL,
		"api_key_configured": provider.EncryptedAPIKey != "",
		"timeout_ms":         provider.TimeoutMS,
		"enabled":            provider.Enabled,
		"model_patterns":     provider.ModelPatterns,
		"failover_group":     provider.FailoverGroup,
		"priority":           provider.Priority,
	})
}

func (s *Server) authorizeAdmin(r *http.Request) bool {
	if s.cfg.Auth.Enabled {
		claims, ok := s.verifyAccessToken(r.Context(), bearerToken(r.Header.Get("Authorization")))
		if !ok {
			_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "login_failed", IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "admin jwt invalid", CreatedAt: time.Now().UTC()})
			return false
		}
		required := adminRequiredScope(r)
		if !hasScope(claims.Scopes, required) {
			if required == "admin:write" && claims.Role == "team_admin" &&
				(strings.HasPrefix(r.URL.Path, "/admin/users") || strings.HasPrefix(r.URL.Path, "/admin/teams") || strings.HasPrefix(r.URL.Path, "/admin/api-keys")) {
				return true
			}
			// Settings sub-admins (ops/ai/security) may write under /admin/settings even
			// without admin:write; the settings handlers enforce per-category restrictions.
			if required == "admin:write" && strings.HasPrefix(r.URL.Path, "/admin/settings") && settingsSubAdminRole(claims.Role) {
				return true
			}
			_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "scope_denied", ActorUserID: claims.Subject, TeamID: claims.TeamID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: required, CreatedAt: time.Now().UTC()})
			return false
		}
		return true
	}
	if s.cfg.Auth.AdminToken == "" && s.cfg.Auth.AdminReadonlyToken == "" {
		return true
	}
	token := bearerToken(r.Header.Get("Authorization"))
	if token == "" {
		slog.Warn("admin auth failed: missing or invalid bearer token header")
		return false
	}
	if s.cfg.Auth.AdminToken != "" && token == s.cfg.Auth.AdminToken {
		return true
	}
	if s.cfg.Auth.AdminReadonlyToken != "" && token == s.cfg.Auth.AdminReadonlyToken {
		// readonly: only allow safe methods on /admin
		return r.Method == http.MethodGet || r.Method == http.MethodHead
	}
	slog.Warn("admin auth failed: token mismatch", "received_token", token, "expected_token", s.cfg.Auth.AdminToken)
	return false
}

func (s *Server) currentAccessClaims(r *http.Request) (accessClaims, bool) {
	token := bearerToken(r.Header.Get("Authorization"))
	if token == "" {
		return accessClaims{}, false
	}
	// Internal HS256 session token first (with session-active check).
	if s.cfg.Auth.Enabled {
		if c, ok := s.verifyAccessToken(r.Context(), token); ok {
			return c, true
		}
	}
	// Fall back to a Keycloak-issued RS256 access token (machine clients, SSO callers).
	if s.keycloakConfig().Enabled {
		if c, ok := s.verifyKeycloakAccessToken(r.Context(), token); ok {
			return c, true
		}
	}
	return accessClaims{}, false
}

func adminRequiredScope(r *http.Request) string {
	if strings.HasPrefix(r.URL.Path, "/admin/routing") {
		if r.Method == http.MethodGet || r.Method == http.MethodHead ||
			r.URL.Path == "/admin/routing/preview" ||
			r.URL.Path == "/admin/routing/pattern-conflicts" {
			return "routing:read"
		}
		return "routing:write"
	}
	if strings.HasPrefix(r.URL.Path, "/admin/security") || strings.HasPrefix(r.URL.Path, "/admin/policies") || strings.HasPrefix(r.URL.Path, "/admin/approvals") {
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			return "security:read"
		}
		return "admin:write"
	}
	if strings.HasPrefix(r.URL.Path, "/admin/anomalies") {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			return "admin:write"
		}
		return "costs:read"
	}
	if strings.HasPrefix(r.URL.Path, "/admin/mcp") {
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			return "observability:read"
		}
		return "mcp:admin"
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return "admin:read"
	}
	return "admin:write"
}

const killSnapshotTTL = 5 * time.Second

func (s *Server) killSnapshot(ctx context.Context) *killSnapshot {
	if cached := s.killState.value.Load(); cached != nil && time.Since(cached.fetchedAt) < killSnapshotTTL {
		return cached
	}
	flag, found, err := s.db.GetFlag(ctx, "gateway_disabled")
	snap := &killSnapshot{fetchedAt: time.Now()}
	if err == nil && found {
		snap.disabled = strings.EqualFold(strings.TrimSpace(flag.Value), "true") || flag.Value == "1"
		snap.reason = flag.Note
		snap.updatedAt = flag.UpdatedAt
		snap.updatedBy = flag.UpdatedBy
	}
	s.killState.value.Store(snap)
	return snap
}

// invalidateKillCache forces the next killSnapshot call to refetch.
func (s *Server) invalidateKillCache() {
	s.killState.value.Store(nil)
}

func (s *Server) handleAdminUI(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/admin" && r.URL.Path != "/admin/" {
		http.NotFound(w, r)
		return
	}
	servePage(w, r, adminUIPage())
}

// auditRequest builds the audit record for a request, extracting and redacting its
// prompts on the way.
func (s *Server) auditRequest(endpoint string, body []byte, apiKeyID string, traceID string, r *http.Request) store.LogRecord {
	return s.auditRequestWithPrompts(endpoint, body, apiKeyID, traceID, r, nil)
}

// auditRequestWithPrompts is auditRequest with the prompt extraction already done.
//
// stepRouting scores the request and then audits it a few lines later, and both were
// extracting the same body -- which means redacting every message twice, and redaction
// is most of what extraction costs. The routing plan already carries what it extracted,
// so the audit reuses it.
//
// Two conditions make that sound. The model may have been rewritten in between, so it is
// always re-read from the current body rather than taken from the reused set; the rewrite
// only replaces the model field, so the prompts themselves are unchanged. And the reused
// prompts were extracted with raw prompt storage off, so the caller must not pass them
// when it is on -- the record would then be missing the raw text it is meant to keep.
func (s *Server) auditRequestWithPrompts(endpoint string, body []byte, apiKeyID string, traceID string, r *http.Request, pre []store.PromptLog) store.LogRecord {
	requestID := newID("req")
	lc := s.loggingConf()
	var model string
	var stream bool
	var prompts []store.PromptLog
	var languages []audit.LanguageSignal
	if len(pre) > 0 && !lc.RawPrompts {
		// Reuse the routing pass. The model is re-read because it may have been rewritten
		// since; stream and the language signals are cheap and derived, not redacted.
		prompts = pre
		model = extractModel(body)
		stream = streamRequested(body)
		languages = languagesFromPrompts(prompts)
	} else {
		model, stream, prompts, languages = extractAudit(body, endpoint, lc.RawPrompts)
	}
	now := time.Now().UTC()

	for i := range prompts {
		prompts[i].ID = newID("prompt")
		prompts[i].RequestID = requestID
		prompts[i].CreatedAt = now
	}

	languageStats := make([]store.LanguageStat, 0, len(languages))
	for _, language := range languages {
		languageStats = append(languageStats, store.LanguageStat{
			ID:         newID("lang"),
			RequestID:  requestID,
			Language:   language.Language,
			Confidence: language.Confidence,
			Evidence:   language.Evidence,
			CreatedAt:  now,
		})
	}

	// The raw body is stored unredacted, and it has to be: replay resends these exact
	// bytes, and a masked body is not a request. Everything else on this path is
	// redacted before storage, so this is the one place a secret in a prompt survives
	// verbatim - measured, not assumed: with the flag on, every one of the redactor's
	// thirteen rule types is recoverable from body_raw. The settings screen says so,
	// and docs/OPERATIONS.md requires disk encryption before enabling it.
	rawBody := ""
	if lc.RawBodies {
		rawBody = string(body)
	}
	llmMeta := llmRequestMetadata(r, body, traceID)
	if llmMeta.SessionID == "" {
		// No explicit session id from the client (the Claude Code / Cursor / Roo /
		// Qwen case). Infer one from client identity + a sliding inactivity window,
		// or fall back to per-request grouping if inference is disabled.
		if s.cfg.Session.InferenceEnabled && s.sessions != nil {
			llmMeta.SessionID = s.inferSessionID(r, apiKeyID, now)
		} else {
			llmMeta.SessionID = "trace:" + traceID
		}
	}
	record := store.LogRecord{
		Request: store.RequestLog{
			ID:                  requestID,
			TraceID:             traceID,
			APIKeyID:            apiKeyID,
			Method:              r.Method,
			ClientIP:            clientIP(r),
			ForwardedFor:        r.Header.Get("X-Forwarded-For"),
			UserAgent:           r.UserAgent(),
			Hostname:            hostname(),
			Model:               model,
			ResolvedModel:       model,
			UpstreamModel:       model,
			Endpoint:            endpoint,
			Stream:              stream,
			Provider:            s.cfg.Upstream.Provider,
			SessionID:           llmMeta.SessionID,
			PromptName:          llmMeta.PromptName,
			PromptVersion:       llmMeta.PromptVersion,
			PromptVariablesHash: llmMeta.PromptVariablesHash,
			ToolCount:           llmMeta.ToolCount,
			Complexity:          complexityScore(prompts, llmMeta.ToolCount),
			TaskType:            classifyTaskType(prompts),
			PromptFingerprint:   promptFingerprint(prompts),
			RequestHash:         audit.HashText(string(body)),
			BodyRaw:             rawBody,
			ReplayOf:            r.Header.Get("X-Proxy-Replay-Of"),
			Repo:                firstNonEmptyHeader(r, "X-Vibe-Repo", "X-Repo"),
			Branch:              firstNonEmptyHeader(r, "X-Vibe-Branch", "X-Branch"),
			Project:             firstNonEmptyHeader(r, "X-Vibe-Project", "X-Project"),
			Service:             firstNonEmptyHeader(r, "X-Vibe-Service", "X-Service"),
			CostCenter:          firstNonEmptyHeader(r, "X-Vibe-Cost-Center", "X-Budget-Code"),
			CreatedAt:           now,
		},
		Prompts:   prompts,
		Languages: languageStats,
	}
	record.Tools = toolInvocations(record.Request, extractRequestTools(body))
	applyReadableIngress(&record.Request, r, body)
	return record
}

// inferSessionID builds a stable client identity and asks the session inferer for
// a sliding-window session id. Identity = api key (or "anon") + client IP +
// user-agent + optional repo/branch project hints, so different tools, machines,
// or working branches map to different sessions while a single client's burst of
// requests groups together.
func (s *Server) inferSessionID(r *http.Request, apiKeyID string, now time.Time) string {
	keyPart := apiKeyID
	if keyPart == "" {
		keyPart = "anon"
	}
	identity := strings.Join([]string{
		keyPart,
		clientIP(r),
		r.UserAgent(),
		firstNonEmptyHeader(r, "X-Vibe-Repo", "X-Repo", "X-Project"),
		firstNonEmptyHeader(r, "X-Vibe-Branch", "X-Branch"),
	}, "|")
	identityHash := audit.HashText(identity)
	if sessionID, ok := s.sessions.existingSession(identity, now); ok {
		s.persistInferredSession(r.Context(), identityHash, sessionID, now)
		return sessionID
	}
	recoveredID, recoveredLastSeen := "", time.Time{}
	if rec, found, err := s.db.InferredSessionByIdentity(r.Context(), identityHash); err == nil && found {
		recoveredID = rec.SessionID
		recoveredLastSeen = rec.LastSeen
	}
	sessionID := s.sessions.sessionForRecovered(identity, now, recoveredID, recoveredLastSeen)
	s.persistInferredSession(r.Context(), identityHash, sessionID, now)
	return sessionID
}

func (s *Server) persistInferredSession(ctx context.Context, identityHash, sessionID string, now time.Time) {
	if identityHash == "" || sessionID == "" || s.db == nil {
		return
	}
	_ = s.db.UpsertInferredSession(ctx, store.InferredSessionRecord{
		IdentityHash: identityHash,
		SessionID:    sessionID,
		LastSeen:     now,
		UpdatedAt:    now,
	})
	idle := s.cfg.Session.IdleTimeout
	if idle <= 0 {
		idle = 30 * time.Minute
	}
	lastUnix := s.sessionGCAt.Load()
	if lastUnix != 0 && now.Sub(time.Unix(lastUnix, 0)) < idle {
		return
	}
	if s.sessionGCAt.CompareAndSwap(lastUnix, now.Unix()) {
		_, _ = s.db.DeleteExpiredInferredSessions(ctx, now.Add(-idle))
	}
}

// extractModel reads just the model name from a request body.
//
// extractAudit returns it too, but on the way it flattens every message and redacts
// each one -- work a caller that only wants the model then throws away. Redaction runs
// the pattern table over the whole prompt, so on a 1 MB body that is not a rounding
// error: the request path was redacting five times its own size, and one of those five
// passes existed only to find a string near the top of the JSON.
func extractModel(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var root struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		return ""
	}
	return root.Model
}

// streamRequested reads just the stream flag, for the same reason extractModel exists.
func streamRequested(body []byte) bool {
	if len(body) == 0 {
		return false
	}
	var root struct {
		Stream bool `json:"stream"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		return false
	}
	return root.Stream
}

// languagesFromPrompts derives the language signals from prompts that were already
// extracted, which is what extractAudit does with them internally.
func languagesFromPrompts(prompts []store.PromptLog) []audit.LanguageSignal {
	if len(prompts) == 0 {
		return nil
	}
	texts := make([]string, 0, len(prompts))
	for _, p := range prompts {
		text := p.RedactedText
		if text == "" {
			text = p.ContentText
		}
		if text != "" {
			texts = append(texts, text)
		}
	}
	return audit.InferLanguages(texts)
}

func extractAudit(body []byte, endpoint string, rawPrompts bool) (string, bool, []store.PromptLog, []audit.LanguageSignal) {
	if len(body) == 0 {
		return "", false, nil, nil
	}
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil {
		return "", false, nil, nil
	}
	model, _ := root["model"].(string)
	stream, _ := root["stream"].(bool)
	texts := []string{}
	prompts := []store.PromptLog{}

	if endpoint == "/v1/chat/completions" {
		if messages, ok := root["messages"].([]any); ok {
			for _, item := range messages {
				message, _ := item.(map[string]any)
				role, _ := message["role"].(string)
				content := flattenContent(message["content"])
				if toolCalls, ok := message["tool_calls"]; ok {
					content = strings.TrimSpace(content + "\n" + jsonString(toolCalls))
				}
				if content == "" {
					continue
				}
				texts = append(texts, content)
				prompts = append(prompts, promptLog(role, content, rawPrompts))
			}
		}
		if tools, ok := root["tools"]; ok {
			content := jsonString(tools)
			if content != "" {
				texts = append(texts, content)
				prompts = append(prompts, promptLog("tools", content, rawPrompts))
			}
		}
	} else if endpoint == "/v1/embeddings" {
		content := flattenContent(root["input"])
		if content != "" {
			texts = append(texts, content)
			prompts = append(prompts, promptLog("input", content, rawPrompts))
		}
	}

	languages := audit.InferLanguages(texts)
	topLanguage := ""
	if len(languages) > 0 {
		topLanguage = languages[0].Language
	}
	for i := range prompts {
		prompts[i].LanguageHint = topLanguage
	}
	return model, stream, prompts, languages
}

func promptLog(role string, content string, rawPrompts bool) store.PromptLog {
	raw := ""
	if rawPrompts {
		raw = content
	}
	return store.PromptLog{
		Role:         firstNonEmpty(role, "unknown"),
		ContentHash:  audit.HashText(content),
		ContentText:  raw,
		RedactedText: audit.Redact(content),
	}
}

func promptTokenEstimate(prompts []store.PromptLog) int {
	total := 0
	for _, prompt := range prompts {
		total += audit.EstimateTokens(prompt.RedactedText)
	}
	return total
}

func flattenContent(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			switch typed := item.(type) {
			case string:
				parts = append(parts, typed)
			case map[string]any:
				if text, ok := typed["text"].(string); ok {
					parts = append(parts, text)
				} else if text, ok := typed["input_text"].(string); ok {
					parts = append(parts, text)
				} else {
					parts = append(parts, jsonString(typed))
				}
			default:
				parts = append(parts, jsonString(typed))
			}
		}
		return strings.Join(parts, "\n")
	default:
		return jsonString(v)
	}
}

func jsonString(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}

func clientIP(r *http.Request) string {
	if value := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); value != "" {
		return value
	}
	if value := strings.TrimSpace(r.Header.Get("X-Real-IP")); value != "" {
		return value
	}
	if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwarded != "" {
		return strings.TrimSpace(strings.Split(forwarded, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil {
		return ""
	}
	return name
}

func copyUpstreamHeaders(dst http.Header, src http.Header) {
	for key, values := range src {
		canonical := http.CanonicalHeaderKey(key)
		if hopByHopHeader(canonical) || canonical == "Authorization" || canonical == "Host" || canonical == "Content-Length" {
			continue
		}
		for _, value := range values {
			dst.Add(canonical, value)
		}
	}
}

func copyDownstreamHeaders(dst http.Header, src http.Header) {
	for key, values := range src {
		canonical := http.CanonicalHeaderKey(key)
		if hopByHopHeader(canonical) || canonical == "Content-Length" {
			continue
		}
		for _, value := range values {
			dst.Add(canonical, value)
		}
	}
}

func hopByHopHeader(key string) bool {
	switch strings.ToLower(key) {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
		return true
	default:
		return false
	}
}

func bearerToken(header string) string {
	const prefix = "bearer "
	if len(header) >= len(prefix) && strings.EqualFold(header[:len(prefix)], prefix) {
		return strings.TrimSpace(header[len(prefix):])
	}
	return ""
}

func traceIDFromRequest(r *http.Request) string {
	if value := strings.TrimSpace(r.Header.Get("X-Request-ID")); value != "" {
		return value
	}
	if value := strings.TrimSpace(r.Header.Get("X-Trace-ID")); value != "" {
		return value
	}
	return newID("trace")
}

func withTrace(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeOpenAIError(w http.ResponseWriter, status int, message string, typ string, code string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    typ,
			"param":   nil,
			"code":    code,
		},
	})
}

func statusForUpstreamError(err error) int {
	if errors.Is(err, context.DeadlineExceeded) {
		return http.StatusGatewayTimeout
	}
	return http.StatusBadGateway
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
