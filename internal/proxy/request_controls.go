package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/audit"
)

// Request controls are headers a caller sets on one request to tune how the gateway
// handles it. Each has an X-Vibe-* name and, so that clients written for Cloudflare
// AI Gateway work unchanged, the matching cf-aig-* name. The gateway consumes them;
// none is forwarded to a provider.
//
//	X-Vibe-Metadata        cf-aig-metadata        JSON object of tags (dynamic route conditions, rate keys, logs)
//	X-Vibe-Request-Timeout cf-aig-request-timeout ms to wait for a provider's first response bytes, per try
//	X-Vibe-Max-Attempts    cf-aig-max-attempts    tries per provider before failing over (1-5)
//	X-Vibe-Retry-Delay     cf-aig-retry-delay     ms before a retry (0-60000)
//	X-Vibe-Backoff         cf-aig-backoff         constant | linear | exponential
//	X-Vibe-Skip-Cache      cf-aig-skip-cache      true: neither read nor write the response cache
//	X-Vibe-Cache-TTL       cf-aig-cache-ttl       seconds to keep this response cached (shortens, never extends, the configured TTL)
const (
	requestMetadataMaxBytes   = 4096
	requestMetadataMaxEntries = 16
	requestMetadataMaxValue   = 256
	requestControlMaxTimeout  = 600_000
	requestControlMaxAttempts = 5
	requestControlMaxDelay    = 60_000
	requestControlMaxCacheTTL = 30 * 24 * 3600
)

var requestControlHeaderNames = map[string][2]string{
	"metadata": {"X-Vibe-Metadata", "Cf-Aig-Metadata"},
	"timeout":  {"X-Vibe-Request-Timeout", "Cf-Aig-Request-Timeout"},
	"attempts": {"X-Vibe-Max-Attempts", "Cf-Aig-Max-Attempts"},
	"delay":    {"X-Vibe-Retry-Delay", "Cf-Aig-Retry-Delay"},
	"backoff":  {"X-Vibe-Backoff", "Cf-Aig-Backoff"},
	"skip":     {"X-Vibe-Skip-Cache", "Cf-Aig-Skip-Cache"},
	"ttl":      {"X-Vibe-Cache-Ttl", "Cf-Aig-Cache-Ttl"},
}

var requestControlCanonical = func() map[string]bool {
	out := map[string]bool{}
	for _, names := range requestControlHeaderNames {
		out[http.CanonicalHeaderKey(names[0])] = true
		out[http.CanonicalHeaderKey(names[1])] = true
	}
	return out
}()

// requestControlHeader reports headers the gateway consumes and never forwards.
func requestControlHeader(canonical string) bool {
	return requestControlCanonical[canonical]
}

type requestControls struct {
	Metadata    map[string]any
	Timeout     time.Duration
	MaxAttempts int
	RetryDelay  time.Duration
	Backoff     string
	SkipCache   bool
	CacheTTL    time.Duration
	// Set lists the controls the caller actually sent, for the routing summary.
	Set []string
}

type requestControlError struct {
	header  string
	message string
}

func (e *requestControlError) Error() string { return e.header + ": " + e.message }

// controlHeader returns the value of the control and the header name it came from.
// The X-Vibe-* name wins when a client sends both.
func controlHeader(h http.Header, control string) (string, string) {
	names := requestControlHeaderNames[control]
	for _, name := range names {
		if value := strings.TrimSpace(h.Get(name)); value != "" {
			return value, name
		}
	}
	return "", ""
}

func parseControlInt(h http.Header, control string, minimum, maximum int64) (int64, bool, *requestControlError) {
	raw, name := controlHeader(h, control)
	if raw == "" {
		return 0, false, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < minimum || value > maximum {
		return 0, false, &requestControlError{header: name, message: fmt.Sprintf("must be an integer between %d and %d", minimum, maximum)}
	}
	return value, true, nil
}

// parseRequestControls reads the request control headers. A malformed value is an
// error rather than silently ignored: a caller that set a timeout or metadata for
// routing should learn it did not take effect.
func parseRequestControls(h http.Header) (requestControls, *requestControlError) {
	var controls requestControls
	if raw, name := controlHeader(h, "metadata"); raw != "" {
		metadata, err := parseRequestMetadata(raw)
		if err != nil {
			return requestControls{}, &requestControlError{header: name, message: err.Error()}
		}
		controls.Metadata = metadata
		controls.Set = append(controls.Set, "metadata")
	}
	if value, ok, err := parseControlInt(h, "timeout", 1, requestControlMaxTimeout); err != nil {
		return requestControls{}, err
	} else if ok {
		controls.Timeout = time.Duration(value) * time.Millisecond
		controls.Set = append(controls.Set, "request_timeout")
	}
	if value, ok, err := parseControlInt(h, "attempts", 1, requestControlMaxAttempts); err != nil {
		return requestControls{}, err
	} else if ok {
		controls.MaxAttempts = int(value)
		controls.Set = append(controls.Set, "max_attempts")
	}
	if value, ok, err := parseControlInt(h, "delay", 0, requestControlMaxDelay); err != nil {
		return requestControls{}, err
	} else if ok {
		controls.RetryDelay = time.Duration(value) * time.Millisecond
		controls.Set = append(controls.Set, "retry_delay")
	}
	if raw, name := controlHeader(h, "backoff"); raw != "" {
		switch strings.ToLower(raw) {
		case "constant", "linear", "exponential":
			controls.Backoff = strings.ToLower(raw)
			controls.Set = append(controls.Set, "backoff")
		default:
			return requestControls{}, &requestControlError{header: name, message: "must be constant, linear or exponential"}
		}
	}
	if raw, name := controlHeader(h, "skip"); raw != "" {
		switch strings.ToLower(raw) {
		case "true", "1":
			controls.SkipCache = true
			controls.Set = append(controls.Set, "skip_cache")
		case "false", "0":
		default:
			return requestControls{}, &requestControlError{header: name, message: "must be true or false"}
		}
	}
	if value, ok, err := parseControlInt(h, "ttl", 1, requestControlMaxCacheTTL); err != nil {
		return requestControls{}, err
	} else if ok {
		controls.CacheTTL = time.Duration(value) * time.Second
		controls.Set = append(controls.Set, "cache_ttl")
	}
	return controls, nil
}

// parseRequestMetadata accepts a flat JSON object of up to 16 entries whose values
// are strings, numbers or booleans — the shape Cloudflare's cf-aig-metadata takes,
// with a little more room.
func parseRequestMetadata(raw string) (map[string]any, error) {
	if len(raw) > requestMetadataMaxBytes {
		return nil, fmt.Errorf("must be at most %d bytes", requestMetadataMaxBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader([]byte(raw)))
	var doc any
	if err := decoder.Decode(&doc); err != nil {
		return nil, fmt.Errorf("must be a JSON object")
	}
	if decoder.More() {
		return nil, fmt.Errorf("must be a single JSON object")
	}
	obj, ok := doc.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("must be a JSON object")
	}
	if len(obj) > requestMetadataMaxEntries {
		return nil, fmt.Errorf("may have at most %d entries", requestMetadataMaxEntries)
	}
	out := make(map[string]any, len(obj))
	for key, value := range obj {
		if !dynamicRouteMetadataKey.MatchString(key) {
			return nil, fmt.Errorf("key %q must be 1-64 characters of letters, digits and _ . : -", truncateForMessage(key))
		}
		switch v := value.(type) {
		case string:
			if utf8.RuneCountInString(v) > requestMetadataMaxValue {
				return nil, fmt.Errorf("value of %q must be at most %d characters", key, requestMetadataMaxValue)
			}
			out[key] = v
		case float64:
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return nil, fmt.Errorf("value of %q must be a finite number", key)
			}
			out[key] = v
		case bool:
			out[key] = v
		default:
			return nil, fmt.Errorf("value of %q must be a string, number or boolean", key)
		}
	}
	return out, nil
}

func truncateForMessage(value string) string {
	if len(value) <= 32 {
		return value
	}
	return value[:32] + "…"
}

// maskedMetadataJSON renders metadata for storage. Values pass through the same
// redaction as prompts: callers tag requests with user ids and emails, and a log
// row is not the place to keep them in the clear.
func maskedMetadataJSON(metadata map[string]any) string {
	if len(metadata) == 0 {
		return "{}"
	}
	keys := make([]string, 0, len(metadata))
	for key := range metadata {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	masked := make(map[string]any, len(metadata))
	for _, key := range keys {
		if text, ok := metadata[key].(string); ok {
			masked[key] = audit.Redact(text)
			continue
		}
		masked[key] = metadata[key]
	}
	encoded, err := json.Marshal(masked)
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

// dialOptions turns the caller's controls into dial options.
func (c requestControls) dialOptions() upstreamDialOptions {
	return upstreamDialOptions{
		attemptTimeout: c.Timeout,
		maxAttempts:    c.MaxAttempts,
		retryDelay:     c.RetryDelay,
		backoff:        c.Backoff,
	}
}

// stepRequestControls parses the request control headers once, before anything
// that depends on them (dynamic routes read the metadata, the cache reads the skip
// flag, the dial reads the retry policy).
func (rc *requestPipeline) stepRequestControls() bool {
	if rc.r.Method != http.MethodPost {
		return true
	}
	controls, err := parseRequestControls(rc.r.Header)
	if err != nil {
		writeOpenAIError(rc.w, http.StatusBadRequest, "invalid request control header "+err.Error(), "invalid_request_error", "invalid_request_control")
		return false
	}
	rc.controls = controls
	return true
}
