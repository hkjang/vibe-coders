package proxy

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// clampMaxOutputTokens enforces an output-token ceiling on a chat body: if the body sets
// max_tokens or max_completion_tokens above the cap it's reduced; if it sets neither, the cap
// is injected as max_tokens. Returns (newBody, from, to, changed). from is -1 when the field
// was absent (injected). Safe no-op on parse failure or cap <= 0.
func clampMaxOutputTokens(body []byte, maxOut int) ([]byte, int, int, bool) {
	if maxOut <= 0 || len(body) == 0 {
		return body, 0, 0, false
	}
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil {
		return body, 0, 0, false
	}
	field := "max_tokens"
	cur, present := numField(root, "max_tokens")
	if !present {
		if c2, ok := numField(root, "max_completion_tokens"); ok {
			field, cur, present = "max_completion_tokens", c2, true
		}
	}
	if present {
		if cur <= maxOut {
			return body, 0, 0, false // already within the cap
		}
	} else {
		cur = -1 // absent → will inject
	}
	root[field] = maxOut
	out, err := json.Marshal(root)
	if err != nil {
		return body, 0, 0, false
	}
	return out, cur, maxOut, true
}

// numField reads an integer-valued JSON field (numbers decode as float64).
func numField(root map[string]any, key string) (int, bool) {
	v, ok := root[key]
	if !ok {
		return 0, false
	}
	if f, ok := v.(float64); ok {
		return int(f), true
	}
	return 0, false
}

// stepLimits clamps the request's output-token ceiling to limits.max_output_tokens (when set).
// Runs after deprecation, before governance, so the clamped body flows downstream. Chat POST only.
func (rc *requestPipeline) stepLimits() bool {
	s, r, w := rc.s, rc.r, rc.w
	if r.Method != http.MethodPost {
		return true
	}
	lim := s.limitsConf()

	// Input guard: reject oversized request bodies before any upstream work.
	if lim.MaxRequestBytes > 0 && len(rc.body) > lim.MaxRequestBytes {
		w.Header().Set("X-Request-Bytes", strconv.Itoa(len(rc.body)))
		writeOpenAIError(w, http.StatusRequestEntityTooLarge,
			"request body exceeds the configured limit ("+strconv.Itoa(len(rc.body))+" > "+strconv.Itoa(lim.MaxRequestBytes)+" bytes)",
			"invalid_request_error", "payload_too_large")
		return false
	}

	maxOut := lim.MaxOutputTokens
	if maxOut <= 0 {
		return true
	}
	newBody, from, to, changed := clampMaxOutputTokens(rc.body, maxOut)
	if !changed {
		return true
	}
	rc.body = newBody
	if from < 0 {
		w.Header().Set("X-Max-Tokens-Clamped", "injected:"+strconv.Itoa(to))
	} else {
		w.Header().Set("X-Max-Tokens-Clamped", strconv.Itoa(from)+"->"+strconv.Itoa(to))
	}
	return true
}
