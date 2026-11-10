package proxy

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"vibe-coders/internal/audit"
)

const (
	// analyzerParseLimitBytes bounds what one response may hold in memory for metering:
	// the JSON body being parsed, a single SSE line, and the assembled text and tool
	// arguments. It is deliberately far above LOG_RESPONSE_MAX_BYTES, which decides what
	// is persisted and must not decide whether usage can be read at all.
	analyzerParseLimitBytes = 16 << 20
	// analyzerErrorHeadBytes is how much of a streamed body is kept to explain a failed
	// request when response text logging is off.
	analyzerErrorHeadBytes = 4 << 10
	// analyzerMaxToolCalls bounds the calls tracked per response. The byte budget alone
	// would still allow millions of one-byte names.
	analyzerMaxToolCalls = 1024
	// upstreamErrorMaxBytes bounds the text written to request_logs.error.
	upstreamErrorMaxBytes = 512
	// upstreamErrorScanBytes bounds the message handed to the redactor.
	upstreamErrorScanBytes = 64 << 10
	// finishReasonClientDisconnected marks a response the client walked away from. It is
	// a finish reason and not request_logs.error on purpose: every success rate, error
	// budget and routing signal reads that column as a provider failure, and a client
	// leaving says nothing about the provider.
	finishReasonClientDisconnected = "client_disconnected"
)

type ResponseAnalysis struct {
	Hash                     string
	Text                     string // raw captured bytes; used for cache replay and error bodies
	Truncated                bool   // the body outgrew the raw capture, so Text must not be replayed
	CompletionText           string // extracted content text; used for display/logging
	FinishReason             string
	Usage                    audit.Usage
	HasUsage                 bool
	CompletionTokensEstimate int
	ToolCalls                []parsedTool
	ToolOutputs              []capturedToolCall // the calls with their assembled arguments
	UpstreamError            string             // the error an upstream reported inside its body
	ErrorBody                string             // start of the body, to explain a failed request
}

// capturedToolCall is one tool call the model made, reassembled from its fragments.
type capturedToolCall struct {
	Name      string
	Arguments string
}

type analyzedToolCall struct {
	id        string
	order     int
	name      string
	arguments strings.Builder
	cut       bool
}

type ResponseAnalyzer struct {
	stream       bool
	captureText  bool
	maxBytes     int
	parseLimit   int
	written      int64
	hasher       hash.Hash
	raw          bytes.Buffer // non-stream: the body to parse; stream: Text, when captured
	errorHead    []byte       // stream only; a non-stream body already starts raw
	lineBuffer   []byte
	lineTooLong  bool // the current SSE line outgrew parseLimit and is being skipped
	finishReason string
	completion   strings.Builder
	retained     int // bytes of completion and tool arguments held, against parseLimit
	unstored     int // runes seen past parseLimit, counted rather than kept
	usage        audit.Usage
	hasUsage     bool
	// tool calls arrive in fragments keyed by index or item id; the arguments are
	// accumulated here and ordered once the response is complete.
	calls         []*analyzedToolCall
	callsByKey    map[string]*analyzedToolCall
	upstreamError string
}

func NewResponseAnalyzer(stream bool, captureText bool, maxBytes int) *ResponseAnalyzer {
	if maxBytes < 0 {
		maxBytes = 0
	}
	return &ResponseAnalyzer{
		stream:      stream,
		captureText: captureText,
		maxBytes:    maxBytes,
		parseLimit:  max(maxBytes, analyzerParseLimitBytes),
		hasher:      sha256.New(),
	}
}

func (a *ResponseAnalyzer) Write(p []byte) {
	_, _ = a.hasher.Write(p)
	a.written += int64(len(p))
	if !a.stream {
		appendUpTo(&a.raw, p, a.parseLimit)
		return
	}
	if room := analyzerErrorHeadBytes - len(a.errorHead); room > 0 {
		a.errorHead = append(a.errorHead, p[:min(room, len(p))]...)
	}
	if a.captureText {
		appendUpTo(&a.raw, p, a.maxBytes)
	}
	a.consumeSSE(p)
}

func appendUpTo(buffer *bytes.Buffer, p []byte, limit int) {
	if room := limit - buffer.Len(); room > 0 {
		buffer.Write(p[:min(room, len(p))])
	}
}

func (a *ResponseAnalyzer) Finalize() ResponseAnalysis {
	if a.stream && len(a.lineBuffer) > 0 && !a.lineTooLong {
		a.consumeSSELine(string(a.lineBuffer))
	}
	a.lineBuffer = nil
	errorBody := a.errorHead
	if !a.stream {
		a.parseChunk(a.raw.Bytes())
		errorBody = a.raw.Bytes()[:min(a.raw.Len(), analyzerErrorHeadBytes)]
	}

	text := ""
	if a.captureText {
		text = string(a.raw.Bytes()[:min(a.raw.Len(), a.maxBytes)])
	}
	completionText := a.completion.String()

	// Fragments can arrive out of order, and delta.tool_calls carries the call order in
	// its index, so sort by it; the tool_invocations rows of one response would otherwise
	// land in a different order on every run.
	sort.SliceStable(a.calls, func(i, j int) bool { return a.calls[i].order < a.calls[j].order })
	var toolCalls []parsedTool
	var toolOutputs []capturedToolCall
	estimate := audit.EstimateTokens(completionText) + (a.unstored+3)/4
	for _, call := range a.calls {
		arguments := call.arguments.String()
		estimate += audit.EstimateTokens(arguments)
		toolOutputs = append(toolOutputs, capturedToolCall{Name: call.name, Arguments: arguments})
		if call.name == "" {
			continue
		}
		parsed := parsedTool{Source: "call"}
		parsed.Server, parsed.Tool, parsed.IsMCP = classifyToolName(call.name)
		if !call.cut {
			// A hash of part of the arguments would match nothing, so a cut call has none.
			parsed.ArgHash = hashArgs(arguments)
		}
		toolCalls = append(toolCalls, parsed)
	}

	return ResponseAnalysis{
		Hash:                     hex.EncodeToString(a.hasher.Sum(nil)),
		Text:                     text,
		Truncated:                a.written > int64(a.maxBytes),
		CompletionText:           completionText,
		FinishReason:             a.finishReason,
		Usage:                    a.usage,
		HasUsage:                 a.hasUsage,
		CompletionTokensEstimate: estimate,
		ToolCalls:                toolCalls,
		ToolOutputs:              toolOutputs,
		UpstreamError:            a.upstreamError,
		ErrorBody:                string(errorBody),
	}
}

func (a *ResponseAnalyzer) consumeSSE(p []byte) {
	for len(p) > 0 {
		idx := bytes.IndexByte(p, '\n')
		if idx < 0 {
			a.bufferLine(p)
			return
		}
		a.bufferLine(p[:idx])
		if !a.lineTooLong {
			a.consumeSSELine(string(a.lineBuffer))
		}
		a.lineBuffer = a.lineBuffer[:0]
		a.lineTooLong = false
		p = p[idx+1:]
	}
}

// bufferLine holds a partial line until its newline arrives. A line past the limit is
// dropped whole: an upstream that never sends a newline must not grow this forever, and
// the front of a JSON document is no use to the parser.
func (a *ResponseAnalyzer) bufferLine(part []byte) {
	if a.lineTooLong {
		return
	}
	if len(a.lineBuffer)+len(part) > a.parseLimit {
		a.lineTooLong = true
		a.lineBuffer = nil
		return
	}
	a.lineBuffer = append(a.lineBuffer, part...)
}

func (a *ResponseAnalyzer) consumeSSELine(line string) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "data:") {
		return
	}
	payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
	if payload == "" || payload == "[DONE]" {
		return
	}
	a.parseChunk([]byte(payload))
}

type analyzerToolFragment struct {
	Index    *int   `json:"index"`
	ID       string `json:"id"`
	Function struct {
		Name      string `json:"name"`
		Arguments any    `json:"arguments"`
	} `json:"function"`
}

type analyzerMessage struct {
	Content      any                    `json:"content"`
	Refusal      any                    `json:"refusal"`
	ToolCalls    []analyzerToolFragment `json:"tool_calls"`
	FunctionCall *struct {
		Name      string `json:"name"`
		Arguments any    `json:"arguments"`
	} `json:"function_call"`
}

type analyzerUsage struct {
	PromptTokens        int `json:"prompt_tokens"`
	CompletionTokens    int `json:"completion_tokens"`
	TotalTokens         int `json:"total_tokens"`
	PromptTokensDetails *struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	CompletionTokensDetails *struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
	// The /v1/responses and Anthropic names for the same counts.
	InputTokens        int `json:"input_tokens"`
	OutputTokens       int `json:"output_tokens"`
	InputTokensDetails *struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"input_tokens_details"`
	OutputTokensDetails *struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"output_tokens_details"`
}

// analyzerChunk is one JSON body or SSE event. The fields past Choices appear only in
// /v1/responses and Anthropic Messages traffic, so they stay raw until an event needs them.
type analyzerChunk struct {
	Type    string `json:"type"`
	Choices []struct {
		Index        int             `json:"index"`
		Delta        analyzerMessage `json:"delta"`
		Message      analyzerMessage `json:"message"`
		Text         any             `json:"text"`
		FinishReason any             `json:"finish_reason"`
	} `json:"choices"`
	Usage             *analyzerUsage `json:"usage"`
	Object            string         `json:"object"`
	Status            string         `json:"status"`
	IncompleteDetails *struct {
		Reason string `json:"reason"`
	} `json:"incomplete_details"`
	Output       json.RawMessage `json:"output"`
	OutputText   any             `json:"output_text"`
	Response     json.RawMessage `json:"response"`
	Delta        json.RawMessage `json:"delta"`
	Item         json.RawMessage `json:"item"`
	ItemID       string          `json:"item_id"`
	OutputIndex  int             `json:"output_index"`
	Arguments    any             `json:"arguments"`
	Content      json.RawMessage `json:"content"`
	ContentBlock json.RawMessage `json:"content_block"`
	Index        int             `json:"index"`
	Message      json.RawMessage `json:"message"`
	StopReason   string          `json:"stop_reason"`
}

var analyzerErrorKey = []byte(`"error"`)

func (a *ResponseAnalyzer) parseChunk(payload []byte) {
	var chunk analyzerChunk
	if err := json.Unmarshal(payload, &chunk); err != nil {
		// A type mismatch in one field still decodes the rest; only a body that is not
		// JSON at all has nothing to read.
		var mismatch *json.UnmarshalTypeError
		if !errors.As(err, &mismatch) {
			return
		}
	}
	for _, choice := range chunk.Choices {
		a.addCompletion(contentString(choice.Delta.Content))
		a.addCompletion(contentString(choice.Message.Content))
		a.addCompletion(contentString(choice.Text))
		a.addCompletion(contentString(choice.Delta.Refusal))
		a.addCompletion(contentString(choice.Message.Refusal))
		a.consumeChatToolCalls(choice.Index, choice.Message, false)
		a.consumeChatToolCalls(choice.Index, choice.Delta, true)

		if choice.FinishReason == nil {
			continue
		}
		if value, ok := choice.FinishReason.(string); ok && value != "" {
			a.finishReason = value
		}
	}
	if chunk.Usage != nil {
		a.applyUsage(*chunk.Usage)
	}
	a.consumeResponsesEvent(&chunk)
	a.consumeResponsesBody(&chunk)
	a.consumeAnthropic(&chunk)
	// An upstream's own quotes inside a model's text arrive escaped, so the literal only
	// matches a real key or value, and most chunks skip the second decode.
	if len(chunk.Choices) == 0 && a.upstreamError == "" && bytes.Contains(payload, analyzerErrorKey) {
		var root map[string]any
		if json.Unmarshal(payload, &root) == nil {
			a.upstreamError = upstreamErrorMessage(root)
		}
	}
}

// consumeChatToolCalls merges whole calls and stream fragments alike. Fragments carry the
// index of their call and only the first carries the name; a message lists whole calls.
func (a *ResponseAnalyzer) consumeChatToolCalls(choice int, message analyzerMessage, fragments bool) {
	for position, call := range message.ToolCalls {
		order := position
		if fragments && call.Index != nil {
			order = *call.Index
		}
		key := "choice/" + strconv.Itoa(choice) + "/" + strconv.Itoa(order)
		if prior := a.callsByKey[key]; prior != nil && call.ID != "" && prior.id != "" && prior.id != call.ID {
			// Some compatible providers send every call at index 0, told apart only by id.
			key += "/" + call.ID
			order = len(a.calls)
		}
		a.addToolFragment(key, choice*analyzerMaxToolCalls+order, call.ID, call.Function.Name, argsString(call.Function.Arguments))
	}
	if call := message.FunctionCall; call != nil {
		a.addToolFragment("choice/"+strconv.Itoa(choice)+"/function_call", choice*analyzerMaxToolCalls, "", call.Name, argsString(call.Arguments))
	}
}

// consumeResponsesEvent handles the /v1/responses stream.
func (a *ResponseAnalyzer) consumeResponsesEvent(chunk *analyzerChunk) {
	switch chunk.Type {
	case "response.output_text.delta", "response.refusal.delta":
		var delta string
		if json.Unmarshal(chunk.Delta, &delta) == nil {
			a.addCompletion(delta)
		}
	case "response.output_item.added", "response.output_item.done":
		var item responsesOutputItem
		if json.Unmarshal(chunk.Item, &item) == nil {
			a.consumeResponsesCall(item, chunk.OutputIndex, chunk.Type == "response.output_item.done")
		}
	case "response.function_call_arguments.delta":
		var delta string
		if json.Unmarshal(chunk.Delta, &delta) == nil {
			a.addToolFragment("item/"+chunk.ItemID, chunk.OutputIndex, chunk.ItemID, "", delta)
		}
	case "response.function_call_arguments.done":
		a.fillToolArguments("item/"+chunk.ItemID, argsString(chunk.Arguments))
	case "response.completed", "response.incomplete", "response.failed":
		var inner analyzerChunk
		if err := json.Unmarshal(chunk.Response, &inner); err != nil {
			var mismatch *json.UnmarshalTypeError
			if !errors.As(err, &mismatch) {
				return
			}
		}
		if inner.Usage != nil {
			a.applyUsage(*inner.Usage)
		}
		a.consumeResponsesBody(&inner)
	}
}

// consumeResponsesBody reads a whole response object: the non-stream body, or the one a
// stream's final event carries. That event repeats the answer the deltas already delivered,
// so its text only counts when no delta came, and calls are matched to theirs by item id.
func (a *ResponseAnalyzer) consumeResponsesBody(chunk *analyzerChunk) {
	if len(chunk.Output) == 0 && chunk.Object != "response" {
		return
	}
	incomplete := ""
	if chunk.IncompleteDetails != nil {
		incomplete = chunk.IncompleteDetails.Reason
	}
	if reason := responsesFinishReason(chunk.Status, incomplete); reason != "" {
		a.finishReason = reason
	}
	streamedText := a.completion.Len() > 0
	var items []responsesOutputItem
	if json.Unmarshal(chunk.Output, &items) == nil {
		for position, item := range items {
			if item.Type != "message" {
				a.consumeResponsesCall(item, position, true)
			} else if !streamedText {
				a.addCompletion(responsesContentText(item.Content))
			}
		}
	}
	if a.completion.Len() == 0 {
		a.addCompletion(contentString(chunk.OutputText))
	}
}

type responsesOutputItem struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	CallID    string `json:"call_id"`
	Name      string `json:"name"`
	Arguments any    `json:"arguments"`
	Content   any    `json:"content"`
}

// consumeResponsesCall records a named output item; a message or a reasoning item has no
// name. Its arguments may have arrived as deltas already, so a finished item only fills
// them in when they did not.
func (a *ResponseAnalyzer) consumeResponsesCall(item responsesOutputItem, order int, finished bool) {
	if item.Name == "" {
		return
	}
	id := firstNonEmpty(item.ID, item.CallID, strconv.Itoa(order))
	key := "item/" + id
	a.addToolFragment(key, order, id, item.Name, "")
	if finished {
		a.fillToolArguments(key, argsString(item.Arguments))
	}
}

func responsesFinishReason(status, incomplete string) string {
	switch status {
	case "completed":
		return "stop"
	case "incomplete":
		return firstNonEmpty(incomplete, status)
	case "failed", "cancelled":
		return status
	}
	return ""
}

// responsesContentText reads the output_text and refusal parts of a message item.
func responsesContentText(content any) string {
	parts, ok := content.([]any)
	if !ok {
		return contentString(content)
	}
	var builder strings.Builder
	for _, entry := range parts {
		part, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		builder.WriteString(contentPartText(part))
		if refusal, ok := part["refusal"].(string); ok {
			builder.WriteString(refusal)
		}
	}
	return builder.String()
}

// consumeAnthropic reads Anthropic Messages traffic, which reaches the upstream through
// the /v1/ catch-all. Its usage arrives split: input tokens on message_start, output
// tokens on message_delta (see applyUsage).
func (a *ResponseAnalyzer) consumeAnthropic(chunk *analyzerChunk) {
	switch chunk.Type {
	case "message":
		a.finishReasonFrom(chunk.StopReason)
		var blocks []anthropicContentBlock
		if json.Unmarshal(chunk.Content, &blocks) != nil {
			return
		}
		for position, block := range blocks {
			if block.Type == "tool_use" {
				a.addToolFragment("block/"+strconv.Itoa(position), position, block.ID, block.Name, argsString(block.Input))
				continue
			}
			a.addCompletion(block.Text)
		}
	case "message_start":
		var message struct {
			Usage *analyzerUsage `json:"usage"`
		}
		if json.Unmarshal(chunk.Message, &message) == nil && message.Usage != nil {
			a.applyUsage(*message.Usage)
		}
	case "message_delta":
		var delta struct {
			StopReason string `json:"stop_reason"`
		}
		if json.Unmarshal(chunk.Delta, &delta) == nil {
			a.finishReasonFrom(delta.StopReason)
		}
	case "content_block_start":
		var block anthropicContentBlock
		if json.Unmarshal(chunk.ContentBlock, &block) == nil && block.Type == "tool_use" {
			a.addToolFragment("block/"+strconv.Itoa(chunk.Index), chunk.Index, block.ID, block.Name, "")
		}
	case "content_block_delta":
		var delta struct {
			Text        string `json:"text"`
			PartialJSON string `json:"partial_json"`
		}
		if json.Unmarshal(chunk.Delta, &delta) == nil {
			a.addCompletion(delta.Text)
			a.addToolFragment("block/"+strconv.Itoa(chunk.Index), chunk.Index, "", "", delta.PartialJSON)
		}
	}
}

type anthropicContentBlock struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	Name  string `json:"name"`
	Text  string `json:"text"`
	Input any    `json:"input"`
}

func (a *ResponseAnalyzer) finishReasonFrom(reason string) {
	if reason != "" {
		a.finishReason = reason
	}
}

// keep returns the part of s that still fits the retained-text budget and counts the rest,
// so the completion estimate keeps growing after the text stops being stored.
func (a *ResponseAnalyzer) keep(s string) string {
	if room := a.parseLimit - a.retained; len(s) > room {
		kept := cutAtUTF8Boundary(s, room)
		a.unstored += utf8.RuneCountInString(s[len(kept):])
		s = kept
	}
	a.retained += len(s)
	return s
}

func (a *ResponseAnalyzer) addCompletion(text string) {
	if text != "" {
		a.completion.WriteString(a.keep(text))
	}
}

func (a *ResponseAnalyzer) addToolFragment(key string, order int, id, name, arguments string) {
	call := a.callsByKey[key]
	if call == nil {
		if (name == "" && arguments == "") || len(a.calls) >= analyzerMaxToolCalls {
			return
		}
		call = &analyzedToolCall{id: id, order: order}
		a.calls = append(a.calls, call)
		if a.callsByKey == nil {
			a.callsByKey = map[string]*analyzedToolCall{}
		}
		a.callsByKey[key] = call
	}
	if call.name == "" {
		call.name = a.keep(name)
	}
	if arguments != "" {
		kept := a.keep(arguments)
		call.cut = call.cut || len(kept) != len(arguments)
		call.arguments.WriteString(kept)
	}
}

// fillToolArguments takes the whole arguments of a finished call when no delta delivered
// them; when the deltas did, this is a repeat of the same text.
func (a *ResponseAnalyzer) fillToolArguments(key, arguments string) {
	if call := a.callsByKey[key]; call != nil && call.arguments.Len() == 0 && !call.cut {
		a.addToolFragment(key, call.order, "", "", arguments)
	}
}

// applyUsage records a usage report. An empty block reports nothing, and must not replace
// a real one or stop the pipeline from estimating. A later report of the output side only
// (Anthropic's message_delta) keeps the input side an earlier event reported.
func (a *ResponseAnalyzer) applyUsage(reported analyzerUsage) {
	usage := audit.Usage{
		PromptTokens:     max(reported.PromptTokens, reported.InputTokens),
		CompletionTokens: max(reported.CompletionTokens, reported.OutputTokens),
		TotalTokens:      reported.TotalTokens,
		Source:           "usage",
	}
	if usage.PromptTokens == 0 && usage.CompletionTokens == 0 && usage.TotalTokens == 0 {
		return
	}
	if details := reported.PromptTokensDetails; details != nil {
		usage.CachedTokens = details.CachedTokens
	}
	if details := reported.InputTokensDetails; details != nil {
		usage.CachedTokens = max(usage.CachedTokens, details.CachedTokens)
	}
	if details := reported.CompletionTokensDetails; details != nil {
		usage.ReasoningTokens = details.ReasoningTokens
	}
	if details := reported.OutputTokensDetails; details != nil {
		usage.ReasoningTokens = max(usage.ReasoningTokens, details.ReasoningTokens)
	}
	if a.hasUsage && usage.PromptTokens == 0 {
		usage.PromptTokens = a.usage.PromptTokens
		usage.CachedTokens = max(usage.CachedTokens, a.usage.CachedTokens)
	}
	if usage.TotalTokens == 0 {
		usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
	}
	a.usage = usage
	a.hasUsage = true
}

// contentString flattens an OpenAI-compatible content field into plain text. Besides a
// bare string, providers also answer with structured content parts
// ([{"type":"text","text":"..."}]), which the request side already flattens in
// flattenContent. Dropping them here left CompletionText empty for those responses, so
// the completion token estimate used when a response carries no usage block came out 0.
// Parts with no text (image/audio) still contribute nothing rather than their raw JSON,
// which would inflate that estimate.
func contentString(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case map[string]any:
		return contentPartText(v)
	case []any:
		var builder strings.Builder
		for _, item := range v {
			builder.WriteString(contentString(item))
		}
		return builder.String()
	default:
		return ""
	}
}

// contentPartText pulls the text out of a single structured content part.
func contentPartText(part map[string]any) string {
	if text, ok := part["text"].(string); ok {
		return text
	}
	if text, ok := part["input_text"].(string); ok {
		return text
	}
	return ""
}

// persistedResponseText decides what response_logs keeps. Clean text is stored, never the
// raw SSE or JSON the answer arrived in: the raw bytes belong to cache replay, and a secret
// split across deltas only reaches the redactor once it has been reassembled. Error bodies
// are the exception, since the body is the error.
//
// Personal data and secrets are masked before anything is stored, as prompts already are,
// so the database never holds what a screen would have to hide. Tool calls are masked field
// by field before the envelope is encoded, where a replacement cannot break the JSON.
func persistedResponseText(analysis ResponseAnalysis, statusCode, maxBytes int) string {
	if statusCode >= http.StatusBadRequest {
		return cutAtUTF8Boundary(audit.Redact(analysis.Text), maxBytes)
	}
	text := audit.Redact(analysis.CompletionText)
	if len(analysis.ToolOutputs) > 0 {
		calls := make([]capturedToolCall, len(analysis.ToolOutputs))
		for i, call := range analysis.ToolOutputs {
			calls[i] = capturedToolCall{Name: call.Name, Arguments: audit.Redact(call.Arguments)}
		}
		return toolCallEnvelope(text, calls, maxBytes)
	}
	if analysis.CompletionText == "" {
		// Vectors and image bytes are not worth keeping, but what came back still is.
		output := extractRequestOutput(analysis.Text, statusCode)
		if output.Kind == requestOutputKindEmbedding || output.Kind == requestOutputKindImage {
			return cutAtUTF8Boundary(output.Text, maxBytes)
		}
	}
	return cutAtUTF8Boundary(text, maxBytes)
}

type toolEnvelope struct {
	Choices []toolEnvelopeChoice `json:"choices"`
}

type toolEnvelopeChoice struct {
	Message toolEnvelopeMessage `json:"message"`
}

type toolEnvelopeMessage struct {
	Content   *string            `json:"content"`
	ToolCalls []toolEnvelopeCall `json:"tool_calls"`
}

type toolEnvelopeCall struct {
	Function toolEnvelopeFunction `json:"function"`
}

type toolEnvelopeFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// toolCallEnvelope renders calls in the chat-completion shape extractRequestOutput reads.
// It stays valid JSON at any limit, so the fields are cut rather than the document: a
// document cut mid-string could not be read back as tool calls at all. Escaping makes the
// encoded size hard to predict, hence shrinking by ratio until it fits. A limit too small
// for the document's own structure keeps nothing.
func toolCallEnvelope(text string, calls []capturedToolCall, maxBytes int) string {
	calls = append([]capturedToolCall(nil), calls...)
	encoded := encodeToolEnvelope(text, calls)
	for attempt := 0; len(encoded) > maxBytes && attempt < 8; attempt++ {
		ratio := 0.9 * float64(maxBytes) / float64(len(encoded))
		text = cutAtUTF8Boundary(text, int(float64(len(text))*ratio))
		for i := range calls {
			calls[i].Arguments = cutAtUTF8Boundary(calls[i].Arguments, int(float64(len(calls[i].Arguments))*ratio))
		}
		encoded = encodeToolEnvelope(text, calls)
	}
	if len(encoded) > maxBytes {
		return ""
	}
	return encoded
}

func encodeToolEnvelope(text string, calls []capturedToolCall) string {
	message := toolEnvelopeMessage{ToolCalls: make([]toolEnvelopeCall, 0, len(calls))}
	if text != "" {
		message.Content = &text
	}
	for _, call := range calls {
		message.ToolCalls = append(message.ToolCalls, toolEnvelopeCall{Function: toolEnvelopeFunction{Name: call.Name, Arguments: call.Arguments}})
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	// Escaping <, > and & would only spend the byte limit; the document is never HTML.
	encoder.SetEscapeHTML(false)
	if encoder.Encode(toolEnvelope{Choices: []toolEnvelopeChoice{{Message: message}}}) != nil {
		return ""
	}
	return strings.TrimSuffix(buffer.String(), "\n")
}

// cutAtUTF8Boundary cuts s to at most limit bytes without splitting a character. A limit of
// zero or less keeps nothing.
func cutAtUTF8Boundary(s string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(s) <= limit {
		return s
	}
	for limit > 0 && !utf8.RuneStart(s[limit]) {
		limit--
	}
	return s[:limit]
}

// upstreamErrorMessage reads an error envelope: OpenAI's {"error":{...}} or {"error":"..."},
// the stream's {"type":"error","message":...} and {"type":"response.failed",
// "response":{"error":{...}}}, and Anthropic's {"type":"error","error":{...}}.
func upstreamErrorMessage(root map[string]any) string {
	switch value := root["error"].(type) {
	case string:
		if value != "" {
			return value
		}
	case map[string]any:
		if message := upstreamErrorObjectMessage(value); message != "" {
			return message
		}
	}
	if response, ok := root["response"].(map[string]any); ok {
		if value, ok := response["error"].(map[string]any); ok {
			if message := upstreamErrorObjectMessage(value); message != "" {
				return message
			}
		}
	}
	if root["type"] == "error" {
		return upstreamErrorObjectMessage(root)
	}
	return ""
}

func upstreamErrorObjectMessage(value map[string]any) string {
	message, _ := value["message"].(string)
	code, _ := value["code"].(string)
	if code == "" {
		if kind, _ := value["type"].(string); kind != "error" {
			code = kind
		}
	}
	switch {
	case message != "" && code != "":
		return message + " (" + code + ")"
	case message != "":
		return message
	}
	return code
}

// upstreamErrorFromBody explains a failed status from its body: a known envelope, the bare
// message fields of other servers, or plain text. A proxy's HTML error page says nothing
// the status does not.
func upstreamErrorFromBody(body string) string {
	trimmed := strings.TrimSpace(body)
	if trimmed == "" || trimmed[0] == '<' {
		return ""
	}
	var root map[string]any
	if json.Unmarshal([]byte(trimmed), &root) != nil {
		return strings.Join(strings.Fields(trimmed), " ")
	}
	if message := upstreamErrorMessage(root); message != "" {
		return message
	}
	for _, key := range []string{"message", "detail", "msg"} {
		if message, ok := root[key].(string); ok && message != "" {
			return message
		}
	}
	return ""
}

// boundedUpstreamError is what reaches request_logs.error, which is shown without the
// reveal step response text has. Redacting first means the cut cannot leave half a secret
// too short for the rules to recognize.
func boundedUpstreamError(label, message string) string {
	if message == "" {
		return label
	}
	redacted := audit.Redact(cutAtUTF8Boundary(message, upstreamErrorScanBytes))
	return cutAtUTF8Boundary(label+": "+redacted, upstreamErrorMaxBytes)
}

// upstreamFailureText explains a response that failed, whether by status or by an error the
// upstream reported inside a 200.
func upstreamFailureText(statusCode int, analysis ResponseAnalysis) string {
	if statusCode >= http.StatusBadRequest {
		message := analysis.UpstreamError
		if message == "" {
			message = upstreamErrorFromBody(analysis.ErrorBody)
		}
		return boundedUpstreamError("upstream_"+strconv.Itoa(statusCode), message)
	}
	if analysis.UpstreamError != "" {
		return boundedUpstreamError("upstream_error", analysis.UpstreamError)
	}
	return ""
}
