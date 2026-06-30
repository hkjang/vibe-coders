package proxy

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

type openAIRequestParams struct {
	Model               string
	Temperature         *float64
	TopP                *float64
	MaxTokens           int
	MaxCompletionTokens int
	Stream              bool
	ToolCount           int
	ResponseFormatType  string
}

func applyReadableIngress(req *store.RequestLog, r *http.Request, body []byte) {
	if req == nil || r == nil {
		return
	}
	req.Method = r.Method
	req.RequestHeadersJSON = mustJSON(maskedHeaderMap(r.Header, "request"))
	applyOpenAIRequestBodySummary(req, body, req.Endpoint)
	refreshHeaderSummary(req, nil, nil, nil)
	refreshRoutingSummary(req, nil)
}

func applyOpenAIRequestBodySummary(req *store.RequestLog, body []byte, endpoint string) {
	if req == nil {
		return
	}
	summary, params := summarizeOpenAIBody(body, endpoint)
	req.BodySummaryJSON = mustJSON(summary)
	if params.Model != "" {
		req.RequestedModel = params.Model
	}
	req.Temperature = params.Temperature
	req.TopP = params.TopP
	req.MaxTokens = params.MaxTokens
	req.MaxCompletionTokens = params.MaxCompletionTokens
	req.ResponseFormatType = params.ResponseFormatType
	req.ToolCount = params.ToolCount
	req.Stream = params.Stream
}

func applyUpstreamHeaderSummary(req *store.RequestLog, upstreamReq http.Header, upstreamResp http.Header, gatewayResp http.Header) {
	if req == nil {
		return
	}
	if upstreamReq != nil {
		req.UpstreamHeadersJSON = mustJSON(maskedHeaderMap(upstreamReq, "upstream_request"))
	}
	if upstreamResp != nil {
		req.ResponseHeadersJSON = mustJSON(maskedHeaderMap(upstreamResp, "upstream_response"))
	}
	refreshHeaderSummary(req, upstreamReq, upstreamResp, gatewayResp)
}

func refreshHeaderSummary(req *store.RequestLog, upstreamReq http.Header, upstreamResp http.Header, gatewayResp http.Header) {
	if req == nil {
		return
	}
	requestHeaders := mapFromJSON(req.RequestHeadersJSON)
	if len(requestHeaders) == 0 {
		requestHeaders = map[string]any{}
	}
	if upstreamReq == nil && req.UpstreamHeadersJSON != "" {
		upstreamReq = headerFromJSON(req.UpstreamHeadersJSON)
	}
	if upstreamResp == nil && req.ResponseHeadersJSON != "" {
		upstreamResp = headerFromJSON(req.ResponseHeadersJSON)
	}
	groups := map[string]any{
		"primary":           primaryHeaders(requestHeaders),
		"gateway":           selectHeaders(requestHeaders, gatewayHeaderName),
		"client":            selectHeaders(requestHeaders, clientHeaderName),
		"proxy":             selectHeaders(requestHeaders, proxyHeaderName),
		"request":           requestHeaders,
		"upstream_request":  maskedHeaderMap(upstreamReq, "upstream_request"),
		"upstream_response": maskedHeaderMap(upstreamResp, "upstream_response"),
	}
	if gatewayResp != nil {
		groups["gateway_response"] = maskedHeaderMap(gatewayResp, "gateway_response")
	}
	req.HeaderSummaryJSON = mustJSON(groups)
}

func refreshRoutingSummary(req *store.RequestLog, plan *intelligentRoutingPlan) {
	if req == nil {
		return
	}
	if req.ResolvedModel == "" {
		req.ResolvedModel = firstNonEmpty(req.Model, req.RequestedModel)
	}
	if req.UpstreamModel == "" {
		req.UpstreamModel = firstNonEmpty(req.Model, req.ResolvedModel, req.RequestedModel)
	}
	summary := map[string]any{
		"requested_model":         firstNonEmpty(req.RequestedModel, req.Model),
		"resolved_model":          firstNonEmpty(req.ResolvedModel, req.Model),
		"selected_provider":       req.Provider,
		"selected_upstream_model": firstNonEmpty(req.UpstreamModel, req.Model),
		"route_reason":            req.RouteReason,
		"route_rule":              req.RouteDetail,
		"fallback":                req.Failover,
		"fallback_from":           req.FallbackFrom,
		"fallback_reason":         req.FallbackReason,
		"mcp_used":                req.ToolCount > 0,
		"text2sql_used":           strings.HasPrefix(strings.ToLower(firstNonEmpty(req.RequestedModel, req.Model)), "vibe/text2sql"),
	}
	if plan != nil {
		summary["complexity"] = plan.Complexity
		summary["risk"] = plan.Risk
		summary["health_score"] = plan.HealthScore
		summary["decision_reason"] = plan.DecisionReason
		summary["fallback_path"] = plan.FallbackPath
		if plan.RouteReason != "" {
			summary["route_reason"] = plan.RouteReason
		}
	}
	req.RoutingSummaryJSON = mustJSON(summary)
}

func refreshPolicySummary(req *store.RequestLog, phase string, blocked bool, approvalRequired bool, action string, reason string, secretTypes []string) {
	if req == nil {
		return
	}
	summary := mapFromJSON(req.PolicySummaryJSON)
	if len(summary) == 0 {
		summary = map[string]any{"decision": "allow"}
	}
	if phase != "" {
		summary["phase"] = phase
	}
	if action != "" {
		summary["secret_action"] = action
	}
	if len(secretTypes) > 0 {
		summary["secret_types"] = secretTypes
	}
	if blocked {
		summary["decision"] = "block"
	} else if approvalRequired {
		summary["decision"] = "approval"
	} else if action == "mask" {
		summary["decision"] = "allow_with_redact"
	}
	if reason != "" {
		summary["reason"] = reason
	}
	req.PolicySummaryJSON = mustJSON(summary)
}

func summarizeOpenAIBody(body []byte, endpoint string) (map[string]any, openAIRequestParams) {
	summary := map[string]any{
		"available":  len(body) > 0,
		"body_bytes": len(body),
		"endpoint":   endpoint,
	}
	var params openAIRequestParams
	if len(body) == 0 {
		return summary, params
	}
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil {
		summary["parse_error"] = err.Error()
		summary["raw_preview"] = audit.Redact(stringLimit(string(body), 4000))
		return summary, params
	}
	params.Model, _ = root["model"].(string)
	params.Temperature = jsonFloatPtr(root["temperature"])
	params.TopP = jsonFloatPtr(root["top_p"])
	params.MaxTokens = jsonInt(root["max_tokens"])
	params.MaxCompletionTokens = jsonInt(root["max_completion_tokens"])
	params.Stream = jsonBool(root["stream"])
	params.ToolCount = jsonArrayLen(root["tools"]) + jsonArrayLen(root["functions"])
	params.ResponseFormatType = responseFormatType(root["response_format"])

	parameters := map[string]any{
		"model":                 params.Model,
		"temperature":           nullableParam(params.Temperature),
		"temperature_label":     requestTemperatureLabel(params.Temperature),
		"top_p":                 nullableParam(params.TopP),
		"max_tokens":            params.MaxTokens,
		"max_completion_tokens": params.MaxCompletionTokens,
		"n":                     root["n"],
		"presence_penalty":      root["presence_penalty"],
		"frequency_penalty":     root["frequency_penalty"],
		"stop":                  root["stop"],
		"seed":                  root["seed"],
		"response_format_type":  params.ResponseFormatType,
		"tool_choice":           root["tool_choice"],
		"stream":                params.Stream,
		"stream_options":        root["stream_options"],
		"user":                  maskScalar(root["user"]),
		"tool_count":            params.ToolCount,
		"tool_names":            toolNames(root["tools"], root["functions"]),
		"logit_bias_present":    root["logit_bias"] != nil,
	}
	summary["parameters"] = compactNilMap(parameters)
	summary["messages"] = messageSummary(root["messages"])
	summary["multimodal"] = multimodalSummary(root["messages"])
	summary["json_schema"] = jsonSchemaSummary(root["response_format"])
	summary["additional_fields"] = additionalBodyFields(root)
	summary["masked_raw"] = maskJSONForDisplay(root)
	return summary, params
}

func maskedHeaderMap(h http.Header, mode string) map[string]any {
	out := map[string]any{}
	if h == nil {
		return out
	}
	keys := make([]string, 0, len(h))
	for key := range h {
		keys = append(keys, http.CanonicalHeaderKey(key))
	}
	sort.Strings(keys)
	seen := map[string]bool{}
	for _, key := range keys {
		if seen[key] {
			continue
		}
		seen[key] = true
		if hiddenHeaderName(key) {
			out[key] = "[hidden]"
			continue
		}
		values := h.Values(key)
		if len(values) == 0 {
			values = h.Values(http.CanonicalHeaderKey(key))
		}
		value := strings.Join(values, ", ")
		out[key] = maskHeaderValue(key, value)
	}
	if mode != "" {
		out["_group"] = mode
	}
	return out
}

func primaryHeaders(headers map[string]any) map[string]any {
	names := map[string]bool{
		"X-Request-Id": true, "X-Session-Id": true, "X-Correlation-Id": true,
		"Authorization": true, "X-Api-Key": true, "Content-Type": true, "Accept": true, "User-Agent": true,
	}
	return selectHeaders(headers, func(k string) bool { return names[http.CanonicalHeaderKey(k)] })
}

func selectHeaders(headers map[string]any, pred func(string) bool) map[string]any {
	out := map[string]any{}
	for k, v := range headers {
		if strings.HasPrefix(k, "_") {
			continue
		}
		if pred(k) {
			out[k] = v
		}
	}
	return out
}

func gatewayHeaderName(key string) bool {
	k := strings.ToLower(key)
	return strings.HasPrefix(k, "x-gateway-") || strings.HasPrefix(k, "x-proxy-") ||
		strings.HasPrefix(k, "x-routing-") || strings.HasPrefix(k, "x-estimated-") ||
		strings.HasPrefix(k, "x-quota-") || strings.HasPrefix(k, "x-routed-") ||
		strings.HasPrefix(k, "x-failover-") || strings.HasPrefix(k, "x-cache") ||
		strings.EqualFold(key, "X-Api-Key-Id")
}

func clientHeaderName(key string) bool {
	k := strings.ToLower(key)
	return k == "user-agent" || k == "origin" || k == "referer" || k == "openai-organization" ||
		strings.HasPrefix(k, "x-vibe-") || strings.HasPrefix(k, "x-llm-")
}

func proxyHeaderName(key string) bool {
	k := strings.ToLower(key)
	return k == "x-forwarded-for" || k == "x-real-ip" || k == "forwarded" || strings.HasPrefix(k, "cf-")
}

func hiddenHeaderName(key string) bool {
	k := strings.ToLower(key)
	return k == "cookie" || k == "set-cookie"
}

func maskHeaderValue(key, value string) string {
	canonical := http.CanonicalHeaderKey(key)
	lower := strings.ToLower(canonical)
	value = strings.TrimSpace(value)
	switch {
	case strings.EqualFold(canonical, "Authorization"):
		parts := strings.Fields(value)
		if len(parts) >= 2 {
			return parts[0] + " " + maskToken(parts[1])
		}
		return maskToken(value)
	case strings.EqualFold(canonical, "X-Api-Key"):
		return maskToken(value)
	case strings.EqualFold(canonical, "Referer"):
		return refererOrigin(value)
	case lower == "x-forwarded-for" || lower == "x-real-ip" || lower == "cf-connecting-ip":
		return maskIPList(value)
	case strings.Contains(lower, "key") || strings.Contains(lower, "token") || strings.Contains(lower, "secret") ||
		strings.Contains(lower, "credential") || strings.Contains(lower, "password"):
		return maskToken(value)
	default:
		return audit.Redact(value)
	}
}

func maskToken(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if len(value) <= 4 {
		return "****"
	}
	suffix := value[len(value)-4:]
	if strings.HasPrefix(value, "sk-") {
		return "sk-****" + suffix
	}
	if strings.HasPrefix(value, "vc_sk_") {
		return "vc_sk_****" + suffix
	}
	if strings.HasPrefix(value, "vc_sa_") {
		return "vc_sa_****" + suffix
	}
	if strings.Count(value, ".") == 2 && strings.HasPrefix(value, "eyJ") {
		head := strings.Split(value, ".")[0]
		if len(head) > 16 {
			head = head[:16]
		}
		return head + ".****.****"
	}
	return "****" + suffix
}

func maskIPList(value string) string {
	parts := strings.Split(value, ",")
	for i, part := range parts {
		parts[i] = maskIP(strings.TrimSpace(part))
	}
	return strings.Join(parts, ", ")
}

func maskIP(value string) string {
	ip := net.ParseIP(value)
	if ip == nil {
		return value
	}
	if v4 := ip.To4(); v4 != nil {
		return fmt.Sprintf("%d.%d.%d.xxx", v4[0], v4[1], v4[2])
	}
	return ip.String()[:strings.LastIndex(ip.String(), ":")+1] + "xxxx"
}

func refererOrigin(value string) string {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" {
		return audit.Redact(value)
	}
	return u.Scheme + "://" + u.Host
}

func jsonFloatPtr(v any) *float64 {
	switch n := v.(type) {
	case float64:
		return &n
	case json.Number:
		if f, err := n.Float64(); err == nil {
			return &f
		}
	}
	return nil
}

func jsonInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	}
	return 0
}

func jsonBool(v any) bool {
	b, _ := v.(bool)
	return b
}

func jsonArrayLen(v any) int {
	arr, ok := v.([]any)
	if !ok {
		return 0
	}
	return len(arr)
}

func responseFormatType(v any) string {
	m, ok := v.(map[string]any)
	if !ok {
		if s, ok := v.(string); ok {
			return s
		}
		return ""
	}
	if typ, _ := m["type"].(string); typ != "" {
		return typ
	}
	return "object"
}

func toolNames(tools, functions any) []string {
	var names []string
	appendNames := func(v any) {
		arr, ok := v.([]any)
		if !ok {
			return
		}
		for _, item := range arr {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if fn, ok := m["function"].(map[string]any); ok {
				if name, _ := fn["name"].(string); name != "" {
					names = append(names, name)
					continue
				}
			}
			if name, _ := m["name"].(string); name != "" {
				names = append(names, name)
			}
		}
	}
	appendNames(tools)
	appendNames(functions)
	sort.Strings(names)
	return names
}

func messageSummary(v any) map[string]any {
	out := map[string]any{"total": 0, "system": 0, "user": 0, "assistant": 0, "tool": 0}
	arr, ok := v.([]any)
	if !ok {
		return out
	}
	out["total"] = len(arr)
	for _, item := range arr {
		msg, ok := item.(map[string]any)
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)
		role = strings.ToLower(role)
		if _, ok := out[role]; ok {
			out[role] = out[role].(int) + 1
		}
	}
	return out
}

func multimodalSummary(v any) map[string]any {
	out := map[string]any{"image_count": 0, "audio_count": 0, "file_count": 0}
	arr, ok := v.([]any)
	if !ok {
		return out
	}
	for _, item := range arr {
		msg, ok := item.(map[string]any)
		if !ok {
			continue
		}
		content, ok := msg["content"].([]any)
		if !ok {
			continue
		}
		for _, part := range content {
			pm, ok := part.(map[string]any)
			if !ok {
				continue
			}
			typ, _ := pm["type"].(string)
			switch {
			case strings.Contains(typ, "image"):
				out["image_count"] = out["image_count"].(int) + 1
			case strings.Contains(typ, "audio"):
				out["audio_count"] = out["audio_count"].(int) + 1
			case strings.Contains(typ, "file"):
				out["file_count"] = out["file_count"].(int) + 1
			}
		}
	}
	return out
}

func jsonSchemaSummary(v any) map[string]any {
	out := map[string]any{}
	m, ok := v.(map[string]any)
	if !ok {
		return out
	}
	typ, _ := m["type"].(string)
	if typ != "json_schema" {
		return out
	}
	out["type"] = "json_schema"
	if js, ok := m["json_schema"].(map[string]any); ok {
		out["name"], _ = js["name"].(string)
		out["strict"], _ = js["strict"].(bool)
		if schema, ok := js["schema"].(map[string]any); ok {
			out["top_level_keys"] = sortedMapKeys(schema)
		}
	}
	return out
}

func additionalBodyFields(root map[string]any) []string {
	known := map[string]bool{
		"model": true, "messages": true, "input": true, "temperature": true, "top_p": true,
		"max_tokens": true, "max_completion_tokens": true, "n": true, "presence_penalty": true,
		"frequency_penalty": true, "stop": true, "seed": true, "logit_bias": true,
		"response_format": true, "tools": true, "functions": true, "tool_choice": true,
		"stream": true, "stream_options": true, "user": true,
	}
	var out []string
	for key := range root {
		if !known[key] {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}

func maskJSONForDisplay(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, val := range x {
			if sensitiveJSONKey(k) {
				out[k] = maskToken(fmt.Sprint(val))
				continue
			}
			out[k] = maskJSONForDisplay(val)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i := range x {
			out[i] = maskJSONForDisplay(x[i])
		}
		return out
	case string:
		return audit.Redact(stringLimit(x, 20000))
	default:
		return x
	}
}

func sensitiveJSONKey(key string) bool {
	k := strings.ToLower(key)
	return strings.Contains(k, "key") || strings.Contains(k, "token") || strings.Contains(k, "secret") ||
		strings.Contains(k, "credential") || strings.Contains(k, "password") || strings.Contains(k, "cookie")
}

func maskScalar(v any) any {
	if s, ok := v.(string); ok {
		return audit.Redact(s)
	}
	return v
}

func requestTemperatureLabel(value *float64) string {
	if value == nil {
		return "미지정"
	}
	switch v := *value; {
	case v == 0:
		return "결정적"
	case v <= 0.3:
		return "낮음"
	case v <= 0.8:
		return "보통"
	default:
		return "높음"
	}
}

func nullableParam(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func compactNilMap(in map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range in {
		if v == nil {
			continue
		}
		out[k] = v
	}
	return out
}

func sortedMapKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func stringLimit(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "...[truncated]"
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

func mapFromJSON(raw string) map[string]any {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return map[string]any{}
	}
	return out
}

func headerFromJSON(raw string) http.Header {
	m := mapFromJSON(raw)
	h := http.Header{}
	for k, v := range m {
		if strings.HasPrefix(k, "_") {
			continue
		}
		h.Set(k, fmt.Sprint(v))
	}
	return h
}
