package store

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"vibe-coders/internal/workintel"
)

// WorkIntelRequest is everything the classification worker needs to know
// about one logged request, gathered without the request content: the only
// text is the latest user prompt as it was stored redacted, cut to the
// policy's input limit by the database.
type WorkIntelRequest struct {
	RequestID  string
	CreatedAt  string
	IngestedAt string
	SessionID  string
	APIKeyID   string
	// Team is the API key's team ("unassigned" without one); UserKey is the
	// key's user, or the key itself when it belongs to no user.
	Team     string
	UserKey  string
	Model    string
	Provider string
	Endpoint string
	// Client is the friendly client label derived from the User-Agent.
	Client      string
	StatusCode  int
	LatencyMS   int64
	Complexity  int
	TaskType    string
	Fingerprint string
	TokensIn    int64
	TokensOut   int64
	CostKRW     float64
	// Languages are the confidently detected programming languages, most
	// confident first.
	Languages []string
	// MCPServers and MCPTools are the servers and tools the conversation
	// called or returned results from. Declared but unused tools are left out:
	// a coding client declares dozens on every request.
	MCPServers []string
	MCPTools   []string
	// MCPCalls counts the MCP tool calls; ToolSig is the sorted set of called
	// tools, comparable between requests.
	MCPCalls int64
	ToolSig  string
	// Text is the latest user prompt, redacted and truncated.
	Text string
	// PolicyFlags lists "dlp" and "secret" when those policies acted.
	PolicyFlags      []string
	PositiveFeedback bool
	// Classifiable is false for requests that carry no work to classify
	// (model listings, embeddings). They are read so the cursor moves past
	// them, and get no fact.
	Classifiable bool
}

// WorkIntelEndpointClassifiable reports whether requests to an endpoint are
// work to classify: the text generation endpoints, and nothing else.
func WorkIntelEndpointClassifiable(endpoint string) bool {
	e := strings.ToLower(endpoint)
	return strings.Contains(e, "completions") || strings.Contains(e, "/responses") || strings.Contains(e, "/messages")
}

// Features returns the engine input for the request.
func (r WorkIntelRequest) Features() workintel.Features {
	return workintel.Features{
		Text:        r.Text,
		TaskType:    r.TaskType,
		Languages:   r.Languages,
		MCPServers:  r.MCPServers,
		MCPTools:    r.MCPTools,
		Client:      r.Client,
		Model:       r.Model,
		Endpoint:    r.Endpoint,
		Complexity:  r.Complexity,
		PolicyFlags: r.PolicyFlags,
	}
}

// Fact returns the fact row for the request with everything that comes from
// the request filled in. The caller adds the classification with SetResult.
func (r WorkIntelRequest) Fact() WorkClassification {
	c := WorkClassification{
		RequestID:        r.RequestID,
		CreatedAt:        normalizeWorkIntelTime(r.CreatedAt),
		IngestedAt:       r.IngestedAt,
		SessionID:        r.SessionID,
		SessionKind:      workintel.SessionKind(r.SessionID),
		Team:             r.Team,
		UserKey:          r.UserKey,
		APIKeyID:         r.APIKeyID,
		Model:            r.Model,
		Provider:         r.Provider,
		Client:           r.Client,
		Endpoint:         r.Endpoint,
		Difficulty:       workintel.DifficultyOf(r.Complexity),
		Fingerprint:      r.Fingerprint,
		TokensIn:         r.TokensIn,
		TokensOut:        r.TokensOut,
		CostKRW:          r.CostKRW,
		LatencyMS:        r.LatencyMS,
		IsError:          r.StatusCode >= 400,
		MCPCalls:         r.MCPCalls,
		ToolSig:          r.ToolSig,
		PolicyFlags:      r.PolicyFlags,
		PositiveFeedback: r.PositiveFeedback,
		Tags:             []string{},
		Technologies:     []string{},
	}
	c.Day = workIntelDayOf(c.CreatedAt)
	if len(r.Languages) > 0 {
		c.Language = r.Languages[0]
	}
	return c
}

const workIntelRequestSelect = `SELECT r.id, r.created_at, r.ingested_at, COALESCE(r.session_id, ''), COALESCE(r.api_key_id, ''),
		COALESCE(NULLIF(k.team, ''), 'unassigned'),
		COALESCE(NULLIF(k.user_id, ''), NULLIF(r.api_key_id, ''), 'anonymous'),
		COALESCE(r.model, ''), COALESCE(r.provider, ''), r.endpoint, COALESCE(r.user_agent, ''),
		r.status_code, r.latency_ms, COALESCE(r.complexity, 0), COALESCE(r.task_type, ''),
		COALESCE(r.prompt_fingerprint, ''), COALESCE(r.policy_summary_json, '')
	FROM request_logs r
	LEFT JOIN api_keys k ON k.id = r.api_key_id`

// WorkIntelBatch reads the next page of requests after a cursor, oldest
// first, with everything classification needs, and returns the cursor of the
// last row read. It issues a fixed number of queries whatever the page size.
//
// The cursor is request_logs.ingested_at, which the log writer assigns under
// a lock held until commit: a row can never become visible behind a cursor
// that has already passed it.
func (s *SQLStore) WorkIntelBatch(ctx context.Context, after WorkIntelCursor, limit, maxChars int) ([]WorkIntelRequest, WorkIntelCursor, error) {
	if after.IngestedAt == "" {
		return nil, after, errors.New("work intel cursor is not initialised")
	}
	if limit <= 0 {
		limit = 200
	}
	if limit > WorkIntelMaxBatch {
		limit = WorkIntelMaxBatch
	}
	rows, err := s.workIntelRequestRows(ctx, workIntelRequestSelect+`
		WHERE r.ingested_at >= ? AND (r.ingested_at > ? OR r.id > ?) AND r.ingested_at <> ''
		ORDER BY r.ingested_at ASC, r.id ASC LIMIT ?`,
		[]any{after.IngestedAt, after.IngestedAt, after.RequestID, limit})
	if err != nil {
		return nil, after, err
	}
	next := after
	if len(rows) > 0 {
		last := rows[len(rows)-1]
		next = WorkIntelCursor{IngestedAt: last.IngestedAt, RequestID: last.RequestID}
	}
	if err := s.loadWorkIntelRequestDetails(ctx, rows, maxChars); err != nil {
		return nil, after, err
	}
	return rows, next, nil
}

// WorkIntelRequests reads the same data for specific requests (a later LLM
// retry, a reclassification), in the order the requests were ingested.
// Requests that no longer exist are absent from the result.
func (s *SQLStore) WorkIntelRequests(ctx context.Context, requestIDs []string, maxChars int) ([]WorkIntelRequest, error) {
	out := make([]WorkIntelRequest, 0, len(requestIDs))
	for _, chunk := range workChunks(requestIDs, WorkIntelMaxBatch) {
		rows, err := s.workIntelRequestRows(ctx, workIntelRequestSelect+`
			WHERE r.id IN (`+placeholders(len(chunk))+`)`, workAnyArgs(chunk))
		if err != nil {
			return nil, err
		}
		if err := s.loadWorkIntelRequestDetails(ctx, rows, maxChars); err != nil {
			return nil, err
		}
		out = append(out, rows...)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].IngestedAt != out[j].IngestedAt {
			return out[i].IngestedAt < out[j].IngestedAt
		}
		return out[i].RequestID < out[j].RequestID
	})
	return out, nil
}

func (s *SQLStore) workIntelRequestRows(ctx context.Context, query string, args []any) ([]WorkIntelRequest, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkIntelRequest{}
	for rows.Next() {
		var r WorkIntelRequest
		var userAgent, policySummary string
		if err := rows.Scan(&r.RequestID, &r.CreatedAt, &r.IngestedAt, &r.SessionID, &r.APIKeyID, &r.Team, &r.UserKey,
			&r.Model, &r.Provider, &r.Endpoint, &userAgent, &r.StatusCode, &r.LatencyMS, &r.Complexity, &r.TaskType,
			&r.Fingerprint, &policySummary); err != nil {
			return nil, err
		}
		r.Client = classifyAgent(userAgent)
		r.Classifiable = WorkIntelEndpointClassifiable(r.Endpoint)
		r.PolicyFlags = workPolicyFlagsFromSummary(policySummary)
		r.Languages, r.MCPServers, r.MCPTools = []string{}, []string{}, []string{}
		out = append(out, r)
	}
	return out, rows.Err()
}

// workPolicyFlagsFromSummary reads the flags the request path left in the
// policy summary: a "dlp" section, and the secret types the secret firewall
// found. The firewall's action alone says nothing, because the summary
// records "detect" for requests in which nothing was found.
func workPolicyFlagsFromSummary(raw string) []string {
	flags := []string{}
	if raw == "" {
		return flags
	}
	var summary struct {
		DLP         json.RawMessage `json:"dlp"`
		SecretTypes []string        `json:"secret_types"`
	}
	if json.Unmarshal([]byte(raw), &summary) != nil {
		return flags
	}
	if len(summary.DLP) > 0 && string(summary.DLP) != "null" {
		flags = append(flags, WorkFlagDLP)
	}
	if len(summary.SecretTypes) > 0 {
		flags = append(flags, WorkFlagSecret)
	}
	return flags
}

func workAddFlag(flags []string, flag string) []string {
	for _, f := range flags {
		if f == flag {
			return flags
		}
	}
	return append(flags, flag)
}

// loadWorkIntelRequestDetails fills in what lives in the child tables of the
// classifiable requests of one page: one query per table.
func (s *SQLStore) loadWorkIntelRequestDetails(ctx context.Context, requests []WorkIntelRequest, maxChars int) error {
	if maxChars <= 0 {
		maxChars = workintel.DefaultPolicy().LLM.MaxInputChars
	}
	index := make(map[string]int, len(requests))
	ids := make([]string, 0, len(requests))
	for i := range requests {
		if requests[i].Classifiable {
			index[requests[i].RequestID] = i
			ids = append(ids, requests[i].RequestID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	in := placeholders(len(ids))
	args := workAnyArgs(ids)

	each := func(query string, queryArgs []any, scan func(scanner workRowScanner) error) error {
		rows, err := s.db.QueryContext(ctx, s.bind(query), queryArgs...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			if err := scan(rows); err != nil {
				return err
			}
		}
		return rows.Err()
	}

	if err := each(`SELECT request_id, COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0), COALESCE(SUM(estimated_cost), 0)
		FROM token_usage WHERE request_id IN (`+in+`) GROUP BY request_id`, args, func(row workRowScanner) error {
		var id string
		var tokensIn, tokensOut int64
		var cost float64
		if err := row.Scan(&id, &tokensIn, &tokensOut, &cost); err != nil {
			return err
		}
		if i, ok := index[id]; ok {
			requests[i].TokensIn, requests[i].TokensOut, requests[i].CostKRW = tokensIn, tokensOut, cost
		}
		return nil
	}); err != nil {
		return err
	}

	type language struct {
		name       string
		confidence float64
	}
	languages := map[string][]language{}
	if err := each(`SELECT request_id, language, confidence
		FROM language_stats WHERE request_id IN (`+in+`) AND confidence >= ?`, append(append([]any{}, args...), workLanguageMinConfidence), func(row workRowScanner) error {
		var id string
		var l language
		if err := row.Scan(&id, &l.name, &l.confidence); err != nil {
			return err
		}
		languages[id] = append(languages[id], l)
		return nil
	}); err != nil {
		return err
	}
	for id, list := range languages {
		sort.SliceStable(list, func(a, b int) bool {
			if list[a].confidence != list[b].confidence {
				return list[a].confidence > list[b].confidence
			}
			return list[a].name < list[b].name
		})
		if i, ok := index[id]; ok {
			for _, l := range list {
				requests[i].Languages = append(requests[i].Languages, l.name)
			}
		}
	}

	type toolUse struct {
		servers, tools, called map[string]bool
		mcpCalls               int64
	}
	uses := map[string]*toolUse{}
	if err := each(`SELECT request_id, COALESCE(server_label, ''), tool_name, source, is_mcp
		FROM tool_invocations WHERE request_id IN (`+in+`) AND source <> 'definition'`, args, func(row workRowScanner) error {
		var id, server, tool, source string
		var isMCP int
		if err := row.Scan(&id, &server, &tool, &source, &isMCP); err != nil {
			return err
		}
		u := uses[id]
		if u == nil {
			u = &toolUse{servers: map[string]bool{}, tools: map[string]bool{}, called: map[string]bool{}}
			uses[id] = u
		}
		// "(none)" and "builtin" are placeholders the capture side uses for tools
		// that belong to no server.
		if server == "(none)" || server == "builtin" {
			server = ""
		}
		server, tool = workToolLabel(server), workToolLabel(tool)
		if server != "" {
			u.servers[server] = true
		}
		if tool != "" {
			u.tools[tool] = true
		}
		if source == "call" {
			if isMCP != 0 {
				u.mcpCalls++
			}
			if tool != "" {
				if server != "" {
					tool = server + "/" + tool
				}
				u.called[tool] = true
			}
		}
		return nil
	}); err != nil {
		return err
	}
	for id, u := range uses {
		i, ok := index[id]
		if !ok {
			continue
		}
		requests[i].MCPServers = workSortedKeys(u.servers)
		requests[i].MCPTools = workSortedKeys(u.tools)
		requests[i].MCPCalls = u.mcpCalls
		called := workSortedKeys(u.called)
		if len(called) > workToolSigMaxTools {
			called = called[:workToolSigMaxTools]
		}
		requests[i].ToolSig = strings.Join(called, ",")
	}

	// The messages of one request share a timestamp, so the insertion order
	// column decides which user message is the latest. Only the shape is read
	// here; the text of the chosen message is fetched, truncated, below.
	latest := map[string]string{}
	if err := each(`SELECT request_id, id, role
		FROM prompt_logs WHERE request_id IN (`+in+`)
		ORDER BY request_id, created_at ASC, `+s.insertionOrderColumn(), args, func(row workRowScanner) error {
		var id, promptID, role string
		if err := row.Scan(&id, &promptID, &role); err != nil {
			return err
		}
		if strings.EqualFold(role, "user") || strings.EqualFold(role, "input") {
			latest[id] = promptID
		}
		return nil
	}); err != nil {
		return err
	}
	if len(latest) > 0 {
		promptArgs := make([]any, 0, len(latest)+1)
		promptArgs = append(promptArgs, maxChars)
		for _, promptID := range latest {
			promptArgs = append(promptArgs, promptID)
		}
		// redacted_text only: the raw content column is never read here.
		if err := each(`SELECT request_id, SUBSTR(COALESCE(redacted_text, ''), 1, ?)
			FROM prompt_logs WHERE id IN (`+placeholders(len(latest))+`)`, promptArgs, func(row workRowScanner) error {
			var id, text string
			if err := row.Scan(&id, &text); err != nil {
				return err
			}
			if i, ok := index[id]; ok {
				requests[i].Text = text
			}
			return nil
		}); err != nil {
			return err
		}
	}

	flag := func(query, name string) error {
		return each(query, args, func(row workRowScanner) error {
			var id string
			if err := row.Scan(&id); err != nil {
				return err
			}
			if i, ok := index[id]; ok {
				requests[i].PolicyFlags = workAddFlag(requests[i].PolicyFlags, name)
			}
			return nil
		})
	}
	if err := flag(`SELECT DISTINCT request_id FROM dlp_events WHERE request_id IN (`+in+`)`, WorkFlagDLP); err != nil {
		return err
	}
	if err := flag(`SELECT DISTINCT request_id FROM secret_events WHERE request_id IN (`+in+`)`, WorkFlagSecret); err != nil {
		return err
	}
	for i := range requests {
		sort.Strings(requests[i].PolicyFlags)
	}

	return each(`SELECT request_id, rating FROM llm_feedback WHERE request_id IN (`+in+`)`, args, func(row workRowScanner) error {
		var id string
		var rating int
		if err := row.Scan(&id, &rating); err != nil {
			return err
		}
		if i, ok := index[id]; ok && rating > 0 {
			requests[i].PositiveFeedback = true
		}
		return nil
	})
}

// workToolLabel keeps a tool or server name usable as a label: identifier
// characters only, bounded. The names come from client requests.
func workToolLabel(name string) string {
	name = strings.TrimSpace(name)
	if len(name) > workToolNameMaxBytes {
		name = name[:workToolNameMaxBytes]
	}
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		case r == '_', r == '-', r == '.', r == ':':
			return r
		}
		return -1
	}, name)
}

func workSortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
