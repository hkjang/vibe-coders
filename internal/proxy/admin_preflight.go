package proxy

import (
	"net/http"
	"strings"
)

// preflightCheck is one deployment-readiness probe.
type preflightCheck struct {
	Name   string `json:"name"`
	Status string `json:"status"` // ok | warn | fail
	Detail string `json:"detail"`
}

// criticalTables must exist for the gateway to operate; their absence means migrations didn't
// run (a bad/partial deploy).
var criticalTables = []string{
	"request_logs", "api_keys", "auth_sessions", "admin_settings", "skills",
	"multi_model_test_runs", "metric_catalog", "change_sets", "work_apps",
}

// handleOpsPreflight runs deployment-readiness checks for air-gapped upgrades: DB reachability,
// critical-table presence (migration applied), OpenAPI validity, and core config. Read-only.
// GET /admin/ops/preflight
func (s *Server) handleOpsPreflight(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	checks := []preflightCheck{}
	worst := "ok"
	add := func(c preflightCheck) {
		checks = append(checks, c)
		if rankPF(c.Status) > rankPF(worst) {
			worst = c.Status
		}
	}

	// 1) DB reachable.
	if err := s.db.Ping(ctx); err != nil {
		add(preflightCheck{"db_reachable", "fail", "DB ping 실패: " + err.Error()})
	} else {
		add(preflightCheck{"db_reachable", "ok", "데이터베이스 연결 정상"})
	}

	// 2) Critical tables (migration applied).
	missing := []string{}
	for _, t := range criticalTables {
		if ok, err := s.db.TableExists(ctx, t); err == nil && !ok {
			missing = append(missing, t)
		}
	}
	if len(missing) > 0 {
		add(preflightCheck{"migrations", "fail", "누락된 테이블(마이그레이션 미적용): " + strings.Join(missing, ", ")})
	} else {
		add(preflightCheck{"migrations", "ok", itoaProxy(len(criticalTables)) + "개 핵심 테이블 존재"})
	}

	// 3) OpenAPI spec valid.
	spec := buildOpenAPISpec()
	paths, _ := spec["paths"].(map[string]any)
	if len(paths) == 0 {
		add(preflightCheck{"openapi", "fail", "OpenAPI 스펙에 paths가 없습니다"})
	} else {
		add(preflightCheck{"openapi", "ok", itoaProxy(len(paths)) + "개 경로"})
	}

	// 4) Upstream configured.
	if strings.TrimSpace(s.cfg.Upstream.BaseURL) == "" {
		add(preflightCheck{"upstream", "warn", "기본 업스트림 BaseURL 미설정(프로바이더 DB 설정으로 대체 가능)"})
	} else {
		add(preflightCheck{"upstream", "ok", "업스트림: " + s.cfg.Upstream.BaseURL})
	}

	// 5) Secret cipher present (for at-rest encryption).
	if s.secrets.Load() == nil {
		add(preflightCheck{"secret_cipher", "fail", "secret cipher 미초기화 — 암호화 저장 불가"})
	} else {
		add(preflightCheck{"secret_cipher", "ok", "AES-GCM cipher 초기화됨"})
	}

	// 6) Auth secret set when auth is enabled.
	if s.cfg.Auth.Enabled && strings.TrimSpace(s.cfg.Auth.JWTSecret) == "" {
		add(preflightCheck{"auth_secret", "fail", "Auth 활성화 상태에서 JWT secret 미설정"})
	} else {
		add(preflightCheck{"auth_secret", "ok", "인증 시크릿 구성 정상"})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"version": AppVersion, "overall": worst, "checks": checks,
		"note": "폐쇄망 배포 전/후 점검용 읽기 전용 프리플라이트. fail이 있으면 배포를 보류하거나 롤백을 검토하세요.",
	})
}

func rankPF(s string) int {
	switch s {
	case "fail":
		return 3
	case "warn":
		return 2
	case "ok":
		return 1
	}
	return 0
}
