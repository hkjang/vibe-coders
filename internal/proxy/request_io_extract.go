package proxy

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

const (
	requestOutputKindNone      = "none"
	requestOutputKindText      = "text"
	requestOutputKindToolCalls = "tool_calls"
	requestOutputKindError     = "error"
	requestOutputKindEmbedding = "embedding"
	requestOutputKindImage     = "image"
)

type requestIOToolCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// requestOutput is what a model actually answered, recovered from a stored response.
type requestOutput struct {
	Kind      string
	Text      string
	ToolCalls []requestIOToolCall
	// Partial marks a body the capture limit cut off: the text is real but incomplete.
	Partial bool
}

// extractRequestOutput recovers the answer from a stored response body. The capture side
// stores clean text only when the analyzer recognized plain content, so tool calls, error
// bodies, embeddings and /v1/responses traffic are stored as the raw JSON or SSE they
// arrived in. Showing that verbatim buries the answer, so every shape is read back here.
// A statusCode below 400 keeps a JSON-mode answer like {"error":"none"} from being
// mistaken for an upstream failure.
func extractRequestOutput(raw string, statusCode int) requestOutput {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return requestOutput{Kind: requestOutputKindNone}
	}
	acc := &requestOutputAccumulator{toolByIndex: map[string]int{}}
	if strings.HasPrefix(trimmed, "data:") || strings.HasPrefix(trimmed, "event:") {
		if acc.consumeSSE(trimmed) {
			return acc.finish(raw)
		}
		return requestOutput{Kind: requestOutputKindText, Text: raw}
	}
	if !strings.HasPrefix(trimmed, "{") {
		return requestOutput{Kind: requestOutputKindText, Text: raw}
	}
	var root map[string]any
	if err := json.Unmarshal([]byte(trimmed), &root); err != nil {
		return salvageRequestOutput(raw, trimmed)
	}
	if statusCode >= 400 {
		acc.consumeError(root)
	}
	acc.consume(root)
	if !acc.found() {
		// A JSON-mode answer or an envelope nothing here recognizes: the text is the answer.
		return requestOutput{Kind: requestOutputKindText, Text: raw}
	}
	return acc.finish(raw)
}

var requestOutputPartialField = regexp.MustCompile(`"(?:content|text|output_text|delta)"\s*:\s*"`)

// salvageRequestOutput reads the first text field out of a JSON envelope the capture limit
// cut off, which no longer parses. Anything else is plain text that merely starts with "{".
func salvageRequestOutput(raw, trimmed string) requestOutput {
	head := trimmed
	if len(head) > 4096 {
		head = head[:4096]
	}
	if !strings.Contains(head, `"choices"`) && !strings.Contains(head, `"output"`) {
		return requestOutput{Kind: requestOutputKindText, Text: raw}
	}
	for _, match := range requestOutputPartialField.FindAllStringIndex(trimmed, 16) {
		if text := decodePartialJSONString(trimmed[match[1]:]); text != "" {
			return requestOutput{Kind: requestOutputKindText, Text: text, Partial: true}
		}
	}
	return requestOutput{Kind: requestOutputKindText, Text: raw, Partial: true}
}

// decodePartialJSONString decodes a JSON string body that may stop at any byte, including
// in the middle of an escape sequence, which is dropped.
func decodePartialJSONString(value string) string {
	end := len(value)
	escaped := false
	for i := 0; i < len(value); i++ {
		if escaped {
			escaped = false
			continue
		}
		if value[i] == '\\' {
			escaped = true
			continue
		}
		if value[i] == '"' {
			end = i
			break
		}
	}
	body := value[:end]
	for candidate := body; candidate != ""; candidate = candidate[:len(candidate)-1] {
		var decoded string
		if json.Unmarshal([]byte(`"`+candidate+`"`), &decoded) == nil {
			return decoded
		}
		if len(body)-len(candidate) >= 6 {
			break
		}
	}
	return ""
}

type requestOutputAccumulator struct {
	text        strings.Builder
	tools       []requestIOToolCall
	toolByIndex map[string]int
	errorText   string
	embeddings  int
	dimensions  int
	images      int
}

func (a *requestOutputAccumulator) found() bool {
	return a.text.Len() > 0 || len(a.tools) > 0 || a.errorText != "" || a.embeddings > 0 || a.images > 0
}

func (a *requestOutputAccumulator) finish(raw string) requestOutput {
	switch {
	case a.errorText != "" && a.text.Len() == 0 && len(a.tools) == 0:
		return requestOutput{Kind: requestOutputKindError, Text: a.errorText}
	case a.text.Len() > 0:
		return requestOutput{Kind: requestOutputKindText, Text: a.text.String(), ToolCalls: a.tools}
	case len(a.tools) > 0:
		return requestOutput{Kind: requestOutputKindToolCalls, ToolCalls: a.tools}
	case a.embeddings > 0:
		return requestOutput{Kind: requestOutputKindEmbedding, Text: fmt.Sprintf("임베딩 벡터 %d개 · %d차원", a.embeddings, a.dimensions)}
	case a.images > 0:
		return requestOutput{Kind: requestOutputKindImage, Text: fmt.Sprintf("생성된 이미지 %d개", a.images)}
	}
	return requestOutput{Kind: requestOutputKindText, Text: raw}
}

// consumeSSE reports whether the body really was an event stream; a plain answer may
// happen to begin with "data:".
func (a *requestOutputAccumulator) consumeSSE(body string) bool {
	recognized := false
	for line := range strings.SplitSeq(body, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "[DONE]" {
			recognized = true
			continue
		}
		var root map[string]any
		if json.Unmarshal([]byte(payload), &root) != nil {
			// The capture limit can cut the last line; earlier events still stand.
			continue
		}
		recognized = true
		a.consumeError(root)
		a.consume(root)
	}
	return recognized && a.found()
}

// consumeError reads an error envelope: OpenAI's {"error":{...}} or {"error":"..."} and
// the streaming {"type":"response.failed","response":{"error":{...}}}.
func (a *requestOutputAccumulator) consumeError(root map[string]any) {
	if a.errorText != "" {
		return
	}
	switch value := root["error"].(type) {
	case string:
		a.errorText = value
	case map[string]any:
		a.errorText = requestOutputErrorMessage(value)
	}
	if a.errorText == "" {
		if response, ok := root["response"].(map[string]any); ok {
			if value, ok := response["error"].(map[string]any); ok {
				a.errorText = requestOutputErrorMessage(value)
			}
		}
	}
}

func requestOutputErrorMessage(value map[string]any) string {
	message, _ := value["message"].(string)
	code, _ := value["code"].(string)
	if code == "" {
		code, _ = value["type"].(string)
	}
	switch {
	case message != "" && code != "":
		return message + " (" + code + ")"
	case message != "":
		return message
	}
	return code
}

func (a *requestOutputAccumulator) consume(root map[string]any) {
	if choices, ok := root["choices"].([]any); ok {
		for _, item := range choices {
			if choice, ok := item.(map[string]any); ok {
				a.consumeChoice(choice)
			}
		}
	}
	a.consumeResponsesEvent(root)
	if output, ok := root["output"].([]any); ok {
		a.consumeResponsesOutput(output)
	}
	if a.text.Len() == 0 {
		if text, ok := root["output_text"].(string); ok {
			a.text.WriteString(text)
		}
	}
	if content, ok := root["content"].([]any); ok {
		a.consumeContentBlocks(content)
	}
	if data, ok := root["data"].([]any); ok {
		a.consumeData(data)
	}
}

func (a *requestOutputAccumulator) consumeChoice(choice map[string]any) {
	a.text.WriteString(contentString(choice["text"]))
	for _, key := range []string{"message", "delta"} {
		message, ok := choice[key].(map[string]any)
		if !ok {
			continue
		}
		a.text.WriteString(contentString(message["content"]))
		if refusal, ok := message["refusal"].(string); ok {
			a.text.WriteString(refusal)
		}
		if calls, ok := message["tool_calls"].([]any); ok {
			for position, item := range calls {
				if call, ok := item.(map[string]any); ok {
					a.consumeToolCall(call, position)
				}
			}
		}
		if call, ok := message["function_call"].(map[string]any); ok {
			name, _ := call["name"].(string)
			arguments, _ := call["arguments"].(string)
			a.addToolFragment("function_call", name, arguments)
		}
	}
}

// consumeToolCall merges a whole call and a stream fragment alike. Fragments carry their
// call's index and only the first one carries the name.
func (a *requestOutputAccumulator) consumeToolCall(call map[string]any, position int) {
	key := strconv.Itoa(position)
	if index, ok := call["index"].(float64); ok {
		key = strconv.Itoa(int(index))
	}
	function, _ := call["function"].(map[string]any)
	name, _ := function["name"].(string)
	arguments, _ := function["arguments"].(string)
	a.addToolFragment(key, name, arguments)
}

func (a *requestOutputAccumulator) addToolFragment(key, name, arguments string) {
	position, seen := a.toolByIndex[key]
	if !seen {
		if name == "" && arguments == "" {
			return
		}
		a.tools = append(a.tools, requestIOToolCall{})
		position = len(a.tools) - 1
		a.toolByIndex[key] = position
	}
	if name != "" && a.tools[position].Name == "" {
		a.tools[position].Name = name
	}
	a.tools[position].Arguments += arguments
}

// consumeResponsesEvent handles the /v1/responses stream. A completed event repeats the
// whole answer, so it only fills in what the deltas did not already provide.
func (a *requestOutputAccumulator) consumeResponsesEvent(root map[string]any) {
	eventType, _ := root["type"].(string)
	switch eventType {
	case "response.output_text.delta", "response.refusal.delta":
		if delta, ok := root["delta"].(string); ok {
			a.text.WriteString(delta)
		}
	case "response.output_item.done":
		if item, ok := root["item"].(map[string]any); ok && item["type"] != "message" {
			a.consumeResponsesItem(item)
		}
	case "response.completed", "response.incomplete":
		response, _ := root["response"].(map[string]any)
		if output, ok := response["output"].([]any); ok && a.text.Len() == 0 && len(a.tools) == 0 {
			a.consumeResponsesOutput(output)
		}
	case "content_block_start":
		if block, ok := root["content_block"].(map[string]any); ok && block["type"] == "tool_use" {
			name, _ := block["name"].(string)
			a.addToolFragment(blockIndexKey(root), name, "")
		}
	case "content_block_delta":
		delta, _ := root["delta"].(map[string]any)
		if text, ok := delta["text"].(string); ok {
			a.text.WriteString(text)
		}
		if fragment, ok := delta["partial_json"].(string); ok {
			a.addToolFragment(blockIndexKey(root), "", fragment)
		}
	}
}

func blockIndexKey(root map[string]any) string {
	index, _ := root["index"].(float64)
	return "block-" + strconv.Itoa(int(index))
}

func (a *requestOutputAccumulator) consumeResponsesOutput(output []any) {
	for _, entry := range output {
		if item, ok := entry.(map[string]any); ok {
			a.consumeResponsesItem(item)
		}
	}
}

func (a *requestOutputAccumulator) consumeResponsesItem(item map[string]any) {
	itemType, _ := item["type"].(string)
	switch itemType {
	case "message":
		if content, ok := item["content"].([]any); ok {
			a.consumeContentBlocks(content)
		}
	case "reasoning":
		// Reasoning summaries are not the answer the caller received.
	default:
		name, _ := item["name"].(string)
		if name == "" {
			return
		}
		arguments, _ := item["arguments"].(string)
		key, _ := item["id"].(string)
		if key == "" {
			key = "item-" + strconv.Itoa(len(a.tools))
		}
		if _, seen := a.toolByIndex[key]; seen {
			return
		}
		a.addToolFragment(key, name, arguments)
	}
}

// consumeContentBlocks reads Responses content parts and Anthropic-style blocks.
func (a *requestOutputAccumulator) consumeContentBlocks(content []any) {
	for position, entry := range content {
		block, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if block["type"] == "tool_use" {
			name, _ := block["name"].(string)
			arguments := ""
			if input, exists := block["input"]; exists {
				arguments = jsonString(input)
			}
			a.addToolFragment("content-"+strconv.Itoa(position), name, arguments)
			continue
		}
		a.text.WriteString(contentPartText(block))
		if refusal, ok := block["refusal"].(string); ok {
			a.text.WriteString(refusal)
		}
	}
}

func (a *requestOutputAccumulator) consumeData(data []any) {
	for _, entry := range data {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if vector, ok := item["embedding"].([]any); ok {
			a.embeddings++
			a.dimensions = len(vector)
			continue
		}
		if _, ok := item["b64_json"]; ok {
			a.images++
			continue
		}
		if _, ok := item["url"]; ok {
			a.images++
		}
	}
}
