package proxy

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"vibe-coders/internal/store"
)

func (s *Server) handleUsers(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	users, err := s.db.ListUsers(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "users_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

func (s *Server) handleTeams(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	teams, err := s.db.ListTeams(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "teams_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"teams": teams})
}

func (s *Server) handleTeamDetail(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	team := strings.TrimPrefix(r.URL.Path, "/admin/teams/")
	if team == "" || strings.Contains(team, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid team", "invalid_request_error", "invalid_team")
		return
	}
	detail, err := s.db.GetTeamDetail(r.Context(), team, recentLimit(r))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "team not found", "invalid_request_error", "team_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "team_detail_failed")
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) handleUserDetail(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/users/")
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid user id", "invalid_request_error", "invalid_user_id")
		return
	}
	detail, err := s.db.GetUserDetail(r.Context(), id, recentLimit(r))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "user not found", "invalid_request_error", "user_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "user_detail_failed")
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) handleIPs(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ips, err := s.db.ListIPs(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "ips_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ips": ips})
}

func (s *Server) handleIPDetail(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ip := strings.TrimPrefix(r.URL.Path, "/admin/ips/")
	if ip == "" || strings.Contains(ip, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid ip", "invalid_request_error", "invalid_ip")
		return
	}
	detail, err := s.db.GetIPDetail(r.Context(), ip, recentLimit(r))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "ip not found", "invalid_request_error", "ip_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "ip_detail_failed")
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) handleRequestDetail(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/admin/requests/")
	if rest == "diff" {
		s.handleRequestDiff(w, r)
		return
	}
	if idx := strings.Index(rest, "/"); idx >= 0 {
		sub := rest[idx+1:]
		switch sub {
		case "note":
			s.handleRequestNote(w, r)
			return
		case "replay":
			s.handleRequestReplay(w, r)
			return
		case "analyze":
			s.handleRequestAnalyze(w, r)
			return
		case "explain":
			s.handleRequestExplain(w, r)
			return
		}
		writeOpenAIError(w, http.StatusNotFound, "not found", "invalid_request_error", "not_found")
		return
	}
	id := rest
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid request id", "invalid_request_error", "invalid_request_id")
		return
	}
	detail, err := s.db.RequestDetail(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "request_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "request_detail_failed")
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) handleRequestAnalyze(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/admin/requests/")
	idx := strings.Index(rest, "/")
	if idx <= 0 {
		writeOpenAIError(w, http.StatusBadRequest, "invalid request id", "invalid_request_error", "invalid_request_id")
		return
	}
	id := rest[:idx]

	detail, err := s.db.RequestDetail(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "request_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "request_detail_failed")
		return
	}

	var sb strings.Builder
	sb.WriteString("Analyze and summarize the following LLM Request & Response details. Format your response in Markdown (Korean language). Be concise and provide a 3-line summary of 1) User Intent, 2) Performed task/result, 3) Specific errors or warnings (if any).\n\n")
	sb.WriteString(fmt.Sprintf("## Metadata\n- Request ID: %s\n- Model: %s\n- Endpoint: %s\n- Status Code: %d\n", detail.Request.ID, detail.Request.Model, detail.Request.Endpoint, detail.Request.StatusCode))
	if detail.Request.Error != "" {
		sb.WriteString(fmt.Sprintf("- Error: %s\n", detail.Request.Error))
	}
	sb.WriteString("\n## Prompts (Conversations)\n")
	for _, p := range detail.Prompts {
		sb.WriteString(fmt.Sprintf("### Role: %s\n", p.Role))
		sb.WriteString(p.RedactedText)
		sb.WriteString("\n\n")
	}
	if detail.Response != nil && detail.Response.ResponseTextOptional != "" {
		sb.WriteString("## Response\n")
		sb.WriteString(detail.Response.ResponseTextOptional)
		sb.WriteString("\n\n")
	}

	promptToLLM := sb.String()

	provider, err := s.selectProvider(r.Context(), r, "")
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "select default provider failed: "+err.Error(), "server_error", "provider_selection_failed")
		return
	}

	modelName := "gpt-4o-mini"
	if detail.Request.Model != "" {
		modelName = detail.Request.Model
	}

	requestPayload := map[string]any{
		"model": modelName,
		"messages": []map[string]string{
			{
				"role":    "user",
				"content": promptToLLM,
			},
		},
	}

	payloadBytes, err := json.Marshal(requestPayload)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "marshal_payload_failed")
		return
	}

	upstreamURL, err := s.upstreamURL(provider.BaseURL, &url.URL{Path: "/v1/chat/completions"})
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "build_upstream_url_failed")
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstreamURL, bytes.NewReader(payloadBytes))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "create_request_failed")
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+provider.APIKey)

	resp, err := s.client.Do(req)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "upstream call failed: "+err.Error(), "server_error", "upstream_failed")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		writeOpenAIError(w, http.StatusBadGateway, fmt.Sprintf("upstream returned status %d: %s", resp.StatusCode, string(bodyBytes)), "server_error", "upstream_error")
		return
	}

	var openAIResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&openAIResp); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "decode upstream response failed: "+err.Error(), "server_error", "decode_failed")
		return
	}

	if len(openAIResp.Choices) == 0 {
		writeOpenAIError(w, http.StatusInternalServerError, "empty choices from upstream", "server_error", "empty_choices")
		return
	}

	analysisResult := openAIResp.Choices[0].Message.Content
	writeJSON(w, http.StatusOK, map[string]string{"analysis": analysisResult})
}

func (s *Server) handlePromptSearch(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	q := store.PromptSearch{
		Keyword:  strings.TrimSpace(r.URL.Query().Get("q")),
		APIKeyID: strings.TrimSpace(r.URL.Query().Get("api_key_id")),
		IP:       strings.TrimSpace(r.URL.Query().Get("ip")),
		Language: strings.TrimSpace(r.URL.Query().Get("language")),
		Since:    strings.TrimSpace(r.URL.Query().Get("since")),
		Limit:    recentLimit(r),
	}
	results, err := s.db.SearchPrompts(r.Context(), q)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "prompt_search_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": results})
}

func recentLimit(r *http.Request) int {
	value := strings.TrimSpace(r.URL.Query().Get("limit"))
	if value == "" {
		return 50
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 50
	}
	if parsed > 200 {
		return 200
	}
	return parsed
}
