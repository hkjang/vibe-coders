package proxy

import (
	"errors"
	"net/http"
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
