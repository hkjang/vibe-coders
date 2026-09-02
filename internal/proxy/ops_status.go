package proxy

import (
	"context"
	"net/http"
	"path/filepath"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// opsStatusWindow is how far back provider health is summarised for the ops view.
const opsStatusWindow = time.Hour

// OpsStatus is the operational health snapshot powering the dashboard's
// "운영 상태" panel: provider status, audit-log drop/backlog pressure, fallback
// adequacy, security configuration risk, and disk headroom.
type OpsStatus struct {
	GeneratedAt     string                      `json:"generated_at"`
	Providers       []store.ProviderHealthScore `json:"providers"`
	Logging         OpsLoggingStatus            `json:"logging"`
	Fallback        OpsFallbackStatus           `json:"fallback"`
	Security        OpsSecurityStatus           `json:"security"`
	Disk            OpsDiskStatus               `json:"disk"`
	PartialFailures []OpsStatusPartialFailure   `json:"partial_failures,omitempty"`
}

// OpsStatusPartialFailure distinguishes unavailable operational data from a
// valid empty result. Messages intentionally omit internal database/filesystem
// errors; operators can act on the stable component and code without exposing
// sensitive implementation details in the API response.
type OpsStatusPartialFailure struct {
	Component string `json:"component"`
	Code      string `json:"code"`
	Message   string `json:"message"`
}

// OpsLoggingStatus surfaces async audit-log queue pressure. Dropped > 0 means the
// gateway shed audit records because the queue was saturated — a data-loss signal.
type OpsLoggingStatus struct {
	QueueDepth int    `json:"queue_depth"`
	Written    uint64 `json:"written"`
	Dropped    uint64 `json:"dropped"`
}

// OpsFallbackStatus reflects the fallback NDJSON backlog (records written to disk
// because the DB was unavailable and not yet replayed into the database).
type OpsFallbackStatus struct {
	Path       string `json:"path"`
	Exists     bool   `json:"exists"`
	Lines      int64  `json:"lines"`
	Bytes      int64  `json:"bytes"`
	ModifiedAt string `json:"modified_at"`
}

// OpsSecurityStatus captures security-relevant configuration that should be
// hardened before production exposure.
type OpsSecurityStatus struct {
	AuthEnabled       bool `json:"auth_enabled"`
	DevSecret         bool `json:"dev_secret"`
	RawPromptsLogged  bool `json:"raw_prompts_logged"`
	RawBodiesLogged   bool `json:"raw_bodies_logged"`
	PricingConfigured bool `json:"pricing_configured"`
}

// OpsDiskStatus reports free space on the volume holding the gateway's data
// directory. Available is false when the platform free-space call failed.
type OpsDiskStatus struct {
	Path        string  `json:"path"`
	Available   bool    `json:"available"`
	FreeBytes   uint64  `json:"free_bytes"`
	TotalBytes  uint64  `json:"total_bytes"`
	UsedPercent float64 `json:"used_percent"`
}

// dataDir returns the directory the gateway persists local state into, used for
// the disk-headroom check. It prefers the fallback NDJSON location (always local),
// then the SQLite DB path, then the working directory.
func (s *Server) dataDir(fallbackPath string) string {
	if fallbackPath != "" {
		return filepath.Dir(fallbackPath)
	}
	if s.cfg.Database.Driver == "sqlite" && s.cfg.Database.DSN != "" {
		return filepath.Dir(s.cfg.Database.DSN)
	}
	return "."
}

// opsStatusSnapshot assembles the current operational status.
func (s *Server) opsStatusSnapshot(ctx context.Context) OpsStatus {
	var partialFailures []OpsStatusPartialFailure
	scores, err := s.db.ProviderHealthScores(ctx, time.Now().Add(-opsStatusWindow))
	if err != nil {
		partialFailures = append(partialFailures, OpsStatusPartialFailure{
			Component: "providers",
			Code:      "provider_health_unavailable",
			Message:   "Provider health data is temporarily unavailable.",
		})
	}
	if scores == nil {
		scores = []store.ProviderHealthScore{}
	}
	scores = boundedProviderHealthScores(scores, nil)

	fb, err := s.logger.FallbackStats()
	if err != nil {
		partialFailures = append(partialFailures, OpsStatusPartialFailure{
			Component: "fallback",
			Code:      "fallback_stats_unavailable",
			Message:   "Fallback log statistics are temporarily unavailable.",
		})
	}

	status := OpsStatus{
		GeneratedAt:     time.Now().UTC().Format(time.RFC3339),
		Providers:       scores,
		PartialFailures: partialFailures,
		Logging: OpsLoggingStatus{
			QueueDepth: s.logger.QueueDepth(),
			Written:    s.logger.Written(),
			Dropped:    s.logger.Dropped(),
		},
		Fallback: OpsFallbackStatus{
			Path:       fb.Path,
			Exists:     fb.Exists,
			Lines:      fb.Lines,
			Bytes:      fb.Bytes,
			ModifiedAt: fb.ModifiedAt,
		},
		Security: OpsSecurityStatus{
			AuthEnabled:       s.cfg.Auth.Enabled,
			DevSecret:         s.cfg.Secret.GatewaySecret == config.DefaultGatewaySecret,
			RawPromptsLogged:  s.loggingConf().RawPrompts,
			RawBodiesLogged:   s.loggingConf().RawBodies,
			PricingConfigured: len(s.pricingMap(ctx)) > 0,
		},
	}

	dir := s.dataDir(fb.Path)
	free, total, ok := diskUsage(dir)
	status.Disk = OpsDiskStatus{Path: dir, Available: ok, FreeBytes: free, TotalBytes: total}
	if ok && total > 0 {
		status.Disk.UsedPercent = float64(total-free) / float64(total) * 100
	}

	return status
}

// OpsRiskFactor is one contributor to the overall operational risk score.
type OpsRiskFactor struct {
	Key      string `json:"key"`
	Points   int    `json:"points"`
	Severity string `json:"severity"` // info | warning | critical
	Message  string `json:"message"`
}

// OpsRisk is a single operational-readiness risk score (0-100, higher = worse)
// rolled up from the configuration, logging, fallback, disk, and provider-health
// signals in the ops status snapshot.
type OpsRisk struct {
	Score   int             `json:"score"`
	Tier    string          `json:"tier"` // low | medium | high | critical
	Factors []OpsRiskFactor `json:"factors"`
}

// opsRiskScore rolls the ops status snapshot up into a single risk score with a
// per-factor breakdown so operators see both the headline number and the why.
func opsRiskScore(status OpsStatus) OpsRisk {
	factors := []OpsRiskFactor{}
	score := 0
	add := func(key, severity, msg string, points int) {
		factors = append(factors, OpsRiskFactor{Key: key, Points: points, Severity: severity, Message: msg})
		score += points
	}

	if !status.Security.AuthEnabled {
		add("auth_disabled", "warning", "인증(AUTH_ENABLED)이 꺼져 있습니다.", 20)
	}
	if status.Security.DevSecret {
		add("dev_secret", "critical", "개발용 기본 GATEWAY_SECRET을 사용 중입니다.", 25)
	}
	if !status.Security.PricingConfigured {
		add("pricing_missing", "warning", "모델 가격표가 설정되지 않아 비용 추적이 불가합니다.", 15)
	}
	if status.Security.RawPromptsLogged {
		add("raw_prompts", "warning", "원문 프롬프트가 저장되고 있습니다(LOG_RAW_PROMPTS).", 10)
	}
	if status.Security.RawBodiesLogged {
		add("raw_bodies", "info", "원본 요청 body가 저장되고 있습니다(LOG_RAW_BODIES).", 5)
	}
	if status.Logging.Dropped > 0 {
		pts := 10
		if status.Logging.Dropped > 1000 {
			pts = 20
		}
		add("log_drops", "critical", fmtCount(status.Logging.Dropped)+"건의 감사 로그가 드롭되었습니다(큐 포화).", pts)
	}
	if status.Fallback.Exists && status.Fallback.Lines > 0 {
		pts := 10
		if status.Fallback.Lines > 1000 {
			pts = 20
		}
		add("fallback_backlog", "warning", "Fallback NDJSON에 "+itoaProxy(int(status.Fallback.Lines))+"줄이 미처리 상태입니다.", pts)
	}
	if !status.Disk.Available {
		add("disk_usage_unavailable", "warning", "데이터 디스크 사용량을 확인할 수 없습니다.", 15)
	} else if status.Disk.UsedPercent >= 90 {
		add("disk_low", "critical", "데이터 디스크 사용률이 90%를 넘었습니다.", 20)
	} else if status.Disk.UsedPercent >= 80 {
		add("disk_warning", "warning", "데이터 디스크 사용률이 80%를 넘었습니다.", 10)
	}
	for _, p := range status.Providers {
		if p.Requests > 0 && p.Score < providerHealthDefaultThreshold {
			add("provider_degraded", "warning", "Provider "+p.Provider+"의 health 점수가 임계값보다 낮습니다("+itoaProxy(p.Score)+").", 15)
			break
		}
	}
	for _, failure := range status.PartialFailures {
		switch failure.Code {
		case "provider_health_unavailable":
			add("provider_health_unavailable", "warning", "Provider 상태 데이터를 조회할 수 없습니다.", 15)
		case "fallback_stats_unavailable":
			add("fallback_stats_unavailable", "warning", "Fallback 로그 통계를 조회할 수 없습니다.", 10)
		}
	}

	if score > 100 {
		score = 100
	}
	return OpsRisk{Score: score, Tier: opsRiskTier(score), Factors: factors}
}

func opsRiskTier(score int) string {
	switch {
	case score >= 60:
		return "critical"
	case score >= 35:
		return "high"
	case score >= 15:
		return "medium"
	default:
		return "low"
	}
}

// fmtCount renders a count for risk-factor messages.
func fmtCount(n uint64) string {
	return itoaProxy(int(n))
}

// OpsRiskResponse embeds the exact status snapshot used to calculate Risk. API
// clients can consume this response alone instead of issuing a duplicate
// /admin/ops/status request for the same render.
type OpsRiskResponse struct {
	Risk   OpsRisk   `json:"risk"`
	Status OpsStatus `json:"status"`
}

func buildOpsRiskResponse(status OpsStatus) OpsRiskResponse {
	return OpsRiskResponse{Risk: opsRiskScore(status), Status: status}
}

func (s *Server) handleOpsRisk(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	status := s.opsStatusSnapshot(r.Context())
	writeJSON(w, http.StatusOK, buildOpsRiskResponse(status))
}

func (s *Server) handleOpsStatus(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.opsStatusSnapshot(r.Context()))
}
