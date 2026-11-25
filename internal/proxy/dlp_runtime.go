package proxy

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/dlp"
	"vibe-coders/internal/store"
)

// Data loss prevention on the request path. The request is inspected once, right
// after authentication and before anything routes or caches it, so a blocked or
// masked prompt is what every later step — routing, agent routes, the cache, the
// provider and the request log — sees. Responses are inspected after the provider
// answers and before the first byte reaches the client; a streamed response is
// buffered whole for that, which is the documented cost of response inspection.

const (
	dlpSnapshotTTL = 5 * time.Second
	// dlpResponseBufferLimit bounds how much of a provider response is held for
	// inspection; the scan itself is bounded by the configured max_scan_bytes.
	dlpResponseBufferLimit = 32 << 20
)

type dlpSnapshot struct {
	engine    *dlp.Engine
	revision  int
	fetchedAt time.Time
}

type dlpCache struct {
	snap atomic.Pointer[dlpSnapshot]
}

// dlpEngine returns the compiled configuration. A stored configuration that no
// longer compiles keeps the last good engine rather than silently turning DLP off.
func (s *Server) dlpEngine(ctx context.Context) *dlp.Engine {
	if cached := s.dlp.snap.Load(); cached != nil && time.Since(cached.fetchedAt) < dlpSnapshotTTL {
		return cached.engine
	}
	previous := s.dlp.snap.Load()
	settings, found, err := s.db.GetDLPSettings(ctx)
	if err != nil {
		slog.Warn("dlp settings unavailable; keeping the previous configuration", "error", err)
		if previous != nil {
			return previous.engine
		}
		return nil
	}
	cfg := dlp.DefaultConfig()
	revision := 0
	if found {
		revision = settings.Revision
		if err := json.Unmarshal([]byte(settings.ConfigJSON), &cfg); err != nil {
			slog.Error("stored dlp configuration is unreadable", "error", err)
			if previous != nil {
				return previous.engine
			}
		}
	}
	engine, issues := dlp.Compile(cfg)
	if len(issues) > 0 {
		slog.Error("stored dlp configuration does not compile", "issues", len(issues), "first", issues[0].Message)
		if previous != nil {
			return previous.engine
		}
		return nil
	}
	s.dlp.snap.Store(&dlpSnapshot{engine: engine, revision: revision, fetchedAt: time.Now()})
	return engine
}

func (s *Server) invalidateDLP() { s.dlp.snap.Store(nil) }

// dlpState is one request's DLP context.
type dlpState struct {
	engine          *dlp.Engine
	scope           dlp.Scope
	inspectResponse bool
	request         dlp.Decision
	response        dlp.Decision
}

func dlpInspectablePath(r *http.Request) bool {
	return r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/v1/")
}

// textSegments reads the content strings of a body: string values of JSON, or the
// whole body when it is not JSON.
func textSegments(body []byte) ([]string, bool) {
	if segments, ok := dlp.JSONSegments(body); ok {
		return segments, true
	}
	return []string{string(body)}, false
}

// stepDLP inspects the request body against the request policies.
func (rc *requestPipeline) stepDLP() bool {
	s, r, w := rc.s, rc.r, rc.w
	if !dlpInspectablePath(r) {
		return true
	}
	engine := s.dlpEngine(r.Context())
	if !engine.Enabled() {
		return true
	}
	scope := dlp.Scope{}
	if rc.authCtx != nil {
		scope = dlp.Scope{TeamID: rc.authCtx.TeamID, APIKeyID: rc.authCtx.APIKeyID}
	}
	state := &dlpState{engine: engine, scope: scope}
	// Embedding responses are vectors; there is no text to inspect.
	state.inspectResponse = r.URL.Path != "/v1/embeddings" && len(engine.Policies(dlp.CheckResponse, scope)) > 0
	rc.dlpState = state
	if len(engine.Policies(dlp.CheckRequest, scope)) == 0 {
		return true
	}
	if rc.body == nil {
		body, ok := rc.readRequestBody()
		if !ok {
			return false
		}
		rc.body = body
	}
	if enc := strings.TrimSpace(r.Header.Get("Content-Encoding")); enc != "" && !strings.EqualFold(enc, "identity") {
		// A compressed body would be read as bytes, not text, and pass unread.
		writeOpenAIError(w, http.StatusUnsupportedMediaType, "Compressed request bodies cannot be inspected by DLP; send the body uncompressed", "invalid_request_error", "dlp_encoded_body")
		return false
	}
	segments, isJSON := textSegments(rc.body)
	decision := evaluateSafely(engine, dlp.CheckRequest, scope, segments)
	state.request = decision
	if decision.Matched() {
		s.metrics.IncDLP(string(dlp.CheckRequest), string(decision.Action))
	}
	rc.setDLPHeaders()
	switch decision.Action {
	case dlp.ActionBlock:
		writeOpenAIError(w, http.StatusBadRequest, "Request content blocked due to DLP policy violations", "invalid_request_error", "dlp_request_blocked")
		return false
	case dlp.ActionMask:
		masked := engine.Mask(segments, decision.MaskMatches)
		if isJSON {
			rewritten, err := dlp.RewriteJSONSegments(rc.body, masked)
			if err != nil {
				// The body parsed a moment ago; failing to write it back must not send the
				// unmasked original.
				writeOpenAIError(w, http.StatusBadRequest, "Request content blocked due to DLP policy violations", "invalid_request_error", "dlp_request_blocked")
				return false
			}
			rc.body = rewritten
		} else {
			rc.body = []byte(strings.Join(masked, ""))
		}
	}
	return true
}

func (rc *requestPipeline) setDLPHeaders() {
	if rc.dlpState == nil {
		return
	}
	if value, ok := dlp.Header(rc.dlpState.request, rc.dlpState.response); ok {
		rc.w.Header().Set("X-Vibe-DLP", value)
		rc.w.Header().Set("Cf-Aig-Dlp", value)
	}
}

// evaluateSafely decides and fails closed: an inspection that panics blocks instead
// of letting text through unread.
func evaluateSafely(engine *dlp.Engine, check dlp.Check, scope dlp.Scope, segments []string) (decision dlp.Decision) {
	defer func() {
		if p := recover(); p != nil {
			slog.Error("dlp inspection failed; blocking", "check", check, "panic", p)
			decision = dlp.Decision{Check: check, Action: dlp.ActionBlock, Policies: []dlp.PolicyHit{{PolicyID: "inspection-error", Action: dlp.ActionBlock, Profiles: []string{}}}}
		}
	}()
	return engine.Evaluate(check, scope, segments)
}

func isEventStream(body []byte, contentType string) bool {
	trimmed := bytes.TrimSpace(body)
	return strings.Contains(strings.ToLower(contentType), "event-stream") || bytes.HasPrefix(trimmed, []byte("data:")) || bytes.HasPrefix(trimmed, []byte("event:"))
}

// sseStream is a buffered stream read for DLP: each data event's content strings,
// grouped by where they sit (one choice's content, one choice's reasoning, one tool
// call's arguments, one content block), in the order the client receives them.
type sseStream struct {
	lines  [][]byte
	events []sseEvent
	keys   []string
	pieces [][]sseRef // per key, the pieces in order
	other  []string   // data lines that are not JSON
}

type sseEvent struct {
	line    int
	payload []byte
	values  []string
}

type sseRef struct{ event, index int }

func readSSE(body []byte) *sseStream {
	st := &sseStream{lines: bytes.Split(body, []byte("\n"))}
	keyIndex := map[string]int{}
	for i, line := range st.lines {
		payload, ok := bytes.CutPrefix(bytes.TrimRight(line, "\r"), []byte("data:"))
		if !ok {
			continue
		}
		payload = bytes.TrimSpace(payload)
		if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
			continue
		}
		strs, isJSON := dlp.JSONPathStrings(payload)
		if !isJSON {
			st.other = append(st.other, string(payload))
			continue
		}
		ev := sseEvent{line: i, payload: payload}
		for j, ps := range strs {
			k, seen := keyIndex[ps.Path]
			if !seen {
				k = len(st.keys)
				keyIndex[ps.Path] = k
				st.keys = append(st.keys, ps.Path)
				st.pieces = append(st.pieces, nil)
			}
			st.pieces[k] = append(st.pieces[k], sseRef{event: len(st.events), index: j})
			ev.values = append(ev.values, ps.Value)
		}
		st.events = append(st.events, ev)
	}
	return st
}

// texts joins each key's pieces: the answer as the client assembles it, choice by
// choice, followed by any data lines that were not JSON.
func (st *sseStream) texts() []string {
	out := make([]string, 0, len(st.keys)+len(st.other))
	for _, refs := range st.pieces {
		var b strings.Builder
		for _, ref := range refs {
			b.WriteString(st.events[ref.event].values[ref.index])
		}
		out = append(out, b.String())
	}
	return append(out, st.other...)
}

// responseSegments reads the answer text of a provider response: for a stream, each
// choice's and block's pieces joined as the client joins them; otherwise the
// content strings of JSON, or the whole body.
func responseSegments(body []byte, contentType string) []string {
	if isEventStream(body, contentType) {
		return readSSE(body).texts()
	}
	segments, _ := textSegments(body)
	return segments
}

// maskSSE masks a buffered stream. Each choice's text is read whole, as the client
// will assemble it, so a value the provider split across events is found and
// replaced whole: its label goes where it starts and the rest of it is removed from
// the events it continues into. Event boundaries, ids and the terminating [DONE]
// are kept, so the client still receives a valid stream. Logprobs, which spell the
// answer out again token by token, are dropped from every event.
func (rc *requestPipeline) maskSSE(body []byte) ([]byte, error) {
	engine, scope := rc.dlpState.engine, rc.dlpState.scope
	st := readSSE(body)
	decision := evaluateSafely(engine, dlp.CheckResponse, scope, st.texts())
	byKey := map[int][]dlp.Match{}
	for _, m := range decision.MaskMatches {
		byKey[m.Segment] = append(byKey[m.Segment], m)
	}
	for k, matches := range byKey {
		if k >= len(st.pieces) {
			continue // a non-JSON data line: left as is, the recheck withholds it
		}
		refs := st.pieces[k]
		parts := make([]string, len(refs))
		for i, ref := range refs {
			parts[i] = st.events[ref.event].values[ref.index]
		}
		for i, masked := range engine.MaskJoined(parts, matches) {
			st.events[refs[i].event].values[refs[i].index] = masked
		}
	}
	for _, ev := range st.events {
		rewritten, err := dlp.RewriteJSONSegments(ev.payload, ev.values)
		if err != nil {
			return nil, err
		}
		if rewritten, err = dlp.NullJSONKeys(rewritten, "logprobs"); err != nil {
			return nil, err
		}
		st.lines[ev.line] = append([]byte("data: "), rewritten...)
	}
	return bytes.Join(st.lines, []byte("\n")), nil
}

type dlpOutcome int

const (
	dlpRelay dlpOutcome = iota
	dlpWithheld
	// dlpReadFailed: the provider's answer could not be read whole (the provider or
	// the client went away). That is a transport failure, not a DLP finding.
	dlpReadFailed
)

func uninspectable(state *dlpState, reason string) dlp.Decision {
	return dlp.Decision{Check: dlp.CheckResponse, Action: dlp.ActionBlock, Truncated: true, Policies: []dlp.PolicyHit{{PolicyID: reason, Action: dlp.ActionBlock, Profiles: []string{}}}}
}

// inspectDLPResponse buffers and inspects a successful response. It returns the
// response to relay, or dlpWithheld when the answer must not reach the client.
func (rc *requestPipeline) inspectDLPResponse(resp *http.Response) (*http.Response, dlpOutcome) {
	state := rc.dlpState
	// Error answers are read too: a provider's error message can quote the prompt.
	if state == nil || !state.inspectResponse || resp.StatusCode < 200 || resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotModified {
		return resp, dlpRelay
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, dlpResponseBufferLimit+1))
	if err != nil {
		_ = resp.Body.Close()
		return resp, dlpReadFailed
	}
	blockUnread := state.engine.Config().Oversize == "block"
	if len(raw) > dlpResponseBufferLimit {
		if blockUnread {
			_ = resp.Body.Close()
			state.response = uninspectable(state, "scan-limit")
			return resp, dlpWithheld
		}
		// Too large to hold: relay unchanged and say so on the response.
		rc.w.Header().Set("X-Vibe-DLP-Response", "skipped_oversize")
		resp.Body = struct {
			io.Reader
			io.Closer
		}{io.MultiReader(bytes.NewReader(raw), resp.Body), resp.Body}
		return resp, dlpRelay
	}
	_ = resp.Body.Close()
	decoded := raw
	switch enc := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Encoding"))); enc {
	case "", "identity":
	case "gzip":
		reader, err := gzip.NewReader(bytes.NewReader(raw))
		if err == nil {
			decoded, err = io.ReadAll(io.LimitReader(reader, dlpResponseBufferLimit))
		}
		if err != nil {
			decoded = nil
		}
	default:
		decoded = nil
	}
	if decoded == nil {
		// An encoding DLP cannot read (br, zstd, or broken gzip) is treated like text
		// beyond the scan limit.
		if blockUnread {
			state.response = uninspectable(state, "uninspectable")
			return resp, dlpWithheld
		}
		rc.w.Header().Set("X-Vibe-DLP-Response", "skipped_encoding")
		resp.Body = io.NopCloser(bytes.NewReader(raw))
		return resp, dlpRelay
	}
	contentType := resp.Header.Get("Content-Type")
	decision := evaluateSafely(state.engine, dlp.CheckResponse, state.scope, responseSegments(decoded, contentType))
	state.response = decision
	relay := raw
	withhold := func(policy string) (*http.Response, dlpOutcome) {
		state.response.Action = dlp.ActionBlock
		state.response.Policies = append(state.response.Policies, dlp.PolicyHit{PolicyID: policy, Action: dlp.ActionBlock, Profiles: []string{}})
		return resp, dlpWithheld
	}
	switch decision.Action {
	case dlp.ActionBlock:
		return resp, dlpWithheld
	case dlp.ActionMask:
		var masked []byte
		var err error
		if isEventStream(decoded, contentType) {
			masked, err = rc.maskSSE(decoded)
		} else if segments, isJSON := dlp.JSONSegments(decoded); isJSON {
			masked, err = dlp.RewriteJSONSegments(decoded, state.engine.Mask(segments, decision.MaskMatches))
			if err == nil {
				// Logprobs repeat the answer token by token; the masked answer must not.
				masked, err = dlp.NullJSONKeys(masked, "logprobs")
			}
		} else {
			masked = []byte(state.engine.Mask([]string{string(decoded)}, decision.MaskMatches)[0])
		}
		if err != nil {
			return withhold("mask-failed")
		}
		// Defense in depth: if anything a mask policy covers is still readable in the
		// answer as the client will read it, withhold the answer instead.
		recheck := evaluateSafely(state.engine, dlp.CheckResponse, state.scope, responseSegments(masked, contentType))
		if recheck.Action == dlp.ActionBlock || len(recheck.MaskMatches) > 0 {
			return withhold("mask-incomplete")
		}
		relay = masked
		resp.Header.Del("Content-Encoding")
		resp.Header.Del("Content-Length")
	}
	resp.Body = io.NopCloser(bytes.NewReader(relay))
	return resp, dlpRelay
}

type dlpCacheGateKey struct{}

// dlpCacheGate decides whether a cached answer may be served under the current
// response policies. Cloudflare serves cache hits without re-inspection, so a policy
// tightened after a response was cached does not apply until the entry expires;
// here the cached answer is inspected like a fresh one, and anything a policy would
// mask or block goes to the provider instead, where the normal path applies.
type dlpCacheGate func(body []byte, contentType string) (bool, func(*store.LogRecord))

func withDLPCacheGate(ctx context.Context, gate dlpCacheGate) context.Context {
	return context.WithValue(ctx, dlpCacheGateKey{}, gate)
}

func dlpCacheGateFrom(ctx context.Context) dlpCacheGate {
	gate, _ := ctx.Value(dlpCacheGateKey{}).(dlpCacheGate)
	return gate
}

func (rc *requestPipeline) dlpCacheContext(ctx context.Context) context.Context {
	state := rc.dlpState
	if state == nil || !state.inspectResponse {
		return ctx
	}
	return withDLPCacheGate(ctx, func(body []byte, contentType string) (bool, func(*store.LogRecord)) {
		decision := evaluateSafely(state.engine, dlp.CheckResponse, state.scope, responseSegments(body, contentType))
		if decision.Action == dlp.ActionBlock || decision.Action == dlp.ActionMask {
			return false, nil
		}
		state.response = decision
		rc.setDLPHeaders()
		return true, rc.attachDLP
	})
}

// dlpEvents turns a decision into one event per matched profile.
func (rc *requestPipeline) dlpEvents(decision dlp.Decision, meta *store.LogRecord) []store.DLPEvent {
	if !decision.Matched() {
		return nil
	}
	state := rc.dlpState
	evidence := state.engine.Config().Evidence
	events := []store.DLPEvent{}
	for _, hit := range decision.Hits {
		action := dlp.Action("")
		policies := []string{}
		for _, p := range decision.Policies {
			for _, id := range p.Profiles {
				if id == hit.ProfileID {
					policies = append(policies, p.PolicyID)
					action = dlp.Stronger(action, p.Action)
				}
			}
		}
		event := store.DLPEvent{
			ID: newID("dlp"), RequestID: meta.Request.ID, Check: string(decision.Check), Action: string(action),
			PolicyIDs: policies, ProfileID: hit.ProfileID, EntryIDs: hit.EntryIDs(), MatchCount: len(hit.Matches),
			Confidence: hit.MaxConfidence().String(), Evidence: []string{}, Hashes: []string{},
			Endpoint: meta.Request.Endpoint, Model: meta.Request.Model, CreatedAt: time.Now().UTC(),
		}
		for i, m := range hit.Matches {
			if i < 5 && evidence == "partial" {
				event.Evidence = append(event.Evidence, state.engine.EntryName(m.EntryID)+": "+m.Preview())
			}
			if key := rc.s.dlpFingerprintKey(); i < 10 && key != nil {
				event.Hashes = append(event.Hashes, m.Fingerprint(key))
			}
		}
		if rc.authCtx != nil {
			event.APIKeyID, event.UserID, event.TeamID = rc.authCtx.APIKeyID, rc.authCtx.UserID, rc.authCtx.TeamID
		}
		if event.APIKeyID == "" {
			event.APIKeyID = rc.apiKeyID
		}
		events = append(events, event)
	}
	// A block without profile hits (scan limit, unreadable encoding, inspection
	// error) still deserves a record, under the reason as its profile.
	if len(events) == 0 && decision.Action == dlp.ActionBlock {
		policies := []string{}
		for _, p := range decision.Policies {
			policies = append(policies, p.PolicyID)
		}
		reason := "scan-limit"
		if len(policies) > 0 {
			reason = policies[0]
		}
		events = append(events, store.DLPEvent{ID: newID("dlp"), RequestID: meta.Request.ID, Check: string(decision.Check), Action: string(dlp.ActionBlock),
			PolicyIDs: policies, ProfileID: reason, EntryIDs: []string{}, Evidence: []string{}, Hashes: []string{},
			Endpoint: meta.Request.Endpoint, Model: meta.Request.Model, CreatedAt: time.Now().UTC()})
	}
	return events
}

// attachDLP adds the request's DLP events and summary to its log record, once.
func (rc *requestPipeline) attachDLP(meta *store.LogRecord) {
	state := rc.dlpState
	if state == nil || len(meta.DLPEvents) > 0 {
		return
	}
	meta.DLPEvents = append(rc.dlpEvents(state.request, meta), rc.dlpEvents(state.response, meta)...)
	if len(meta.DLPEvents) == 0 {
		return
	}
	redactDLPLog(state, meta)
	summary := mapFromJSON(meta.Request.PolicySummaryJSON)
	if summary == nil {
		summary = map[string]any{}
	}
	section := map[string]any{}
	if state.request.Matched() {
		section["request"] = string(state.request.Action)
	}
	if state.response.Matched() {
		section["response"] = string(state.response.Action)
	}
	profiles := []string{}
	for _, e := range meta.DLPEvents {
		profiles = append(profiles, e.ProfileID)
	}
	section["profiles"] = profiles
	summary["dlp"] = section
	meta.Request.PolicySummaryJSON = mustJSON(summary)
	// The generic reasons the deferred logger fills in are replaced by the real one.
	generic := meta.Request.Error == "" || meta.Request.Error == "early_blocked" || meta.Request.Error == "pipeline_blocked"
	if state.request.Action == dlp.ActionBlock && generic {
		meta.Request.Error = "dlp_request_blocked"
	} else if state.response.Action == dlp.ActionBlock && generic {
		meta.Request.Error = "dlp_response_blocked"
	}
}

func hitProfiles(d dlp.Decision) []string {
	out := []string{}
	for _, hit := range d.Hits {
		out = append(out, hit.ProfileID)
	}
	return out
}

// redactDLPLog masks, in everything the request log stores, what the profiles that
// triggered recognise — whatever the action and on whichever side they triggered.
// FLAG lets a value through to the provider; it does not mean keeping it in the
// gateway's own records, and a value found in the prompt is just as sensitive when
// the model repeats it. That covers the redacted and (when LOG_RAW_PROMPTS is on) raw
// prompts, the body summary the console shows, the raw body kept for replay
// (LOG_RAW_BODIES; a replay then sends the masked body, which DLP would have acted
// on anyway) and the response text (LOG_RESPONSE_TEXT). If redaction itself fails,
// the text fields are dropped rather than stored as they are.
func redactDLPLog(state *dlpState, meta *store.LogRecord) {
	profiles := append(hitProfiles(state.request), hitProfiles(state.response)...)
	if len(profiles) == 0 {
		return
	}
	defer func() {
		if p := recover(); p != nil {
			slog.Error("dlp log redaction failed; dropping logged text", "panic", p)
			for i := range meta.Prompts {
				meta.Prompts[i].RedactedText, meta.Prompts[i].ContentText = "[REDACTED_DLP]", ""
			}
			meta.Request.BodyRaw, meta.Request.BodySummaryJSON = "", "{}"
			if meta.Response != nil {
				meta.Response.ResponseTextOptional = ""
			}
		}
	}()
	engine := state.engine
	for i := range meta.Prompts {
		meta.Prompts[i].RedactedText = engine.Redact(meta.Prompts[i].RedactedText, profiles)
		meta.Prompts[i].ContentText = engine.Redact(meta.Prompts[i].ContentText, profiles)
	}
	if meta.Request.BodyRaw != "" {
		meta.Request.BodyRaw = engine.RedactJSON(meta.Request.BodyRaw, profiles)
	}
	if meta.Request.BodySummaryJSON != "" {
		meta.Request.BodySummaryJSON = engine.RedactJSON(meta.Request.BodySummaryJSON, profiles)
	}
	if meta.Response != nil && meta.Response.ResponseTextOptional != "" {
		meta.Response.ResponseTextOptional = engine.Redact(meta.Response.ResponseTextOptional, profiles)
	}
}

// dlpFingerprintKey keys evidence fingerprints to this deployment's gateway secret,
// so a stored fingerprint cannot be matched against guesses without it. With the
// public development default (or no secret) the key would be known, so no
// fingerprints are kept at all.
func (s *Server) dlpFingerprintKey() []byte {
	secret := s.cfg.Secret.GatewaySecret
	if secret == "" || secret == config.DefaultGatewaySecret {
		return nil
	}
	sum := sha256.Sum256([]byte("vibe-coders/dlp-evidence\x00" + secret))
	return sum[:]
}

type dlpLogHookKey struct{}

// enqueueFor logs a record written by a handler that answers by itself. Under DLP
// the record goes to the request's serveUnderDLP first, which adds the DLP events,
// masks what they found and, if the answer was withheld, says so.
func (s *Server) enqueueFor(r *http.Request, record store.LogRecord) {
	if hold, ok := r.Context().Value(dlpLogHookKey{}).(func(store.LogRecord)); ok && hold != nil {
		hold(record)
		return
	}
	s.enqueue(record)
}

// dlpBuffer holds a handler's whole answer so it can be inspected before any of it
// is sent.
type dlpBuffer struct {
	header   http.Header
	status   int
	body     bytes.Buffer
	overflow bool
}

func (b *dlpBuffer) Header() http.Header { return b.header }

func (b *dlpBuffer) WriteHeader(code int) {
	if b.status == 0 {
		b.status = code
	}
}

func (b *dlpBuffer) Write(p []byte) (int, error) {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	if b.body.Len()+len(p) > dlpResponseBufferLimit {
		b.overflow = true
		return 0, errors.New("answer exceeds the DLP inspection buffer")
	}
	return b.body.Write(p)
}

func (b *dlpBuffer) Flush() {}

// serveUnderDLP runs a handler that answers by itself instead of relaying a provider
// — Text2SQL (whose answer can hold rows from a database), MCP discovery and agent
// routes (whose answers can hold tool output) — under the request's DLP context: the
// answer is inspected like a provider's when response policies apply, and the
// handler's log record gets the DLP events and redaction every other path gets.
func (rc *requestPipeline) serveUnderDLP(serve func(w http.ResponseWriter, r *http.Request)) {
	state := rc.dlpState
	if state == nil {
		serve(rc.w, rc.r)
		return
	}
	var mu sync.Mutex
	held := []store.LogRecord{}
	ctx := context.WithValue(rc.r.Context(), dlpLogHookKey{}, func(record store.LogRecord) {
		mu.Lock()
		held = append(held, record)
		mu.Unlock()
	})
	ctx = context.WithValue(ctx, dlpOutboundKey{}, func(body []byte) ([]byte, error) {
		mu.Lock()
		defer mu.Unlock()
		return rc.dlpOutbound(body)
	})
	r := rc.r.WithContext(ctx)
	finish := func(blocked bool) {
		mu.Lock()
		records := held
		held = nil
		mu.Unlock()
		for _, record := range records {
			if blocked {
				record.Request.StatusCode = http.StatusBadRequest
				record.Request.Error = "dlp_response_blocked"
			}
			rc.attachDLP(&record)
			rc.s.enqueue(record)
		}
	}
	if !state.inspectResponse {
		serve(rc.w, r)
		finish(false)
		return
	}
	buf := &dlpBuffer{header: http.Header{}}
	serve(buf, r)
	if buf.status == 0 {
		buf.status = http.StatusOK
	}
	if buf.overflow {
		// More than DLP can hold: nothing of it is sent unread.
		finish(true)
		writeOpenAIError(rc.w, http.StatusBadGateway, "the answer is too large to inspect", "server_error", "dlp_response_too_large")
		return
	}
	resp := &http.Response{StatusCode: buf.status, Header: buf.header, Body: io.NopCloser(bytes.NewReader(buf.body.Bytes()))}
	resp, outcome := rc.inspectDLPResponse(resp)
	if state.response.Matched() {
		rc.s.metrics.IncDLP(string(dlp.CheckResponse), string(state.response.Action))
	}
	for key, values := range resp.Header {
		if !strings.EqualFold(key, "Content-Length") {
			rc.w.Header()[key] = values
		}
	}
	rc.setDLPHeaders()
	if outcome != dlpRelay {
		finish(true)
		writeOpenAIError(rc.w, http.StatusBadRequest, "Response content blocked due to DLP policy violations", "invalid_request_error", "dlp_response_blocked")
		return
	}
	finish(false)
	rc.w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(rc.w, resp.Body)
}

type dlpOutboundKey struct{}

// inspectOutbound applies the request policies to a request the gateway sends to a
// provider by itself during an agent route or MCP discovery run, when the run is
// under DLP. Those follow-up turns carry tool results — rows, files, tickets — that
// the caller never sent and the request check never saw.
func inspectOutbound(r *http.Request, body []byte) ([]byte, error) {
	if inspect, ok := r.Context().Value(dlpOutboundKey{}).(func([]byte) ([]byte, error)); ok && inspect != nil {
		return inspect(body)
	}
	return body, nil
}

var errDLPOutboundBlocked = errors.New("blocked by a DLP request policy")

func (rc *requestPipeline) dlpOutbound(body []byte) ([]byte, error) {
	state := rc.dlpState
	if state == nil || len(state.engine.Policies(dlp.CheckRequest, state.scope)) == 0 {
		return body, nil
	}
	segments, isJSON := textSegments(body)
	decision := evaluateSafely(state.engine, dlp.CheckRequest, state.scope, segments)
	if !decision.Matched() {
		return body, nil
	}
	rc.s.metrics.IncDLP(string(dlp.CheckRequest), string(decision.Action))
	mergeDecision(&state.request, decision)
	switch decision.Action {
	case dlp.ActionBlock:
		return nil, errDLPOutboundBlocked
	case dlp.ActionMask:
		masked := state.engine.Mask(segments, decision.MaskMatches)
		if !isJSON {
			return []byte(strings.Join(masked, "")), nil
		}
		rewritten, err := dlp.RewriteJSONSegments(body, masked)
		if err != nil {
			return nil, errDLPOutboundBlocked
		}
		return rewritten, nil
	}
	return body, nil
}

// mergeDecision adds a later decision on the same side to an earlier one, so the
// request's events and headers cover everything the run sent.
func mergeDecision(dst *dlp.Decision, src dlp.Decision) {
	dst.Check = src.Check
	dst.Action = dlp.Stronger(dst.Action, src.Action)
	dst.Hits = append(dst.Hits, src.Hits...)
	seen := map[string]bool{}
	for _, p := range dst.Policies {
		seen[p.PolicyID] = true
	}
	for _, p := range src.Policies {
		if !seen[p.PolicyID] {
			dst.Policies = append(dst.Policies, p)
			seen[p.PolicyID] = true
		}
	}
	dst.Truncated = dst.Truncated || src.Truncated
}
