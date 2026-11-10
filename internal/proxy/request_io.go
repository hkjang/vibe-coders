package proxy

import (
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

const (
	requestIOPreviewRunes  = 240
	requestIOSampleChars   = 64 * 1024
	requestIOMaxIDs        = 100
	requestIOIDListBytes   = 16 * 1024
	requestIOMaxMessages   = 200
	requestIOMaxTextRunes  = 200_000
	requestIOLineScanBytes = 32 * 1024
	requestIOStateCaptured = "captured"
	// requestIOStateNotCaptured means the call answered but its body was not kept
	// (LOG_RESPONSE_TEXT off), which is not the same as the call having no answer.
	requestIOStateNotCaptured = "not_captured"
	// requestIOStateMissing means no row exists: blocked before the upstream, expired
	// by retention, or an endpoint whose input the gateway does not capture.
	requestIOStateMissing = "missing"
)

type requestIOCapture struct {
	ResponseText     bool `json:"response_text"`
	RawPrompts       bool `json:"raw_prompts"`
	ResponseMaxBytes int  `json:"response_max_bytes"`
}

func (s *Server) requestIOCapture() requestIOCapture {
	logging := s.loggingConf()
	return requestIOCapture{ResponseText: logging.ResponseText, RawPrompts: logging.RawPrompts, ResponseMaxBytes: logging.ResponseMaxBytes}
}

type requestIOInputPreview struct {
	State        string `json:"state"`
	Role         string `json:"role"`
	Text         string `json:"text"`
	Truncated    bool   `json:"truncated"`
	Chars        int64  `json:"chars"`
	MessageCount int    `json:"message_count"`
}

type requestIOOutputPreview struct {
	State        string   `json:"state"`
	Kind         string   `json:"kind"`
	Text         string   `json:"text"`
	Truncated    bool     `json:"truncated"`
	Chars        int64    `json:"chars"`
	ToolNames    []string `json:"tool_names"`
	FinishReason string   `json:"finish_reason"`
}

type requestIOPreview struct {
	RequestID string                 `json:"request_id"`
	Input     requestIOInputPreview  `json:"input"`
	Output    requestIOOutputPreview `json:"output"`
}

// handleRequestIOPreviews returns what went in and came out of a set of requests, for a
// listing that shows them at a glance. Text is always masked here regardless of role, and
// requests outside the caller's team scope are omitted rather than denied so the endpoint
// cannot be used to probe which ids exist.
//
// GET /admin/requests/io?ids=a,b,c
func (s *Server) handleRequestIOPreviews(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	raw := r.URL.Query().Get("ids")
	if len(raw) > requestIOIDListBytes {
		writeOpenAIError(w, http.StatusBadRequest, "ids is too long", "invalid_request_error", "invalid_request_ids")
		return
	}
	seen := map[string]struct{}{}
	ids := make([]string, 0, requestIOMaxIDs)
	for _, id := range splitCSV(raw) {
		if !adminTraceIdentifierValid(id) {
			writeOpenAIError(w, http.StatusBadRequest, "invalid request id", "invalid_request_error", "invalid_request_id")
			return
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) > requestIOMaxIDs {
		writeOpenAIError(w, http.StatusBadRequest, "ids must list at most 100 requests", "invalid_request_error", "invalid_request_ids")
		return
	}
	teams, teamScoped, err := requestTeamScopeForCallerChecked(s, r)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "request previews could not be loaded", "server_error", "request_io_failed")
		return
	}
	samples, err := s.db.RequestIOSamples(r.Context(), store.RequestIOSampleFilter{
		IDs: ids, Teams: teams, TeamScoped: teamScoped, TextChars: requestIOSampleChars,
	})
	if err != nil {
		slog.Error("request io preview query failed", "error", err)
		writeOpenAIError(w, http.StatusInternalServerError, "request previews could not be loaded", "server_error", "request_io_failed")
		return
	}
	project := s.requestIOMasker()
	previews := make([]requestIOPreview, 0, len(ids))
	for _, id := range ids {
		if sample, visible := samples[id]; visible {
			previews = append(previews, projectRequestIOSample(sample, project))
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{
		"previews":     previews,
		"capture":      s.requestIOCapture(),
		"generated_at": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

// requestIOMasker is the masking every viewer gets by default. Secrets are replaced where
// they stand, so one key in an answer leaves the answer readable. What the projection then
// still cannot vouch for, such as a configured credential prefix or a token in a URL, costs
// only its own line. The metadata projection would drop the whole field instead, which suits
// a provider name but would hide any long answer.
func (s *Server) requestIOMasker(rawProviders ...string) func(string) string {
	args := s.externalCredentialProjectionArgs(rawProviders...)
	return func(text string) string {
		if text == "" {
			return ""
		}
		var masked strings.Builder
		masked.Grow(len(text))
		for line := range strings.Lines(audit.Redact(text)) {
			for _, part := range requestIOLineParts(line) {
				body := strings.TrimRight(part, "\r\n")
				masked.WriteString(boundedExternalProviderText(body, args...))
				masked.WriteString(part[len(body):])
			}
		}
		return masked.String()
	}
}

// requestIOLineParts splits a line longer than the projection will scan, at rune boundaries,
// so minified JSON is not omitted for its length alone. Redaction has already seen it whole.
func requestIOLineParts(line string) []string {
	if len(line) <= requestIOLineScanBytes {
		return []string{line}
	}
	parts := make([]string, 0, len(line)/requestIOLineScanBytes+1)
	for len(line) > requestIOLineScanBytes {
		cut := requestIOLineScanBytes
		for cut > 0 && !utf8.RuneStart(line[cut]) {
			cut--
		}
		parts = append(parts, line[:cut])
		line = line[cut:]
	}
	return append(parts, line)
}

func projectRequestIOSample(sample store.RequestIOSample, project func(string) string) requestIOPreview {
	preview := requestIOPreview{
		RequestID: sample.RequestID,
		Input: requestIOInputPreview{
			State:        requestIOStateMissing,
			Chars:        sample.InputChars,
			MessageCount: sample.MessageCount,
		},
		Output: requestIOOutputPreview{
			State:        requestIOStateMissing,
			Kind:         requestOutputKindNone,
			ToolNames:    requestIOToolNames(sample.ToolNames),
			FinishReason: project(sample.FinishReason),
		},
	}
	if sample.MessageCount > 0 {
		preview.Input.State = requestIOStateCaptured
		preview.Input.Role = project(sample.LastRole)
		preview.Input.Text, preview.Input.Truncated = requestIOPreviewText(project(sample.LastInput))
		preview.Input.Truncated = preview.Input.Truncated || sample.LastChars > int64(utf8.RuneCountInString(sample.LastInput))
	}
	if !sample.ResponseFound {
		return preview
	}
	preview.Output.State = requestIOStateNotCaptured
	if sample.Output == "" {
		return preview
	}
	output := extractRequestOutput(sample.Output, sample.StatusCode)
	if output.Kind == requestOutputKindNone {
		return preview
	}
	preview.Output.State = requestIOStateCaptured
	preview.Output.Kind = output.Kind
	preview.Output.Chars = int64(utf8.RuneCountInString(output.Text))
	preview.Output.Text, preview.Output.Truncated = requestIOPreviewText(project(output.Text))
	preview.Output.Truncated = preview.Output.Truncated || output.Partial || sample.OutputChars > int64(utf8.RuneCountInString(sample.Output))
	if len(output.ToolCalls) > 0 {
		names := make([]string, 0, len(output.ToolCalls))
		for _, call := range output.ToolCalls {
			names = append(names, project(call.Name))
		}
		preview.Output.ToolNames = names
	}
	return preview
}

// requestIOToolNames keeps a stable, non-null JSON array and folds a call repeated by the
// definition/call/result rows into one name.
func requestIOToolNames(names []string) []string {
	unique := make([]string, 0, len(names))
	seen := map[string]struct{}{}
	for _, name := range names {
		if _, duplicate := seen[name]; duplicate || name == "" {
			continue
		}
		seen[name] = struct{}{}
		unique = append(unique, name)
	}
	return unique
}

// requestIOPreviewText collapses whitespace so a preview line reads as one line, then cuts
// it at a rune boundary. It runs after masking so a cut cannot split a secret past the
// patterns that would have caught it.
func requestIOPreviewText(text string) (string, bool) {
	collapsed := strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(collapsed) <= requestIOPreviewRunes {
		return collapsed, false
	}
	runes := []rune(collapsed)
	return string(runes[:requestIOPreviewRunes]), true
}

type requestIOMessage struct {
	Role         string `json:"role"`
	Text         string `json:"text"`
	Chars        int    `json:"chars"`
	Truncated    bool   `json:"truncated"`
	OriginalKept bool   `json:"original_kept"`
}

type requestIOInput struct {
	State           string             `json:"state"`
	Messages        []requestIOMessage `json:"messages"`
	OmittedMessages int                `json:"omitted_messages"`
	ToolDefinitions string             `json:"tool_definitions"`
}

type requestIOOutput struct {
	State        string              `json:"state"`
	Kind         string              `json:"kind"`
	Text         string              `json:"text"`
	Chars        int                 `json:"chars"`
	Truncated    bool                `json:"truncated"`
	ToolCalls    []requestIOToolCall `json:"tool_calls"`
	FinishReason string              `json:"finish_reason"`
	// OriginalKept is true only for a row stored before responses were masked on write, the
	// one case in which ?reveal=raw can show more than the masked text.
	OriginalKept bool `json:"original_kept"`
}

type requestIODetail struct {
	RequestID string `json:"request_id"`
	CreatedAt string `json:"created_at"`
	Method    string `json:"method"`
	Endpoint  string `json:"endpoint"`
	Stream    bool   `json:"stream"`
	Status    int    `json:"status_code"`
	Error     string `json:"error"`

	RequestedModel string   `json:"requested_model"`
	ResolvedModel  string   `json:"resolved_model"`
	Provider       string   `json:"provider"`
	RouteReason    string   `json:"route_reason"`
	Failover       bool     `json:"failover"`
	FallbackFrom   string   `json:"fallback_from"`
	Languages      []string `json:"languages"`

	PromptTokens     int     `json:"prompt_tokens"`
	CompletionTokens int     `json:"completion_tokens"`
	TotalTokens      int     `json:"total_tokens"`
	CachedTokens     int     `json:"cached_tokens"`
	ReasoningTokens  int     `json:"reasoning_tokens"`
	TokenSource      string  `json:"token_source"`
	EstimatedCost    float64 `json:"estimated_cost"`
	Currency         string  `json:"currency"`
	LatencyMS        int64   `json:"latency_ms"`
	FirstChunkMS     int64   `json:"first_chunk_ms"`

	APIKeyID  string `json:"api_key_id"`
	ClientIP  string `json:"client_ip"`
	UserAgent string `json:"user_agent"`
	SessionID string `json:"session_id"`
	TraceID   string `json:"trace_id"`

	Input   requestIOInput   `json:"input"`
	Output  requestIOOutput  `json:"output"`
	Capture requestIOCapture `json:"capture"`
	// Masked is whether Text fields carry masking; RawAllowed whether this viewer may ask
	// for the originals with ?reveal=raw.
	Masked     bool `json:"masked"`
	RawAllowed bool `json:"raw_allowed"`
}

// handleRequestIO serves one request's full input and output. The caller has already been
// checked against the request's team scope. Masked text is the default for every role;
// ?reveal=raw returns originals only to roles allowed to see them, and only once the access
// has been written to the audit log, so a failed audit returns nothing.
//
// GET /admin/requests/{id}/io[?reveal=raw]
func (s *Server) handleRequestIO(w http.ResponseWriter, r *http.Request, id string, detail store.RequestDetail) {
	reveal := false
	switch r.URL.Query().Get("reveal") {
	case "":
	case "raw":
		reveal = true
	default:
		writeOpenAIError(w, http.StatusBadRequest, "reveal must be raw", "invalid_request_error", "invalid_request_reveal")
		return
	}
	rawAllowed := s.canViewRawPrompts(r)
	if reveal && !rawAllowed {
		writeOpenAIError(w, http.StatusForbidden, "viewing originals requires privileged trace access", "permission_error", "raw_trace_access_denied")
		return
	}
	if reveal {
		if err := s.db.InsertAdminAudit(r.Context(), store.AdminAuditLog{
			ID: newID("audit"), AdminID: s.adminKeyActor(r), Action: "request.raw_view",
			AfterValue: auditJSON(map[string]any{"request_id": id}),
		}); err != nil {
			slog.Error("request raw view audit failed", "request_id", id, "error", err)
			writeOpenAIError(w, http.StatusInternalServerError, "raw view could not be audited", "server_error", "request_io_failed")
			return
		}
	}
	project := s.requestIOMasker(detail.Request.Provider, detail.Request.FallbackFrom)
	text := project
	if reveal {
		text = func(value string) string { return value }
	}

	req := detail.Request
	capture := s.requestIOCapture()
	request := requestIODetail{
		RequestID:        s.projectAppRequestText(req.ID, appRequestIDMaxBytes),
		CreatedAt:        req.CreatedAt,
		Method:           s.projectAppRequestText(req.Method, appRequestMethodMaxBytes),
		Endpoint:         s.projectAppRequestText(req.Endpoint, appRequestEndpointMaxBytes),
		Stream:           req.Stream,
		Status:           clampAppRequestStatus(req.StatusCode),
		Error:            text(req.Error),
		RequestedModel:   s.projectAppRequestText(req.RequestedModel, appRequestModelMaxBytes),
		ResolvedModel:    s.projectAppRequestText(req.ResolvedModel, appRequestModelMaxBytes),
		Provider:         requestIOProviderLabel(s, req.Provider),
		RouteReason:      project(req.RouteReason),
		Failover:         req.Failover,
		FallbackFrom:     requestIOProviderLabel(s, req.FallbackFrom),
		Languages:        []string{},
		PromptTokens:     clampAppRequestInt(req.PromptTokens),
		CompletionTokens: clampAppRequestInt(req.CompletionTokens),
		TotalTokens:      clampAppRequestInt(req.TotalTokens),
		CachedTokens:     clampAppRequestInt(req.CachedTokens),
		ReasoningTokens:  clampAppRequestInt(req.ReasoningTokens),
		TokenSource:      s.projectAppRequestText(req.TokenSource, appRequestModelMaxBytes),
		EstimatedCost:    clampAppRequestCost(req.EstimatedCost),
		Currency:         s.projectAppRequestText(req.Currency, appRequestCurrencyMaxBytes),
		LatencyMS:        clampAppRequestInt64(req.LatencyMS),
		FirstChunkMS:     clampAppRequestInt64(req.FirstChunkMS),
		APIKeyID:         s.projectAppRequestText(req.APIKeyID, appRequestIDMaxBytes),
		ClientIP:         boundedExternalIPAddress(req.ClientIP),
		UserAgent:        s.projectAppRequestText(req.UserAgent, appRequestEndpointMaxBytes),
		SessionID:        s.projectAppRequestText(req.SessionID, appRequestIDMaxBytes),
		TraceID:          s.projectAppRequestText(req.TraceID, appRequestIDMaxBytes),
		Input:            projectRequestIOInput(detail.Prompts, reveal, text),
		Output:           projectRequestIOOutput(detail, capture, text, project),
		Capture:          capture,
		Masked:           !reveal,
		RawAllowed:       rawAllowed,
	}
	for _, language := range detail.Languages {
		request.Languages = append(request.Languages, project(language.Language))
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, request)
}

func requestIOProviderLabel(s *Server, provider string) string {
	if provider == "" {
		return ""
	}
	label := boundedModelsProviderLabelOrEmpty(provider)
	if label == "" {
		return "공급자 미확인"
	}
	if len(provider) > appRequestProviderMaxBytes || label == providerNameOmitted || s.appRequestTextHasCredential(provider) {
		return appRequestProviderOmitted
	}
	return label
}

func projectRequestIOInput(prompts []store.PromptDetail, reveal bool, text func(string) string) requestIOInput {
	input := requestIOInput{State: requestIOStateMissing, Messages: []requestIOMessage{}}
	conversation := make([]store.PromptDetail, 0, len(prompts))
	for _, prompt := range prompts {
		if strings.EqualFold(prompt.Role, "tools") {
			input.ToolDefinitions = requestIOBoundedText(text(requestIOPromptText(prompt, reveal)))
			continue
		}
		conversation = append(conversation, prompt)
	}
	if len(conversation) > 0 {
		input.State = requestIOStateCaptured
	}
	// A long agent run keeps its first message, usually the system prompt, and its most
	// recent turns; the middle is what can be spared.
	if len(conversation) > requestIOMaxMessages {
		input.OmittedMessages = len(conversation) - requestIOMaxMessages
		conversation = append(conversation[:1:1], conversation[len(conversation)-requestIOMaxMessages+1:]...)
	}
	for _, prompt := range conversation {
		original := requestIOPromptText(prompt, reveal)
		projected := text(original)
		bounded := requestIOBoundedText(projected)
		input.Messages = append(input.Messages, requestIOMessage{
			Role:         text(prompt.Role),
			Text:         bounded,
			Chars:        utf8.RuneCountInString(projected),
			Truncated:    len(bounded) != len(projected),
			OriginalKept: prompt.ContentText != "" && prompt.ContentText != prompt.RedactedText,
		})
	}
	return input
}

// requestIOPromptText prefers the redacted copy, which is what the capture side always
// keeps; the raw copy exists only under LOG_RAW_PROMPTS.
func requestIOPromptText(prompt store.PromptDetail, reveal bool) string {
	if reveal && prompt.ContentText != "" {
		return prompt.ContentText
	}
	return prompt.RedactedText
}

func requestIOBoundedText(text string) string {
	if utf8.RuneCountInString(text) <= requestIOMaxTextRunes {
		return text
	}
	return string([]rune(text)[:requestIOMaxTextRunes])
}

// requestIOReachedCaptureLimit reads a stored body that fills the capture limit as cut off.
// The capture cuts at a UTF-8 boundary, so a cut body can stop up to one rune short of it.
func requestIOReachedCaptureLimit(stored string, limit int) bool {
	return limit > 0 && len(stored) >= limit-utf8.UTFMax
}

func projectRequestIOOutput(detail store.RequestDetail, capture requestIOCapture, text, project func(string) string) requestIOOutput {
	output := requestIOOutput{
		State: requestIOStateMissing, Kind: requestOutputKindNone,
		ToolCalls: []requestIOToolCall{},
	}
	seenTool := map[string]struct{}{}
	for _, tool := range detail.Tools {
		if tool.Source != "call" {
			continue
		}
		if _, duplicate := seenTool[tool.ToolName]; duplicate {
			continue
		}
		seenTool[tool.ToolName] = struct{}{}
		output.ToolCalls = append(output.ToolCalls, requestIOToolCall{Name: text(tool.ToolName)})
	}
	if detail.Response == nil {
		return output
	}
	output.State = requestIOStateNotCaptured
	output.FinishReason = text(detail.Response.FinishReason)
	extracted := extractRequestOutput(detail.Response.ResponseTextOptional, detail.Request.StatusCode)
	if extracted.Kind == requestOutputKindNone {
		return output
	}
	output.State = requestIOStateCaptured
	output.Kind = extracted.Kind
	output.OriginalKept = project(extracted.Text) != extracted.Text
	for _, call := range extracted.ToolCalls {
		output.OriginalKept = output.OriginalKept || project(call.Arguments) != call.Arguments
	}
	projected := text(extracted.Text)
	bounded := requestIOBoundedText(projected)
	output.Text = bounded
	output.Chars = utf8.RuneCountInString(projected)
	output.Truncated = extracted.Partial || len(bounded) != len(projected) ||
		requestIOReachedCaptureLimit(detail.Response.ResponseTextOptional, capture.ResponseMaxBytes)
	if len(extracted.ToolCalls) > 0 {
		// The stored body names the calls and their arguments; the tool rows only the name.
		output.ToolCalls = make([]requestIOToolCall, 0, len(extracted.ToolCalls))
		for _, call := range extracted.ToolCalls {
			output.ToolCalls = append(output.ToolCalls, requestIOToolCall{
				Name: text(call.Name), Arguments: requestIOBoundedText(text(call.Arguments)),
			})
		}
	}
	return output
}
