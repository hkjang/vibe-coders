package proxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"regexp"
	"strconv"
	"strings"
)

// Stop-sequence compatibility. Providers differ in how many stop sequences a
// request may carry: OpenAI and several OpenAI-compatible servers accept at most 4
// and answer 400 to more, while code-completion clients routinely send ten or more
// (every FIM template token plus blank-line stops). The request is otherwise fine,
// so the gateway makes it work instead of relaying the refusal: the provider gets as
// many stop sequences as it accepts, and the gateway applies the rest itself by
// ending the answer where one of them would have stopped it. The limit is read from
// the provider's own 400 and remembered per provider and model, so only the first
// such request pays for a refused round trip.

var stopLimitPatterns = []*regexp.Regexp{
	regexp.MustCompile(`max_length['"]?\s*[:=]\s*(\d+)`),
	regexp.MustCompile(`at most (\d+)`),
	regexp.MustCompile(`maximum (?:length|of|number of|size)?\s*(?:of\s*)?(\d+)`),
	regexp.MustCompile(`up to (\d+)`),
	regexp.MustCompile(`no more than (\d+)`),
	regexp.MustCompile(`max(?:imum)?[ _]?(?:stop[ _]?sequences?|items)\D{0,20}(\d+)`),
}

// requestStops reads the stop sequences of a request body: "stop" as a string or a
// list of strings. ok is false when the body has none or is not a JSON object.
func requestStops(body []byte) ([]string, bool) {
	var root map[string]json.RawMessage
	if json.Unmarshal(body, &root) != nil {
		return nil, false
	}
	raw, present := root["stop"]
	if !present {
		return nil, false
	}
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return []string{one}, true
	}
	var many []string
	if json.Unmarshal(raw, &many) != nil {
		return nil, false
	}
	return many, true
}

// stopLimitFromError reads, from a provider's 400, how many stop sequences it
// accepts, when that is what it refused: the body names "stop" and a number
// smaller than what was sent. A provider that only takes a single string yields 1.
func stopLimitFromError(errBody, sentBody []byte) (int, bool) {
	stops, ok := requestStops(sentBody)
	if !ok || len(stops) < 2 {
		return 0, false
	}
	lower := strings.ToLower(string(errBody))
	if !strings.Contains(lower, "stop") {
		return 0, false
	}
	for _, pattern := range stopLimitPatterns {
		for _, m := range pattern.FindAllStringSubmatch(lower, -1) {
			if n, err := strconv.Atoi(m[1]); err == nil && n >= 1 && n < len(stops) {
				return n, true
			}
		}
	}
	if strings.Contains(lower, "valid string") || strings.Contains(lower, "must be a string") || strings.Contains(lower, "should be a string") {
		return 1, true
	}
	return 0, false
}

// limitStops rewrites a request so it carries at most limit stop sequences and
// returns the ones taken out, for the gateway to apply. Every other member of the
// body keeps its exact bytes. A limit of 1 sends the single stop as a string, the
// form every provider accepts.
func limitStops(body []byte, limit int) ([]byte, []string) {
	stops, ok := requestStops(body)
	if !ok || limit < 1 || len(stops) <= limit {
		return body, nil
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(body, &root) != nil {
		return body, nil
	}
	// Encoded without HTML escaping, so "<fim_prefix>" in a prompt is not turned into
	// \u003c escapes on its way to the provider.
	encode := func(value any) ([]byte, error) {
		var buf bytes.Buffer
		encoder := json.NewEncoder(&buf)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(value); err != nil {
			return nil, err
		}
		return bytes.TrimRight(buf.Bytes(), "\n"), nil
	}
	var kept []byte
	var err error
	if limit == 1 {
		kept, err = encode(stops[0])
	} else {
		kept, err = encode(stops[:limit])
	}
	if err != nil {
		return body, nil
	}
	root["stop"] = kept
	out, err := encode(root)
	if err != nil {
		return body, nil
	}
	dropped := []string{}
	for _, stop := range stops[limit:] {
		if stop != "" {
			dropped = append(dropped, stop)
		}
	}
	return out, dropped
}

func stopLimitKey(provider, model string) string { return provider + "\x00" + model }

// learnStopLimit remembers how many stop sequences a provider's model accepts.
func (s *Server) learnStopLimit(provider, model string, limit int) {
	s.stopLimits.Store(stopLimitKey(provider, model), limit)
}

// applyStopLimit fits a request to what is already known about the provider.
func (s *Server) applyStopLimit(provider, model string, body []byte) ([]byte, []string) {
	limit, ok := s.stopLimits.Load(stopLimitKey(provider, model))
	if !ok {
		return body, nil
	}
	return limitStops(body, limit.(int))
}

// stopCutter applies stop sequences to text that arrives in pieces. A piece that
// ends with the beginning of a stop sequence is held back until the next piece
// shows whether the sequence completes.
type stopCutter struct {
	stops []string
	held  string
	done  bool
}

func earliestStop(text string, stops []string) int {
	at := -1
	for _, stop := range stops {
		if i := strings.Index(text, stop); i >= 0 && (at < 0 || i < at) {
			at = i
		}
	}
	return at
}

// feed returns the text that may be passed on and whether a stop sequence ended it.
func (c *stopCutter) feed(piece string) (string, bool) {
	if c.done {
		return "", true
	}
	text := c.held + piece
	if at := earliestStop(text, c.stops); at >= 0 {
		c.held, c.done = "", true
		return text[:at], true
	}
	hold := 0
	for _, stop := range c.stops {
		for k := min(len(stop)-1, len(text)); k > hold; k-- {
			if strings.HasSuffix(text, stop[:k]) {
				hold = k
				break
			}
		}
	}
	c.held = text[len(text)-hold:]
	return text[:len(text)-hold], false
}

// flush releases held text at the end of an answer no stop sequence ended.
func (c *stopCutter) flush() string {
	held := c.held
	c.held = ""
	return held
}

// choiceText finds the answer text of one choice: a chat delta or message, or the
// text of a legacy completion. set writes it back.
func choiceText(choice map[string]any) (text string, set func(string), ok bool) {
	for _, holder := range []string{"delta", "message"} {
		if inner, isMap := choice[holder].(map[string]any); isMap {
			if content, isString := inner["content"].(string); isString {
				return content, func(v string) { inner["content"] = v }, true
			}
		}
	}
	if content, isString := choice["text"].(string); isString {
		return content, func(v string) { choice["text"] = v }, true
	}
	return "", nil, false
}

// enforceStopsJSON applies stop sequences to a complete (non-streamed) answer. It
// returns the body unchanged when none of them occurs.
func enforceStopsJSON(body []byte, stops []string) []byte {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var root map[string]any
	if decoder.Decode(&root) != nil {
		return body
	}
	choices, _ := root["choices"].([]any)
	changed := false
	for _, item := range choices {
		choice, _ := item.(map[string]any)
		text, set, ok := choiceText(choice)
		if !ok {
			continue
		}
		if at := earliestStop(text, stops); at >= 0 {
			set(text[:at])
			choice["finish_reason"] = "stop"
			changed = true
		}
	}
	if !changed {
		return body
	}
	out, err := json.Marshal(root)
	if err != nil {
		return body
	}
	return out
}

// stopStream applies stop sequences to a streamed answer. Events pass through
// byte for byte until text has to be held back or cut; when every choice seen has
// been stopped, the stream is ended properly (finish_reason "stop", then [DONE]) and
// the provider's stream is closed, so it stops generating what would be discarded.
type stopStream struct {
	src     *bufio.Reader
	closer  io.Closer
	stops   []string
	cutters map[string]*stopCutter
	out     bytes.Buffer
	ended   bool
}

func newStopStream(src io.Reader, closer io.Closer, stops []string) *stopStream {
	return &stopStream{src: bufio.NewReaderSize(src, 64<<10), closer: closer, stops: stops, cutters: map[string]*stopCutter{}}
}

func (s *stopStream) Read(p []byte) (int, error) {
	for s.out.Len() == 0 && !s.ended {
		s.pump()
	}
	if s.out.Len() > 0 {
		return s.out.Read(p)
	}
	return 0, io.EOF
}

func (s *stopStream) cutter(index string) *stopCutter {
	c := s.cutters[index]
	if c == nil {
		c = &stopCutter{stops: s.stops}
		s.cutters[index] = c
	}
	return c
}

func (s *stopStream) allStopped() bool {
	for _, c := range s.cutters {
		if !c.done {
			return false
		}
	}
	return len(s.cutters) > 0
}

// pump reads one line of the provider's stream and writes what the client gets.
func (s *stopStream) pump() {
	line, err := s.src.ReadString('\n')
	if line != "" {
		s.line(line)
	}
	if err != nil {
		s.ended = true
	}
}

func (s *stopStream) line(line string) {
	payload, isData := strings.CutPrefix(strings.TrimRight(line, "\r\n"), "data:")
	payload = strings.TrimSpace(payload)
	if !isData || payload == "" || payload == "[DONE]" {
		s.out.WriteString(line)
		return
	}
	decoder := json.NewDecoder(strings.NewReader(payload))
	decoder.UseNumber()
	var event map[string]any
	if decoder.Decode(&event) != nil {
		s.out.WriteString(line)
		return
	}
	choices, _ := event["choices"].([]any)
	changed := false
	kept := make([]any, 0, len(choices))
	for _, item := range choices {
		choice, _ := item.(map[string]any)
		index := "0"
		if n, isNumber := choice["index"].(json.Number); isNumber {
			index = n.String()
		}
		c := s.cutter(index)
		if c.done {
			changed = true // a stopped choice sends nothing more
			continue
		}
		text, set, hasText := choiceText(choice)
		finishing := choice["finish_reason"] != nil
		if !hasText && !finishing {
			kept = append(kept, item)
			continue
		}
		emit, stopped := c.feed(text)
		if !stopped && finishing {
			emit += c.flush()
		}
		if stopped {
			choice["finish_reason"] = "stop"
		}
		if emit != text || stopped {
			changed = true
			if hasText {
				set(emit)
			} else if emit != "" {
				// A finish event without text still has to deliver what was held.
				delta, _ := choice["delta"].(map[string]any)
				if delta == nil {
					delta = map[string]any{}
					choice["delta"] = delta
				}
				delta["content"] = emit
			}
		}
		kept = append(kept, item)
	}
	if !changed {
		s.out.WriteString(line)
	} else if len(kept) > 0 || len(choices) == 0 {
		event["choices"] = kept
		if encoded, err := json.Marshal(event); err == nil {
			s.out.WriteString("data: ")
			s.out.Write(encoded)
			s.out.WriteString("\n")
		} else {
			s.out.WriteString(line)
		}
	}
	if s.allStopped() {
		s.out.WriteString("\ndata: [DONE]\n\n")
		s.ended = true
		if s.closer != nil {
			_ = s.closer.Close()
		}
	}
}
