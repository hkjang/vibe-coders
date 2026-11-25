package dlp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
)

// DLP inspects the text a model reads and writes, not the JSON around it. Scanning a
// raw body would see "\n" escapes inside a card number and match ids and field names;
// instead the string values of the document are read one by one, and masking writes
// the document back with only those values changed.

// structuralKeys hold identifiers and enumerations rather than content. They are
// skipped only in the envelope of a request or answer: inside the arguments of a
// tool call (freeKeys) every string is something the model reads or wrote, whatever
// its key is called.
var structuralKeys = map[string]bool{
	"model": true, "role": true, "type": true, "object": true, "id": true,
	"tool_call_id": true, "finish_reason": true, "system_fingerprint": true,
	"encoding_format": true, "service_tier": true, "stop_reason": true, "status": true,
}

// freeKeys open a subtree whose keys are chosen by the caller or the model (tool
// inputs and arguments, request metadata), where no key is structural.
var freeKeys = map[string]bool{"input": true, "args": true, "arguments": true, "metadata": true}

// streamIdentKeys name which choice, block or output item a streamed piece belongs
// to; they make a piece's path, so pieces of one stream are joined in order and
// pieces of different choices (n > 1) are never joined with each other.
var streamIdentKeys = map[string]bool{"index": true, "output_index": true, "content_index": true, "summary_index": true}

func skipValue(key, value string, free bool) bool {
	if !free && structuralKeys[key] {
		return true
	}
	if strings.HasPrefix(value, "data:") && strings.Contains(value[:min(len(value), 128)], ";base64,") {
		return true // inline image or file: DLP does not decode base64
	}
	if len(value) > 256 && looksBase64(value) {
		return true
	}
	return false
}

func looksBase64(value string) bool {
	for i := 0; i < len(value); i++ {
		c := value[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '+' || c == '/' || c == '=' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

type frame struct {
	object  bool
	count   int
	wantKey bool
	key     string
	free    bool
	// ident collects the stream identity of this object: its index fields and, at
	// the top level, its event type.
	ident string
}

// pathStep is one level of where a string sits: the container, and the member key
// or array position at the time the string was read. The container's ident is read
// when the path is rendered, after the whole document, because an element's index
// field may come after its content ({"delta":{...},"index":0}).
type pathStep struct {
	f     *frame
	key   string
	count int
}

func snapshot(stack []*frame) []pathStep {
	steps := make([]pathStep, len(stack))
	for i, f := range stack {
		steps[i] = pathStep{f: f, key: f.key, count: f.count}
	}
	return steps
}

// renderPath names where a string sits, with array positions replaced by the
// element's own index field when it has one.
func renderPath(steps []pathStep) string {
	var b strings.Builder
	for i, step := range steps {
		if step.f.ident != "" {
			b.WriteString("#")
			b.WriteString(step.f.ident)
		}
		if step.f.object {
			b.WriteString(".")
			b.WriteString(step.key)
		} else if i+1 < len(steps) && steps[i+1].f.ident != "" {
			b.WriteString("[]")
		} else {
			b.WriteString("[")
			b.WriteString(strconv.Itoa(step.count))
			b.WriteString("]")
		}
	}
	return b.String()
}

type walkOptions struct {
	write bool
	// paths asks for each string's location (JSONPathStrings).
	paths bool
	// nullKeys are object members whose whole value is written back as null.
	nullKeys map[string]bool
}

// walkJSON visits every content string of a JSON document in order. When write is
// true it returns the document re-encoded with each value replaced by what visit
// returned. Object member order is preserved.
func walkJSON(body []byte, opts walkOptions, visit func(index int, at []pathStep, value string) string) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	write := opts.write
	var out bytes.Buffer
	stack := []*frame{}
	index := 0
	separate := func() {
		if len(stack) == 0 {
			return
		}
		top := stack[len(stack)-1]
		if top.object {
			if top.wantKey {
				if top.count > 0 {
					out.WriteByte(',')
				}
			} else {
				out.WriteByte(':')
			}
		} else if top.count > 0 {
			out.WriteByte(',')
		}
	}
	afterValue := func() {
		if len(stack) == 0 {
			return
		}
		top := stack[len(stack)-1]
		if top.object {
			top.wantKey = true
		}
		top.count++
	}
	nullNext := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		if nullNext {
			nullNext = false
			if write {
				separate()
				out.WriteString("null")
			}
			if d, ok := token.(json.Delim); ok && (d == '{' || d == '[') {
				for depth := 1; depth > 0; {
					inner, err := decoder.Token()
					if err != nil {
						return nil, err
					}
					if d, ok := inner.(json.Delim); ok {
						if d == '{' || d == '[' {
							depth++
						} else {
							depth--
						}
					}
				}
			}
			afterValue()
			continue
		}
		switch t := token.(type) {
		case json.Delim:
			switch t {
			case '{', '[':
				if write {
					separate()
					out.WriteRune(rune(t))
				}
				free := false
				if n := len(stack); n > 0 {
					parent := stack[n-1]
					free = parent.free || (parent.object && freeKeys[parent.key])
				}
				stack = append(stack, &frame{object: t == '{', wantKey: t == '{', free: free})
			case '}', ']':
				if write {
					out.WriteRune(rune(t))
				}
				stack = stack[:len(stack)-1]
				afterValue()
			}
		case string:
			isKey := len(stack) > 0 && stack[len(stack)-1].object && stack[len(stack)-1].wantKey
			if isKey {
				top := stack[len(stack)-1]
				if write {
					separate()
					writeJSONString(&out, t)
				}
				top.key = t
				top.wantKey = false
				if opts.nullKeys[t] {
					nullNext = true
				}
				continue
			}
			key, free := "", false
			if n := len(stack); n > 0 {
				top := stack[n-1]
				free = top.free
				if top.object {
					key = top.key
					free = free || freeKeys[key]
					if n == 1 && key == "type" {
						top.ident += "type=" + t + ";"
					}
					if !free && streamIdentKeys[key] && isDigits(t) {
						top.ident += key + "=" + t + ";"
					}
				}
			}
			value := t
			if !skipValue(key, t, free) {
				var at []pathStep
				if opts.paths {
					at = snapshot(stack)
				}
				value = visit(index, at, t)
				index++
			}
			if write {
				separate()
				writeJSONString(&out, value)
			}
			afterValue()
		default:
			if n := len(stack); n > 0 {
				if top := stack[n-1]; top.object && !top.free && streamIdentKeys[top.key] {
					if number, ok := t.(json.Number); ok {
						top.ident += top.key + "=" + number.String() + ";"
					}
				}
			}
			if write {
				separate()
				encoded, _ := json.Marshal(t)
				out.Write(encoded)
			}
			afterValue()
		}
	}
	return out.Bytes(), nil
}

func writeJSONString(out *bytes.Buffer, value string) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	out.Write(bytes.TrimRight(buf.Bytes(), "\n"))
}

// JSONSegments returns the content strings of a JSON document; ok is false when the
// body is not JSON.
func JSONSegments(body []byte) ([]string, bool) {
	segments := []string{}
	if _, err := walkJSON(body, walkOptions{}, func(_ int, _ []pathStep, value string) string {
		segments = append(segments, value)
		return value
	}); err != nil {
		return nil, false
	}
	return segments, true
}

// PathString is a content string and where it sits in its document.
type PathString struct {
	Path  string
	Value string
}

// JSONPathStrings is JSONSegments with each string's path. Pieces of a streamed
// answer that belong together (one choice's content, one tool call's arguments, one
// content block) share a path across events, so they can be joined as the client
// joins them.
func JSONPathStrings(body []byte) ([]PathString, bool) {
	values := []string{}
	steps := [][]pathStep{}
	if _, err := walkJSON(body, walkOptions{paths: true}, func(_ int, at []pathStep, value string) string {
		values = append(values, value)
		steps = append(steps, at)
		return value
	}); err != nil {
		return nil, false
	}
	out := make([]PathString, len(values))
	for i := range values {
		out[i] = PathString{Path: renderPath(steps[i]), Value: values[i]}
	}
	return out, true
}

func isDigits(value string) bool {
	if value == "" || len(value) > 9 {
		return false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return true
}

// RewriteJSONSegments writes a JSON document back with its content strings replaced
// by segments (in the order JSONSegments returned them).
func RewriteJSONSegments(body []byte, segments []string) ([]byte, error) {
	return walkJSON(body, walkOptions{write: true}, func(index int, _ []pathStep, value string) string {
		if index < len(segments) {
			return segments[index]
		}
		return value
	})
}

// NullJSONKeys writes a JSON document back with the values of the named members
// replaced by null, wherever they sit. Masking uses it for logprobs, whose tokens
// spell the answer out again piece by piece.
func NullJSONKeys(body []byte, keys ...string) ([]byte, error) {
	set := map[string]bool{}
	for _, key := range keys {
		set[key] = true
	}
	return walkJSON(body, walkOptions{write: true, nullKeys: set}, func(_ int, _ []pathStep, value string) string { return value })
}
