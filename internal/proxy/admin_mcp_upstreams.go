package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

func (s *Server) handleMCPUpstreams(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		list, err := s.db.ListMCPUpstreams(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_upstreams_failed")
			return
		}
		// surface last tool-discovery error per upstream from the cached snapshot
		errs := map[string]string{}
		if snap := s.mcpTools.Load(); snap != nil {
			errs = snap.errors
		}
		writeJSON(w, http.StatusOK, map[string]any{"upstreams": list, "discovery_errors": errs})
	case http.MethodPost:
		var p struct {
			ID               string                     `json:"id"`
			Name             string                     `json:"name"`
			URL              string                     `json:"url"`
			AuthToken        string                     `json:"auth_token"`
			Enabled          *bool                      `json:"enabled"`
			Metadata         *store.MCPUpstreamMetadata `json:"metadata"`
			Description      string                     `json:"description"`
			Domains          []string                   `json:"domains"`
			RiskLevel        string                     `json:"risk_level"`
			AllowedModels    []string                   `json:"allowed_models"`
			DefaultTool      string                     `json:"default_tool"`
			TimeoutMS        int                        `json:"timeout_ms"`
			MaxResults       int                        `json:"max_results"`
			RequiresApproval bool                       `json:"requires_approval"`
			FallbackAllowed  bool                       `json:"fallback_allowed"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		p.Name = strings.TrimSpace(p.Name)
		p.URL = strings.TrimSpace(p.URL)
		if p.Name == "" || p.URL == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name and url are required", "invalid_request_error", "missing_fields")
			return
		}
		if !strings.HasPrefix(p.URL, "http://") && !strings.HasPrefix(p.URL, "https://") {
			writeOpenAIError(w, http.StatusBadRequest, "url must be http(s)", "invalid_request_error", "invalid_url")
			return
		}
		slug := slugify(p.ID)
		if slug == "" {
			slug = slugify(p.Name)
		}
		if slug == "" {
			writeOpenAIError(w, http.StatusBadRequest, "could not derive a slug id", "invalid_request_error", "invalid_slug")
			return
		}
		existing, existingFound, err := s.db.GetMCPUpstream(r.Context(), slug)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, "failed to load MCP upstream", "server_error", "mcp_upstream_lookup_failed")
			return
		}
		if code, message := validateMCPUpstreamName(p.Name, existing.Name, existingFound); code != "" {
			writeOpenAIError(w, http.StatusBadRequest, message, "invalid_request_error", code)
			return
		}
		encAuth := ""
		if strings.TrimSpace(p.AuthToken) != "" {
			enc, err := s.secrets.Load().Encrypt(strings.TrimSpace(p.AuthToken))
			if err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "encrypt_failed")
				return
			}
			encAuth = enc
		}
		enabled := true
		if p.Enabled != nil {
			enabled = *p.Enabled
		}
		meta := mcpMetadataFromPayload(p.Metadata, p.Description, p.Domains, p.RiskLevel, p.AllowedModels, p.DefaultTool, p.TimeoutMS, p.MaxResults, p.RequiresApproval, p.FallbackAllowed)
		up := store.MCPUpstream{ID: slug, Name: p.Name, URL: p.URL, EncryptedAuth: encAuth, Enabled: enabled, Metadata: meta}
		// Onboarding gate: an enabled (active) upstream must pass the readiness checklist —
		// notably a high/critical-risk server needs requires_approval. Disabled drafts bypass.
		// Override with ?force=1.
		if enabled && r.URL.Query().Get("force") != "1" {
			if ready, checks := mcpOnboardingChecklist(up); !ready {
				failed := []onboardingCheck{}
				for _, c := range checks {
					if c.Severity == "required" && !c.OK {
						failed = append(failed, c)
					}
				}
				s.auditAdmin(r, "mcp_upstream.enable_blocked", slug, auditJSON(map[string]any{"failed": failed}))
				writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
					"error":  map[string]any{"message": "활성화 전 온보딩 필수 항목이 충족되지 않았습니다.", "type": "invalid_request_error", "code": "onboarding_incomplete"},
					"failed": failed,
					"checks": checks,
					"hint":   "필수 항목(name·url, 고위험은 requires_approval)을 채우거나 enabled=false로 등록하세요. 강제하려면 ?force=1.",
				})
				return
			}
		}
		if err := s.db.UpsertMCPUpstream(r.Context(), up); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_upstream_save_failed")
			return
		}
		s.resetMCPUpstream(slug)
		s.auditAdmin(r, "mcp_upstream.upsert", "", auditJSON(map[string]any{"id": slug, "name": up.Name, "url": up.URL, "enabled": enabled, "auth": encAuth != ""}))
		writeJSON(w, http.StatusCreated, map[string]any{"upstream": map[string]any{"id": slug, "name": up.Name, "url": up.URL, "enabled": enabled, "has_auth": encAuth != "", "metadata": up.Metadata}})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleMCPUpstreamByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/admin/mcp/upstreams/")
	// support a /probe sub-path: GET /admin/mcp/upstreams/{id}/probe → live discovery
	if id, rest, ok := strings.Cut(path, "/"); ok {
		if rest == "probe" && r.Method == http.MethodGet {
			s.handleMCPUpstreamProbe(w, r, id)
			return
		}
		if rest == "flow" && r.Method == http.MethodGet {
			s.handleMCPUpstreamFlow(w, r)
			return
		}
		writeOpenAIError(w, http.StatusBadRequest, "invalid upstream path", "invalid_request_error", "invalid_upstream_path")
		return
	}
	id := path
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid upstream id", "invalid_request_error", "invalid_upstream_id")
		return
	}
	switch r.Method {
	case http.MethodDelete:
		if err := s.db.DeleteMCPUpstream(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_upstream_delete_failed")
			return
		}
		s.resetMCPUpstream(id)
		s.auditAdmin(r, "mcp_upstream.delete", auditJSON(map[string]string{"id": id}), "")
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	case http.MethodPatch:
		cur, found, err := s.db.GetMCPUpstream(r.Context(), id)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_upstream_lookup_failed")
			return
		}
		if !found {
			writeOpenAIError(w, http.StatusNotFound, "upstream not found", "invalid_request_error", "upstream_not_found")
			return
		}
		legacyName := cur.Name
		var p struct {
			Name             *string                    `json:"name"`
			URL              *string                    `json:"url"`
			AuthToken        *string                    `json:"auth_token"`
			Enabled          *bool                      `json:"enabled"`
			Metadata         *store.MCPUpstreamMetadata `json:"metadata"`
			Description      *string                    `json:"description"`
			Domains          []string                   `json:"domains"`
			RiskLevel        *string                    `json:"risk_level"`
			AllowedModels    []string                   `json:"allowed_models"`
			DefaultTool      *string                    `json:"default_tool"`
			TimeoutMS        *int                       `json:"timeout_ms"`
			MaxResults       *int                       `json:"max_results"`
			RequiresApproval *bool                      `json:"requires_approval"`
			FallbackAllowed  *bool                      `json:"fallback_allowed"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if p.Name != nil {
			cur.Name = strings.TrimSpace(*p.Name)
		}
		if code, message := validateMCPUpstreamName(cur.Name, legacyName, true); code != "" {
			writeOpenAIError(w, http.StatusBadRequest, message, "invalid_request_error", code)
			return
		}
		if p.URL != nil {
			cur.URL = strings.TrimSpace(*p.URL)
		}
		if p.Enabled != nil {
			cur.Enabled = *p.Enabled
		}
		if p.AuthToken != nil {
			if strings.TrimSpace(*p.AuthToken) == "" {
				cur.EncryptedAuth = ""
			} else {
				enc, eerr := s.secrets.Load().Encrypt(strings.TrimSpace(*p.AuthToken))
				if eerr != nil {
					writeOpenAIError(w, http.StatusInternalServerError, eerr.Error(), "server_error", "encrypt_failed")
					return
				}
				cur.EncryptedAuth = enc
			}
		}
		if p.Metadata != nil {
			cur.Metadata = *p.Metadata
			cur.MetadataJSON = ""
		} else {
			patchMCPMetadata(&cur.Metadata, p.Description, p.Domains, p.RiskLevel, p.AllowedModels, p.DefaultTool, p.TimeoutMS, p.MaxResults, p.RequiresApproval, p.FallbackAllowed)
			cur.MetadataJSON = ""
		}
		if err := s.db.UpsertMCPUpstream(r.Context(), cur); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_upstream_save_failed")
			return
		}
		s.resetMCPUpstream(id)
		s.auditAdmin(r, "mcp_upstream.update", "", auditJSON(map[string]any{"id": id, "enabled": cur.Enabled}))
		writeJSON(w, http.StatusOK, map[string]any{"upstream": map[string]any{"id": cur.ID, "name": cur.Name, "url": cur.URL, "enabled": cur.Enabled, "has_auth": cur.EncryptedAuth != "", "metadata": cur.Metadata}})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func validateMCPUpstreamName(name, legacyName string, existing bool) (code, message string) {
	name = strings.TrimSpace(name)
	reserved := name == providerNameOmitted
	// Older rows may predate display-name validation. Allow their exact name to be
	// preserved while an operator changes an unrelated field, but do not admit a new
	// unsafe name or let an existing row be renamed to one.
	if existing && name == strings.TrimSpace(legacyName) && (!modelsProviderLabelSafe(name) || reserved) {
		return "", ""
	}
	// Provider-specific names such as "vibe" and "aggregate" are valid MCP display
	// names. Only reserve the shared omission marker that would be indistinguishable
	// from an unsafe legacy-name projection.
	if reserved {
		return "mcp_upstream_name_reserved", "MCP upstream name is reserved"
	}
	if len(name) > maxModelsProviderNameBytes {
		return "mcp_upstream_name_too_long", "MCP upstream name exceeds the supported limit"
	}
	if !modelsProviderLabelSafe(name) {
		return "mcp_upstream_name_invalid", "MCP upstream name contains unsafe metadata"
	}
	return "", ""
}

func mcpMetadataFromPayload(meta *store.MCPUpstreamMetadata, description string, domains []string, riskLevel string, allowedModels []string, defaultTool string, timeoutMS, maxResults int, requiresApproval, fallbackAllowed bool) store.MCPUpstreamMetadata {
	if meta != nil {
		return *meta
	}
	return store.MCPUpstreamMetadata{
		Description:      strings.TrimSpace(description),
		Domains:          domains,
		RiskLevel:        strings.TrimSpace(riskLevel),
		AllowedModels:    allowedModels,
		DefaultTool:      strings.TrimSpace(defaultTool),
		TimeoutMS:        timeoutMS,
		MaxResults:       maxResults,
		RequiresApproval: requiresApproval,
		FallbackAllowed:  fallbackAllowed,
	}
}

func patchMCPMetadata(meta *store.MCPUpstreamMetadata, description *string, domains []string, riskLevel *string, allowedModels []string, defaultTool *string, timeoutMS, maxResults *int, requiresApproval, fallbackAllowed *bool) {
	if description != nil {
		meta.Description = strings.TrimSpace(*description)
	}
	if domains != nil {
		meta.Domains = domains
	}
	if riskLevel != nil {
		meta.RiskLevel = strings.TrimSpace(*riskLevel)
	}
	if allowedModels != nil {
		meta.AllowedModels = allowedModels
	}
	if defaultTool != nil {
		meta.DefaultTool = strings.TrimSpace(*defaultTool)
	}
	if timeoutMS != nil {
		meta.TimeoutMS = *timeoutMS
	}
	if maxResults != nil {
		meta.MaxResults = *maxResults
	}
	if requiresApproval != nil {
		meta.RequiresApproval = *requiresApproval
	}
	if fallbackAllowed != nil {
		meta.FallbackAllowed = *fallbackAllowed
	}
}

// resetMCPUpstream drops cached session + tool catalog so a change takes effect now.
func (s *Server) resetMCPUpstream(id string) {
	s.mcpConns.Delete(id)
	s.invalidateMCPToolsCache()
}

// handleMCPUpstreamProbe live-queries one upstream (fresh handshake) and reports
// the discovered tools/resources/prompts or the connection error — the "is this
// registration working, and what does it expose?" check.
func (s *Server) handleMCPUpstreamProbe(w http.ResponseWriter, r *http.Request, id string) {
	up, found, err := s.db.GetMCPUpstream(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_upstream_lookup_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "upstream not found", "invalid_request_error", "upstream_not_found")
		return
	}
	s.mcpConns.Delete(id) // force a fresh initialize handshake

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	start := time.Now()

	out := map[string]any{"id": up.ID, "name": up.Name, "url": up.URL}
	errs := map[string]string{}
	resourceCount := 0
	promptCount := 0

	tools, terr := s.listUpstreamTools(ctx, up)
	if terr != nil {
		errs["tools"] = terr.Error()
	}
	toolNames := make([]map[string]string, 0, len(tools))
	for _, t := range tools {
		toolNames = append(toolNames, map[string]string{"name": t.Name, "namespaced": up.ID + "__" + t.Name, "description": t.Description})
	}
	out["tools"] = toolNames
	out["tool_count"] = len(tools)

	if resources, rerr := s.listUpstreamResources(ctx, up); rerr == nil {
		res := make([]map[string]string, 0, len(resources))
		for _, rsc := range resources {
			res = append(res, map[string]string{"uri": rsc.URI, "name": rsc.Name})
		}
		out["resources"] = res
		out["resource_count"] = len(resources)
		resourceCount = len(resources)
	} else {
		errs["resources"] = rerr.Error()
	}

	if prompts, perr := s.listUpstreamPrompts(ctx, up); perr == nil {
		pr := make([]map[string]string, 0, len(prompts))
		for _, p := range prompts {
			pr = append(pr, map[string]string{"name": p.Name, "namespaced": up.ID + "__" + p.Name})
		}
		out["prompts"] = pr
		out["prompt_count"] = len(prompts)
		promptCount = len(prompts)
	} else {
		errs["prompts"] = perr.Error()
	}

	out["ok"] = terr == nil // tools is the primary capability
	out["errors"] = errs
	status := "ok"
	errText := ""
	if terr != nil {
		status = "error"
		errText = terr.Error()
	}
	_ = s.db.InsertMCPDiscoveryRun(r.Context(), store.MCPDiscoveryRun{
		ID:            newID("mdr"),
		UpstreamID:    up.ID,
		UpstreamName:  up.Name,
		Status:        status,
		ToolCount:     len(tools),
		PromptCount:   promptCount,
		ResourceCount: resourceCount,
		Error:         errText,
		LatencyMS:     time.Since(start).Milliseconds(),
		CreatedAt:     time.Now().UTC(),
	})
	// a successful probe means the global catalog should be refreshed
	if terr == nil {
		s.invalidateMCPToolsCache()
	}
	writeJSON(w, http.StatusOK, out)
}
