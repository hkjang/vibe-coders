package proxy

import (
	"net/http"
	"strings"
)

// handlePromptAssets serves the unified prompt asset library.
// GET /admin/prompt-assets?status=&tag=&category=&q=
func (s *Server) handlePromptAssets(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	statusFilter   := strings.TrimSpace(r.URL.Query().Get("status"))
	tagFilter      := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("tag")))
	categoryFilter := strings.TrimSpace(r.URL.Query().Get("category"))
	q              := strings.TrimSpace(r.URL.Query().Get("q"))

	assets, err := s.db.ListPromptAssets(r.Context(), statusFilter, tagFilter, categoryFilter, q)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "prompt_assets_failed")
		return
	}
	stats, err := s.db.PromptAssetStats(r.Context())
	if err != nil {
		stats = map[string]int64{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"assets":     assets,
		"stats":      stats,
		"categories": templateCategoryList(),
		"known_tags": knownAssetTags(),
	})
}

func knownAssetTags() []map[string]string {
	return []map[string]string{
		{"key": "java",       "label": "Java"},
		{"key": "go",        "label": "Go"},
		{"key": "python",    "label": "Python"},
		{"key": "javascript","label": "JavaScript"},
		{"key": "typescript","label": "TypeScript"},
		{"key": "sql",       "label": "SQL"},
		{"key": "rust",      "label": "Rust"},
		{"key": "kotlin",    "label": "Kotlin"},
		{"key": "csharp",    "label": "C#"},
		{"key": "security",  "label": "보안"},
		{"key": "test",      "label": "테스트"},
		{"key": "docs",      "label": "문서화"},
		{"key": "refactor",  "label": "리팩토링"},
		{"key": "review",    "label": "코드리뷰"},
		{"key": "debug",     "label": "디버깅"},
		{"key": "policy",    "label": "사규"},
		{"key": "legal",     "label": "법규"},
		{"key": "compliance","label": "컴플라이언스"},
		{"key": "general",   "label": "일반"},
	}
}
