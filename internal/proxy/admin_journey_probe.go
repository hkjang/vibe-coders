package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
)

// Journey Probe — per-dev-tool synthetic health checks. Beyond /health, this replays the
// request journey each client actually performs (models list, MCP initialize/tools-list) using
// a supplied probe key, so operators can tell "the server is up but Cursor can't connect" apart.
// Read-only and cost-free: it does NOT make live chat/upstream calls.

// journeyDefs maps a client tool to the ordered steps its connection depends on.
var journeyDefs = map[string][]string{
	"openai-sdk":         {"models"},
	"cursor":             {"models"},
	"continue":           {"models"},
	"roo":                {"models", "mcp_init", "mcp_tools"},
	"cline":              {"models", "mcp_init", "mcp_tools"},
	"claude-desktop-mcp": {"mcp_init", "mcp_tools"},
}

// handleJourneyProbe runs the synthetic journeys for the requested clients (default: all) using
// a supplied Proxy API Key. POST /admin/journey-probe {proxy_key, clients?[]}
func (s *Server) handleJourneyProbe(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	var p struct {
		ProxyKey string   `json:"proxy_key"`
		Clients  []string `json:"clients"`
	}
	_ = json.Unmarshal(body, &p)
	probeKey := strings.TrimSpace(p.ProxyKey)
	if probeKey == "" {
		writeOpenAIError(w, http.StatusBadRequest, "proxy_key required (a Proxy API Key to probe as)", "invalid_request_error", "missing_key")
		return
	}

	// Authenticate the probe key via a synthetic request carrying it; reuse the live replay.
	synth := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	synth = synth.WithContext(r.Context())
	synth.Header.Set("Authorization", "Bearer "+probeKey)
	synth.RemoteAddr = r.RemoteAddr
	keyID, authCtx, ok := s.authenticateProxyContext(synth)

	clients := p.Clients
	if len(clients) == 0 {
		for c := range journeyDefs {
			clients = append(clients, c)
		}
		sort.Strings(clients)
	}

	results := []map[string]any{}
	passing, failing := 0, 0
	for _, c := range clients {
		client := strings.ToLower(strings.TrimSpace(c))
		steps, known := journeyDefs[client]
		checks := []doctorCheck{}
		overall := "pass"
		bump := func(ch doctorCheck) {
			checks = append(checks, ch)
			if doctorRank(ch.Status) > doctorRank(overall) {
				overall = ch.Status
			}
		}
		if !known {
			bump(doctorCheck{"client", "warn", "알 수 없는 클라이언트 — 기본 journey(models)로 점검합니다.", ""})
			steps = []string{"models"}
		}
		if !ok || authCtx == nil {
			bump(doctorCheck{"authorization", "fail", "Proxy API Key 인증 실패.", "유효한 활성 Proxy API Key를 입력하세요."})
		} else {
			bump(doctorCheck{"authorization", "pass", "Proxy API Key 인증 성공.", ""})
			for _, step := range steps {
				switch step {
				case "models":
					bump(s.doctorProbe(synth, http.MethodGet, "/v1/models", "models", "/v1/models 응답 정상.", "업스트림/프로바이더 설정과 네트워크를 확인하세요."))
				case "mcp_init":
					bump(s.doctorMCP(synth, keyID, authCtx, "initialize", "mcp_initialize"))
				case "mcp_tools":
					bump(s.doctorMCP(synth, keyID, authCtx, "tools/list", "mcp_tools_list"))
				}
			}
		}
		if overall == "fail" {
			failing++
		} else {
			passing++
		}
		results = append(results, map[string]any{"client": client, "overall": overall, "checks": checks})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"results": results,
		"summary": map[string]int{"clients": len(results), "passing": passing, "failing": failing},
		"note":    "각 개발도구의 실제 연결 journey(모델 목록·MCP initialize/tools-list)를 supplied Proxy API Key로 합성 점검합니다. 비용 발생 실제 chat 호출은 하지 않습니다.",
	})
}
