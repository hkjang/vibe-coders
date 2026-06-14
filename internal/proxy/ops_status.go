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
	GeneratedAt string                      `json:"generated_at"`
	Providers   []store.ProviderHealthScore `json:"providers"`
	Logging     OpsLoggingStatus            `json:"logging"`
	Fallback    OpsFallbackStatus           `json:"fallback"`
	Security    OpsSecurityStatus           `json:"security"`
	Disk        OpsDiskStatus               `json:"disk"`
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
	scores, err := s.db.ProviderHealthScores(ctx, time.Now().Add(-opsStatusWindow))
	if err != nil || scores == nil {
		scores = []store.ProviderHealthScore{}
	}

	fb, _ := s.logger.FallbackStats()

	status := OpsStatus{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Providers:   scores,
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
			RawPromptsLogged:  s.cfg.Logging.RawPrompts,
			RawBodiesLogged:   s.cfg.Logging.RawBodies,
			PricingConfigured: len(s.cfg.Pricing) > 0,
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
