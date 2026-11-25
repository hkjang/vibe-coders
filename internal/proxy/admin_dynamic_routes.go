package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// Admin API for dynamic routes. Every path is under /admin/routing, so reads need
// routing:read and writes routing:write; validate and simulate only compute and are
// reads (see adminRequiredScope).
//
//	GET    /admin/routing/dynamic-routes                       list with 24h traffic
//	POST   /admin/routing/dynamic-routes                       create (version 1, optionally deployed)
//	POST   /admin/routing/dynamic-routes/validate              check a graph without saving it
//	POST   /admin/routing/dynamic-routes/simulate              walk a graph for a sample request
//	GET    /admin/routing/dynamic-routes/{id}                  route, versions, latest and deployed graph
//	PATCH  /admin/routing/dynamic-routes/{id}                  description / enabled
//	DELETE /admin/routing/dynamic-routes/{id}
//	POST   /admin/routing/dynamic-routes/{id}/versions         save a new version on top of base_version
//	GET    /admin/routing/dynamic-routes/{id}/versions/{n}     one version's graph
//	POST   /admin/routing/dynamic-routes/{id}/deploy           deploy (or roll back to) a version
//	GET    /admin/routing/dynamic-routes/{id}/activity         traffic, open limit windows, recent requests
const dynamicRoutesAdminPath = "/admin/routing/dynamic-routes"

const dynamicRouteBodyLimit = dynamicRouteMaxGraphBytes + 16<<10

type dynamicRouteView struct {
	store.DynamicRoute
	CallModel string                   `json:"call_model"`
	State     string                   `json:"state"`
	Traffic   store.DynamicRouteTotals `json:"traffic_24h"`
}

// dynamicRouteState names where a route stands for the console:
//
//	disabled        turned off; calls are refused
//	not_deployed    no version serves traffic yet
//	live_with_draft a newer saved version is waiting to be deployed
//	live            the newest version is serving
func dynamicRouteState(route store.DynamicRoute) string {
	switch {
	case !route.Enabled:
		return "disabled"
	case route.DeployedVersion == 0:
		return "not_deployed"
	case route.LatestVersion > route.DeployedVersion:
		return "live_with_draft"
	default:
		return "live"
	}
}

func newDynamicRouteView(route store.DynamicRoute, totals store.DynamicRouteTotals) dynamicRouteView {
	return dynamicRouteView{DynamicRoute: route, CallModel: dynamicRouteModelPrefix + route.Name, State: dynamicRouteState(route), Traffic: totals}
}

func dynamicRouteFieldCatalog() []map[string]string {
	fields := make([]string, 0, len(dynamicRouteBuiltinFields))
	for field := range dynamicRouteBuiltinFields {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	out := []map[string]string{{"field": "metadata.<key>", "description": "요청의 X-Vibe-Metadata(또는 cf-aig-metadata) 헤더 JSON 값"}}
	for _, field := range fields {
		out = append(out, map[string]string{"field": field, "description": dynamicRouteBuiltinFields[field]})
	}
	return out
}

func writeDynamicRouteError(w http.ResponseWriter, err error, fallbackCode string) {
	switch {
	case errors.Is(err, store.ErrDynamicRouteNotFound):
		writeOpenAIError(w, http.StatusNotFound, "dynamic route not found", "invalid_request_error", "dynamic_route_not_found")
	case errors.Is(err, store.ErrDynamicRouteVersionMissing):
		writeOpenAIError(w, http.StatusNotFound, "dynamic route version not found", "invalid_request_error", "dynamic_route_version_not_found")
	case errors.Is(err, store.ErrDynamicRouteNameTaken):
		writeOpenAIError(w, http.StatusConflict, "a dynamic route with this name already exists", "invalid_request_error", "dynamic_route_name_taken")
	case errors.Is(err, store.ErrDynamicRouteConflict):
		writeOpenAIError(w, http.StatusConflict, "the route changed since it was loaded; reload and apply the change again", "invalid_request_error", "dynamic_route_conflict")
	default:
		writeOpenAIError(w, http.StatusInternalServerError, "dynamic route storage is unavailable", "server_error", fallbackCode)
	}
}

// prepareDynamicRouteGraph parses, normalizes and validates a submitted graph, then
// adds the warnings that need the gateway's configuration: unknown providers and
// models no provider serves.
func (s *Server) prepareDynamicRouteGraph(ctx context.Context, raw json.RawMessage) (dynamicRouteGraph, *compiledDynamicRoute, dynamicRouteValidation, error) {
	graph, err := parseDynamicRouteGraph(raw)
	if err != nil {
		return dynamicRouteGraph{}, nil, dynamicRouteValidation{}, err
	}
	graph = normalizeDynamicRouteGraph(graph)
	compiled, validation := compileDynamicRouteGraph(graph)
	if compiled == nil {
		return graph, nil, validation, nil
	}
	for _, el := range compiled.modelElements() {
		props := el.Properties
		if provider := props.Provider; provider != "" {
			switch {
			case modelsProviderNameReserved(provider):
				validation.fail(el.ID, "provider_reserved", "공급자 이름 %q는 예약된 이름입니다.", provider)
				continue
			case !s.modelsProviderLabelSafeForConfig(provider):
				validation.fail(el.ID, "provider_invalid", "공급자 이름에 쓸 수 없는 문자가 있습니다.")
				continue
			}
			if _, found, lookupErr := s.db.GetProvider(ctx, provider); lookupErr == nil && !found {
				validation.warn(el.ID, "provider_not_found", "공급자 %q가 등록되어 있지 않습니다. 배포 후 이 요소는 실패하고 fallback으로 넘어갑니다.", provider)
			}
			continue
		}
		// Without a matching pattern the default provider serves the model, which is
		// the normal setup; only warn when there is no default to fall back on.
		if names, lookupErr := s.providersForModel(ctx, props.Model); lookupErr == nil && len(names) == 0 {
			if fallback, found, err := s.db.GetProvider(ctx, s.cfg.Upstream.Provider); err == nil && (!found || !fallback.Enabled) {
				validation.warn(el.ID, "model_unserved", "모델 %q를 받을 공급자가 없습니다. 모델 패턴이 맞는 공급자도, 사용 중인 기본 공급자도 없어 이 요소는 실패하고 fallback으로 넘어갑니다.", props.Model)
			}
		}
	}
	if !validation.ok() {
		return graph, nil, validation, nil
	}
	return graph, compiled, validation, nil
}

func (s *Server) handleDynamicRoutes(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		routes, err := s.db.ListDynamicRoutes(r.Context())
		if err != nil {
			writeDynamicRouteError(w, err, "dynamic_routes_failed")
			return
		}
		totals, err := s.db.DynamicRouteTrafficTotals(r.Context(), time.Now().Add(-24*time.Hour))
		if err != nil {
			totals = map[string]store.DynamicRouteTotals{}
		}
		views := make([]dynamicRouteView, 0, len(routes))
		for _, route := range routes {
			views = append(views, newDynamicRouteView(route, totals[route.ID]))
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"routes": views, "count": len(views), "fields": dynamicRouteFieldCatalog(),
		})
	case http.MethodPost:
		s.createDynamicRoute(w, r)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) createDynamicRoute(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Enabled     *bool           `json:"enabled"`
		Graph       json.RawMessage `json:"graph"`
		Note        string          `json:"note"`
		Deploy      bool            `json:"deploy"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, dynamicRouteBodyLimit)).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	name := strings.ToLower(strings.TrimSpace(payload.Name))
	if !dynamicRouteNamePattern.MatchString(name) {
		writeOpenAIError(w, http.StatusBadRequest, "name must be 1-63 characters of lowercase letters, digits and . _ - starting with a letter or digit", "invalid_request_error", "dynamic_route_name_invalid")
		return
	}
	graph, compiled, validation, err := s.prepareDynamicRouteGraph(r.Context(), payload.Graph)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "dynamic_route_graph_invalid")
		return
	}
	if compiled == nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]any{
			"message": "the graph has errors", "type": "invalid_request_error", "code": "dynamic_route_graph_invalid",
		}, "validation": validation})
		return
	}
	encoded, _ := json.Marshal(graph)
	enabled := payload.Enabled == nil || *payload.Enabled
	actor := s.skillActor(r)
	route, err := s.db.CreateDynamicRoute(r.Context(), store.DynamicRoute{
		ID: newID("drt"), Name: name, Description: strings.TrimSpace(payload.Description), Enabled: enabled, CreatedBy: actor,
	}, string(encoded), strings.TrimSpace(payload.Note))
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_create_failed")
		return
	}
	s.auditAdmin(r, "dynamic_route.create", "", auditJSON(map[string]any{"id": route.ID, "name": route.Name, "version": 1, "enabled": route.Enabled}))
	if payload.Deploy {
		deployed, deployErr := s.db.DeployDynamicRouteVersion(r.Context(), route.ID, 1, 0, actor)
		if deployErr != nil {
			writeDynamicRouteError(w, deployErr, "dynamic_route_deploy_failed")
			return
		}
		route = deployed
		s.invalidateDynamicRoutes()
		s.auditAdmin(r, "dynamic_route.deploy", auditJSON(map[string]any{"id": route.ID, "deployed_version": 0}), auditJSON(map[string]any{"id": route.ID, "deployed_version": 1}))
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"route": newDynamicRouteView(route, store.DynamicRouteTotals{}), "graph": graph, "validation": validation,
	})
}

func (s *Server) handleDynamicRouteByID(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, dynamicRoutesAdminPath+"/")
	parts := strings.Split(rest, "/")
	switch {
	case len(parts) == 1 && parts[0] == "validate":
		s.handleDynamicRouteValidate(w, r)
		return
	case len(parts) == 1 && parts[0] == "simulate":
		s.handleDynamicRouteSimulate(w, r)
		return
	}
	id := parts[0]
	if !strings.HasPrefix(id, "drt_") || len(id) > 64 {
		writeOpenAIError(w, http.StatusNotFound, "dynamic route not found", "invalid_request_error", "dynamic_route_not_found")
		return
	}
	switch {
	case len(parts) == 1:
		switch r.Method {
		case http.MethodGet:
			s.getDynamicRoute(w, r, id)
		case http.MethodPatch:
			s.patchDynamicRoute(w, r, id)
		case http.MethodDelete:
			s.deleteDynamicRoute(w, r, id)
		default:
			writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		}
	case len(parts) == 2 && parts[1] == "versions" && r.Method == http.MethodPost:
		s.saveDynamicRouteVersion(w, r, id)
	case len(parts) == 3 && parts[1] == "versions" && r.Method == http.MethodGet:
		version, err := strconv.Atoi(parts[2])
		if err != nil || version < 1 {
			writeOpenAIError(w, http.StatusBadRequest, "version must be a positive integer", "invalid_request_error", "dynamic_route_version_invalid")
			return
		}
		s.getDynamicRouteVersion(w, r, id, version)
	case len(parts) == 2 && parts[1] == "deploy" && r.Method == http.MethodPost:
		s.deployDynamicRoute(w, r, id)
	case len(parts) == 2 && parts[1] == "activity" && r.Method == http.MethodGet:
		s.getDynamicRouteActivity(w, r, id)
	default:
		writeOpenAIError(w, http.StatusNotFound, "unknown dynamic route endpoint", "invalid_request_error", "not_found")
	}
}

type dynamicRouteVersionView struct {
	store.DynamicRouteVersion
	Graph      json.RawMessage         `json:"graph,omitempty"`
	Validation *dynamicRouteValidation `json:"validation,omitempty"`
}

func (s *Server) dynamicRouteVersionView(ctx context.Context, version store.DynamicRouteVersion) dynamicRouteVersionView {
	view := dynamicRouteVersionView{DynamicRouteVersion: version, Graph: json.RawMessage(version.Graph)}
	if !json.Valid(view.Graph) {
		view.Graph = json.RawMessage(`{"elements":[]}`)
	}
	_, _, validation, err := s.prepareDynamicRouteGraph(ctx, view.Graph)
	if err == nil {
		view.Validation = &validation
	}
	return view
}

func (s *Server) getDynamicRoute(w http.ResponseWriter, r *http.Request, id string) {
	ctx := r.Context()
	route, found, err := s.db.GetDynamicRoute(ctx, id)
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_failed")
		return
	}
	if !found {
		writeDynamicRouteError(w, store.ErrDynamicRouteNotFound, "")
		return
	}
	versions, err := s.db.ListDynamicRouteVersions(ctx, id, 100)
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_failed")
		return
	}
	response := map[string]any{"versions": versions}
	if latest, ok, err := s.db.GetDynamicRouteVersion(ctx, id, route.LatestVersion); err == nil && ok {
		response["latest"] = s.dynamicRouteVersionView(ctx, latest)
	}
	if route.DeployedVersion > 0 && route.DeployedVersion != route.LatestVersion {
		if deployed, ok, err := s.db.GetDynamicRouteVersion(ctx, id, route.DeployedVersion); err == nil && ok {
			response["deployed"] = s.dynamicRouteVersionView(ctx, deployed)
		}
	}
	totals, _ := s.db.DynamicRouteTrafficTotals(ctx, time.Now().Add(-24*time.Hour))
	response["route"] = newDynamicRouteView(route, totals[route.ID])
	response["fields"] = dynamicRouteFieldCatalog()
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) patchDynamicRoute(w http.ResponseWriter, r *http.Request, id string) {
	var payload struct {
		Description *string `json:"description"`
		Enabled     *bool   `json:"enabled"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	before, found, err := s.db.GetDynamicRoute(r.Context(), id)
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_failed")
		return
	}
	if !found {
		writeDynamicRouteError(w, store.ErrDynamicRouteNotFound, "")
		return
	}
	description, enabled := before.Description, before.Enabled
	if payload.Description != nil {
		description = strings.TrimSpace(*payload.Description)
	}
	if payload.Enabled != nil {
		enabled = *payload.Enabled
	}
	route, err := s.db.UpdateDynamicRouteSettings(r.Context(), id, description, enabled, s.skillActor(r))
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_update_failed")
		return
	}
	s.invalidateDynamicRoutes()
	s.auditAdmin(r, "dynamic_route.update",
		auditJSON(map[string]any{"id": id, "description": before.Description, "enabled": before.Enabled}),
		auditJSON(map[string]any{"id": id, "description": route.Description, "enabled": route.Enabled}))
	writeJSON(w, http.StatusOK, map[string]any{"route": newDynamicRouteView(route, store.DynamicRouteTotals{})})
}

func (s *Server) deleteDynamicRoute(w http.ResponseWriter, r *http.Request, id string) {
	before, found, err := s.db.GetDynamicRoute(r.Context(), id)
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_failed")
		return
	}
	if !found {
		writeDynamicRouteError(w, store.ErrDynamicRouteNotFound, "")
		return
	}
	if err := s.db.DeleteDynamicRoute(r.Context(), id); err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_delete_failed")
		return
	}
	s.invalidateDynamicRoutes()
	s.auditAdmin(r, "dynamic_route.delete", auditJSON(map[string]any{"id": id, "name": before.Name, "deployed_version": before.DeployedVersion}), "")
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": "deleted"})
}

func (s *Server) saveDynamicRouteVersion(w http.ResponseWriter, r *http.Request, id string) {
	var payload struct {
		BaseVersion *int            `json:"base_version"`
		Graph       json.RawMessage `json:"graph"`
		Note        string          `json:"note"`
		Deploy      bool            `json:"deploy"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, dynamicRouteBodyLimit)).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	if payload.BaseVersion == nil {
		writeOpenAIError(w, http.StatusBadRequest, "base_version is required: the latest version the change was made on", "invalid_request_error", "dynamic_route_base_version_missing")
		return
	}
	graph, compiled, validation, err := s.prepareDynamicRouteGraph(r.Context(), payload.Graph)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "dynamic_route_graph_invalid")
		return
	}
	if compiled == nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]any{
			"message": "the graph has errors", "type": "invalid_request_error", "code": "dynamic_route_graph_invalid",
		}, "validation": validation})
		return
	}
	before, found, err := s.db.GetDynamicRoute(r.Context(), id)
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_failed")
		return
	}
	if !found {
		writeDynamicRouteError(w, store.ErrDynamicRouteNotFound, "")
		return
	}
	encoded, _ := json.Marshal(graph)
	actor := s.skillActor(r)
	version, err := s.db.SaveDynamicRouteVersion(r.Context(), id, *payload.BaseVersion, string(encoded), strings.TrimSpace(payload.Note), actor)
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_save_failed")
		return
	}
	s.auditAdmin(r, "dynamic_route.version",
		auditJSON(map[string]any{"id": id, "latest_version": before.LatestVersion}),
		auditJSON(map[string]any{"id": id, "latest_version": version.Version, "note": version.Note}))
	if payload.Deploy {
		if _, err := s.db.DeployDynamicRouteVersion(r.Context(), id, version.Version, before.DeployedVersion, actor); err != nil {
			writeDynamicRouteError(w, err, "dynamic_route_deploy_failed")
			return
		}
		s.invalidateDynamicRoutes()
		s.auditAdmin(r, "dynamic_route.deploy",
			auditJSON(map[string]any{"id": id, "deployed_version": before.DeployedVersion}),
			auditJSON(map[string]any{"id": id, "deployed_version": version.Version}))
	}
	route, _, err := s.db.GetDynamicRoute(r.Context(), id)
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_failed")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"route":      newDynamicRouteView(route, store.DynamicRouteTotals{}),
		"version":    dynamicRouteVersionView{DynamicRouteVersion: version, Graph: json.RawMessage(encoded), Validation: &validation},
		"validation": validation,
	})
}

func (s *Server) getDynamicRouteVersion(w http.ResponseWriter, r *http.Request, id string, number int) {
	version, found, err := s.db.GetDynamicRouteVersion(r.Context(), id, number)
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_failed")
		return
	}
	if !found {
		writeDynamicRouteError(w, store.ErrDynamicRouteVersionMissing, "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": s.dynamicRouteVersionView(r.Context(), version)})
}

func (s *Server) deployDynamicRoute(w http.ResponseWriter, r *http.Request, id string) {
	var payload struct {
		Version         int    `json:"version"`
		ExpectedVersion *int   `json:"expected_deployed_version"`
		Reason          string `json:"reason"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	if payload.Version < 1 {
		writeOpenAIError(w, http.StatusBadRequest, "version must be a positive integer", "invalid_request_error", "dynamic_route_version_invalid")
		return
	}
	if payload.ExpectedVersion == nil {
		writeOpenAIError(w, http.StatusBadRequest, "expected_deployed_version is required: the deployed version shown when the deploy was chosen", "invalid_request_error", "dynamic_route_expected_version_missing")
		return
	}
	// The stored graph was validated when it was saved, but rules can tighten
	// between releases. Never deploy something the request path would refuse.
	version, found, err := s.db.GetDynamicRouteVersion(r.Context(), id, payload.Version)
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_failed")
		return
	}
	if !found {
		if _, routeFound, _ := s.db.GetDynamicRoute(r.Context(), id); !routeFound {
			writeDynamicRouteError(w, store.ErrDynamicRouteNotFound, "")
			return
		}
		writeDynamicRouteError(w, store.ErrDynamicRouteVersionMissing, "")
		return
	}
	if _, compiled, validation, prepErr := s.prepareDynamicRouteGraph(r.Context(), json.RawMessage(version.Graph)); prepErr != nil || compiled == nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]any{
			"message": "this version no longer validates and cannot be deployed", "type": "invalid_request_error", "code": "dynamic_route_graph_invalid",
		}, "validation": validation})
		return
	}
	route, err := s.db.DeployDynamicRouteVersion(r.Context(), id, payload.Version, *payload.ExpectedVersion, s.skillActor(r))
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_deploy_failed")
		return
	}
	s.invalidateDynamicRoutes()
	action := "dynamic_route.deploy"
	if payload.Version < *payload.ExpectedVersion {
		action = "dynamic_route.rollback"
	}
	s.auditAdmin(r, action,
		auditJSON(map[string]any{"id": id, "deployed_version": *payload.ExpectedVersion}),
		auditJSON(map[string]any{"id": id, "deployed_version": route.DeployedVersion, "reason": strings.TrimSpace(payload.Reason)}))
	writeJSON(w, http.StatusOK, map[string]any{"route": newDynamicRouteView(route, store.DynamicRouteTotals{})})
}

type dynamicRouteRequestView struct {
	store.DynamicRouteRequest
	FinalProvider string             `json:"final_provider"`
	ProviderRef   string             `json:"provider_ref,omitempty"`
	Steps         []dynamicRouteStep `json:"steps"`
	Metadata      map[string]any     `json:"metadata"`
}

func (s *Server) getDynamicRouteActivity(w http.ResponseWriter, r *http.Request, id string) {
	ctx := r.Context()
	route, found, err := s.db.GetDynamicRoute(ctx, id)
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_failed")
		return
	}
	if !found {
		writeDynamicRouteError(w, store.ErrDynamicRouteNotFound, "")
		return
	}
	hours := 24
	if raw := r.URL.Query().Get("hours"); raw != "" {
		if parsed, convErr := strconv.Atoi(raw); convErr == nil && parsed >= 1 && parsed <= 24*31 {
			hours = parsed
		}
	}
	traffic, err := s.db.DynamicRouteTraffic(ctx, id, time.Now().Add(-time.Duration(hours)*time.Hour))
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_activity_failed")
		return
	}
	counters, err := s.db.ListDynamicRouteCounters(ctx, id, time.Now().Unix(), 100)
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_activity_failed")
		return
	}
	recent, err := s.db.ListDynamicRouteRequests(ctx, id, 50)
	if err != nil {
		writeDynamicRouteError(w, err, "dynamic_route_activity_failed")
		return
	}
	providerRef := s.providerRefSnapshot()
	requests := make([]dynamicRouteRequestView, 0, len(recent))
	for _, item := range recent {
		view := dynamicRouteRequestView{DynamicRouteRequest: item, Steps: []dynamicRouteStep{}, Metadata: map[string]any{}}
		_ = json.Unmarshal([]byte(item.PathJSON), &view.Steps)
		_ = json.Unmarshal([]byte(item.MetadataJSON), &view.Metadata)
		if item.FinalProvider != "" {
			view.FinalProvider = s.boundedModelsProviderLabelForConfig(item.FinalProvider)
			view.ProviderRef = providerRef(item.FinalProvider)
		}
		requests = append(requests, view)
	}
	limits := []map[string]any{}
	for _, counter := range counters {
		limits = append(limits, map[string]any{
			"element_id": counter.ElementID, "scoped": counter.ScopeKey != "",
			"window_start":  time.Unix(counter.WindowStart, 0).UTC().Format(time.RFC3339),
			"window_end":    time.Unix(counter.WindowEnd, 0).UTC().Format(time.RFC3339),
			"request_count": counter.RequestCount, "cost_krw": counter.CostKRW,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"route": newDynamicRouteView(route, store.DynamicRouteTotals{}), "hours": hours,
		"traffic": traffic, "limits": limits, "requests": requests,
	})
}

func (s *Server) handleDynamicRouteValidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var payload struct {
		Graph json.RawMessage `json:"graph"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, dynamicRouteBodyLimit)).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	graph, compiled, validation, err := s.prepareDynamicRouteGraph(r.Context(), payload.Graph)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "dynamic_route_graph_invalid")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"valid": compiled != nil, "graph": graph, "validation": validation})
}

func (s *Server) handleDynamicRouteSimulate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var payload struct {
		RouteID  string            `json:"route_id"`
		Version  int               `json:"version"`
		Graph    json.RawMessage   `json:"graph"`
		Metadata json.RawMessage   `json:"metadata"`
		Identity map[string]string `json:"identity"`
		Stream   bool              `json:"stream"`
		Endpoint string            `json:"endpoint"`
		Exceeded []string          `json:"exceeded"`
		Failing  []string          `json:"failing"`
		Samples  int               `json:"samples"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, dynamicRouteBodyLimit)).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	raw := payload.Graph
	routeID := "simulation"
	if len(raw) == 0 || string(raw) == "null" {
		if !strings.HasPrefix(payload.RouteID, "drt_") {
			writeOpenAIError(w, http.StatusBadRequest, "graph or route_id is required", "invalid_request_error", "dynamic_route_simulation_source_missing")
			return
		}
		route, found, err := s.db.GetDynamicRoute(r.Context(), payload.RouteID)
		if err != nil {
			writeDynamicRouteError(w, err, "dynamic_route_failed")
			return
		}
		if !found {
			writeDynamicRouteError(w, store.ErrDynamicRouteNotFound, "")
			return
		}
		number := payload.Version
		if number <= 0 {
			number = route.LatestVersion
		}
		version, ok, err := s.db.GetDynamicRouteVersion(r.Context(), route.ID, number)
		if err != nil {
			writeDynamicRouteError(w, err, "dynamic_route_failed")
			return
		}
		if !ok {
			writeDynamicRouteError(w, store.ErrDynamicRouteVersionMissing, "")
			return
		}
		raw = json.RawMessage(version.Graph)
	}
	if strings.HasPrefix(payload.RouteID, "drt_") {
		// Hash sticky splits with the real route id so the preview lands a sticky
		// value in the same bucket live traffic would.
		routeID = payload.RouteID
	}
	_, compiled, validation, err := s.prepareDynamicRouteGraph(r.Context(), raw)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "dynamic_route_graph_invalid")
		return
	}
	if compiled == nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]any{
			"message": "the graph has errors", "type": "invalid_request_error", "code": "dynamic_route_graph_invalid",
		}, "validation": validation})
		return
	}
	metadata := map[string]any{}
	if trimmed := strings.TrimSpace(string(payload.Metadata)); trimmed != "" && trimmed != "null" {
		parsed, parseErr := parseRequestMetadata(trimmed)
		if parseErr != nil {
			writeOpenAIError(w, http.StatusBadRequest, "metadata "+parseErr.Error(), "invalid_request_error", "dynamic_route_metadata_invalid")
			return
		}
		metadata = parsed
	}
	identity := map[string]string{}
	for key, value := range payload.Identity {
		if _, known := dynamicRouteBuiltinFields["identity."+key]; known {
			identity[key] = strings.TrimSpace(value)
		}
	}
	endpoint := strings.TrimSpace(payload.Endpoint)
	if endpoint == "" {
		endpoint = "/v1/chat/completions"
	}
	input := dynamicRouteInput{Metadata: metadata, Identity: identity, Request: map[string]any{"stream": payload.Stream, "endpoint": endpoint}}
	opts := dynamicRouteSimOptions{Exceeded: map[string]bool{}, Failing: map[string]bool{}}
	for _, id := range payload.Exceeded {
		opts.Exceeded[id] = true
	}
	for _, id := range payload.Failing {
		opts.Failing[id] = true
	}
	samples := payload.Samples
	if samples <= 0 {
		samples = 1000
	}
	if samples > 5000 {
		samples = 5000
	}
	result := simulateDynamicRoute(r.Context(), compiled, routeID, input, opts)
	distribution := distributeDynamicRoute(r.Context(), compiled, routeID, input, opts, samples)
	writeJSON(w, http.StatusOK, map[string]any{
		"result": result, "distribution": distribution, "samples": samples, "validation": validation,
	})
}
