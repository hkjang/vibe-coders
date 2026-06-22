package proxy

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"vibe-coders/internal/store"
)

var mcpContractRiskLevels = map[string]bool{"low": true, "medium": true, "high": true}

// handleAdminMCPContracts manages the MCP Tool Contract Registry (admin). A contract pins a tool's
// declared input/output schema, risk level, timeout, allowed roles, cost policy and owner so drift
// against the live gateway tool set can be detected.
// GET    /admin/mcp/contracts[?namespace=&enabled=1]   list
// POST   /admin/mcp/contracts                            upsert
// DELETE /admin/mcp/contracts?id=..                      delete
func (s *Server) handleAdminMCPContracts(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	switch r.Method {
	case http.MethodGet:
		items, err := s.db.ListMCPToolContracts(ctx, strings.TrimSpace(r.URL.Query().Get("namespace")), r.URL.Query().Get("enabled") == "1")
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"contracts": items})
	case http.MethodPost:
		var p struct {
			ID           string `json:"id"`
			Namespace    string `json:"namespace"`
			Name         string `json:"name"`
			Title        string `json:"title"`
			Description  string `json:"description"`
			InputSchema  string `json:"input_schema"`
			OutputSchema string `json:"output_schema"`
			RiskLevel    string `json:"risk_level"`
			TimeoutMS    int64  `json:"timeout_ms"`
			AllowedRoles string `json:"allowed_roles"`
			CostPolicy   string `json:"cost_policy"`
			Owner        string `json:"owner"`
			Enabled      *bool  `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if strings.TrimSpace(p.Name) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name is required", "invalid_request_error", "no_name")
			return
		}
		// Validate any provided schema is well-formed JSON so drift checks are meaningful.
		for _, sch := range []string{p.InputSchema, p.OutputSchema} {
			if strings.TrimSpace(sch) != "" && !json.Valid([]byte(sch)) {
				writeOpenAIError(w, http.StatusBadRequest, "input_schema/output_schema must be valid JSON", "invalid_request_error", "bad_schema")
				return
			}
		}
		risk := strings.ToLower(strings.TrimSpace(p.RiskLevel))
		if risk == "" {
			risk = "low"
		}
		if !mcpContractRiskLevels[risk] {
			writeOpenAIError(w, http.StatusBadRequest, "risk_level must be low|medium|high", "invalid_request_error", "bad_risk")
			return
		}
		enabled := true
		if p.Enabled != nil {
			enabled = *p.Enabled
		}
		c := store.MCPToolContract{
			ID:           firstNonEmpty(strings.TrimSpace(p.ID), newID("mtc")),
			Namespace:    firstNonEmpty(strings.TrimSpace(p.Namespace), "gateway"),
			Name:         strings.TrimSpace(p.Name),
			Title:        strings.TrimSpace(p.Title),
			Description:  strings.TrimSpace(p.Description),
			InputSchema:  strings.TrimSpace(p.InputSchema),
			OutputSchema: strings.TrimSpace(p.OutputSchema),
			RiskLevel:    risk,
			TimeoutMS:    p.TimeoutMS,
			AllowedRoles: strings.TrimSpace(p.AllowedRoles),
			CostPolicy:   strings.TrimSpace(p.CostPolicy),
			Owner:        strings.TrimSpace(p.Owner),
			Enabled:      enabled,
			CreatedBy:    adminID(r),
		}
		if err := s.db.UpsertMCPToolContract(ctx, c); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "upsert_failed")
			return
		}
		s.auditAdmin(r, "mcp_tool_contract_upsert", "", auditJSON(map[string]any{"id": c.ID, "namespace": c.Namespace, "name": c.Name, "risk": c.RiskLevel}))
		writeJSON(w, http.StatusOK, map[string]any{"id": c.ID, "ok": true})
	case http.MethodDelete:
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			writeOpenAIError(w, http.StatusBadRequest, "id query param required", "invalid_request_error", "no_id")
			return
		}
		if err := s.db.DeleteMCPToolContract(ctx, id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "delete_failed")
			return
		}
		s.auditAdmin(r, "mcp_tool_contract_delete", id, "")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleAdminMCPContractsValidate detects drift between registered contracts and the tools the
// gateway actually advertises: a contract whose tool is gone (missing), or whose declared input
// schema property set differs from the live one (drift). Gateway-namespace contracts are checked
// against gatewayToolDefs(); other namespaces are reported as not-checkable.
// POST /admin/mcp/contracts/validate {namespace?, contract_id?}
func (s *Server) handleAdminMCPContractsValidate(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		Namespace  string `json:"namespace"`
		ContractID string `json:"contract_id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&p)
	ctx := r.Context()

	// Resolve contracts to validate.
	contracts := []store.MCPToolContract{}
	if id := strings.TrimSpace(p.ContractID); id != "" {
		c, found, err := s.db.GetMCPToolContract(ctx, id)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "lookup_failed")
			return
		}
		if !found {
			writeOpenAIError(w, http.StatusNotFound, "contract not found", "invalid_request_error", "not_found")
			return
		}
		contracts = append(contracts, c)
	} else {
		all, err := s.db.ListMCPToolContracts(ctx, strings.TrimSpace(p.Namespace), false)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		contracts = all
	}

	// Live gateway tools: name -> input-schema property key set.
	live := map[string][]string{}
	for _, t := range gatewayToolDefs() {
		live[t.Name] = schemaPropKeys(string(t.InputSchema))
	}

	results := make([]map[string]any, 0, len(contracts))
	driftCount, missingCount := 0, 0
	for _, c := range contracts {
		res := map[string]any{"contract_id": c.ID, "namespace": c.Namespace, "name": c.Name, "risk_level": c.RiskLevel}
		if c.Namespace != "gateway" {
			res["status"] = "not_checkable"
			res["detail"] = "기본 게이트웨이 tool 집합 외 namespace는 자동 비교 대상이 아닙니다."
			results = append(results, res)
			continue
		}
		liveKeys, ok := live[c.Name]
		if !ok {
			missingCount++
			res["status"] = "missing"
			res["detail"] = "게이트웨이가 더 이상 이 tool을 노출하지 않습니다(이름 변경/삭제)."
			results = append(results, res)
			continue
		}
		declared := schemaPropKeys(c.InputSchema)
		declaredOnly := diffKeys(declared, liveKeys)
		liveOnly := diffKeys(liveKeys, declared)
		if len(declaredOnly) == 0 && len(liveOnly) == 0 {
			res["status"] = "ok"
		} else {
			driftCount++
			res["status"] = "drift"
			res["declared_only"] = declaredOnly // in contract, not live
			res["live_only"] = liveOnly         // live advertises, not in contract
			res["detail"] = "선언된 입력 스키마와 실제 노출 스키마의 속성이 다릅니다."
		}
		results = append(results, res)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"checked":       len(contracts),
		"drift_count":   driftCount,
		"missing_count": missingCount,
		"results":       results,
		"note":          "스키마 속성 키 집합을 비교합니다(타입 심층 비교 아님). drift/missing 항목의 계약을 갱신하세요.",
	})
}

// schemaPropKeys extracts the top-level properties object's keys from a JSON-schema text. Returns a
// sorted slice; empty/invalid schema yields nil.
func schemaPropKeys(schema string) []string {
	if strings.TrimSpace(schema) == "" {
		return nil
	}
	var parsed struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal([]byte(schema), &parsed); err != nil {
		return nil
	}
	keys := make([]string, 0, len(parsed.Properties))
	for k := range parsed.Properties {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// diffKeys returns keys present in a but not in b.
func diffKeys(a, b []string) []string {
	set := map[string]bool{}
	for _, k := range b {
		set[k] = true
	}
	out := []string{}
	for _, k := range a {
		if !set[k] {
			out = append(out, k)
		}
	}
	return out
}
