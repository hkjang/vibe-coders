package store

import (
	"context"
	"strings"
)

// RequestIOSampleFilter selects the requests whose captured input and output are
// sampled for an at-a-glance listing. Requests outside the caller's team scope are
// omitted exactly as if they did not exist.
type RequestIOSampleFilter struct {
	IDs        []string
	Teams      []string
	TeamScoped bool
	// TextChars bounds the text read per message and per response so a listing never
	// pulls a whole conversation or a whole response body out of the database.
	TextChars int
}

// RequestIOSample is one request's captured input and output, already bounded.
type RequestIOSample struct {
	RequestID    string
	StatusCode   int
	MessageCount int
	InputChars   int64
	LastRole     string
	LastInput    string
	LastChars    int64

	ResponseFound bool
	ResponseHash  string
	FinishReason  string
	OutputChars   int64
	Output        string

	ToolNames []string
}

// insertionOrderColumn breaks ties on prompt_logs.created_at. One request's messages all
// share a timestamp and SQL promises no order among equal keys, so without this the database
// would be free to return the conversation shuffled.
func (s *SQLStore) insertionOrderColumn() string {
	if s.dialect == "postgres" {
		return "ctid"
	}
	return "rowid"
}

// promptRoleIsConversation reports whether a prompt_logs role is a message in the
// conversation. The capture side also stores the declared tool definitions as a
// pseudo-role row, which is not something the caller said.
func promptRoleIsConversation(role string) bool {
	return !strings.EqualFold(role, "tools")
}

// RequestIOSamples reads the captured input and output of up to len(filter.IDs)
// requests in four bounded queries rather than one set of queries per request.
func (s *SQLStore) RequestIOSamples(ctx context.Context, filter RequestIOSampleFilter) (map[string]RequestIOSample, error) {
	samples := make(map[string]RequestIOSample, len(filter.IDs))
	if len(filter.IDs) == 0 {
		return samples, nil
	}
	textChars := filter.TextChars
	if textChars <= 0 {
		textChars = 4096
	}

	ids := make([]any, 0, len(filter.IDs))
	for _, id := range filter.IDs {
		ids = append(ids, id)
	}
	placeholders := strings.Repeat(",?", len(ids))[1:]

	validRequestAPIKey := renderForDialect(appRequestBoundedTextPredicate("r.api_key_id"), s.dialect)
	validTeamKey := renderForDialect(appRequestBoundedTextPredicate("k.id")+" AND "+appRequestBoundedTextPredicate("k.team"), s.dialect)
	where := []string{"r.id IN (" + placeholders + ")"}
	args := append([]any{}, ids...)
	where, args = appendRequestTeamConditionWithPredicates(
		where, args, "", filter.Teams, filter.TeamScoped, validRequestAPIKey, validTeamKey,
		s.dialect == "sqlite",
	)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT r.id, r.status_code FROM request_logs r WHERE `+strings.Join(where, " AND ")), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	visible := make([]any, 0, len(ids))
	for rows.Next() {
		var sample RequestIOSample
		if err := rows.Scan(&sample.RequestID, &sample.StatusCode); err != nil {
			return nil, err
		}
		samples[sample.RequestID] = sample
		visible = append(visible, sample.RequestID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(visible) == 0 {
		return samples, nil
	}
	placeholders = strings.Repeat(",?", len(visible))[1:]

	lastPrompt, err := s.sampleRequestIOPromptShape(ctx, visible, placeholders, samples)
	if err != nil {
		return nil, err
	}
	if err := s.sampleRequestIOPromptText(ctx, lastPrompt, textChars, samples); err != nil {
		return nil, err
	}
	if err := s.sampleRequestIOResponses(ctx, visible, placeholders, textChars, samples); err != nil {
		return nil, err
	}
	if err := s.sampleRequestIOTools(ctx, visible, placeholders, samples); err != nil {
		return nil, err
	}
	return samples, nil
}

// sampleRequestIOPromptShape reads message shapes without their text, so a long agent
// conversation costs one small row per message, and returns the id of the message that
// best represents each request: the last user message, else the last message.
func (s *SQLStore) sampleRequestIOPromptShape(ctx context.Context, ids []any, placeholders string, samples map[string]RequestIOSample) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT request_id, id, role, LENGTH(COALESCE(redacted_text, ''))
		FROM prompt_logs
		WHERE request_id IN (`+placeholders+`)
		ORDER BY request_id, created_at ASC, `+s.insertionOrderColumn()+`
	`), ids...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	last := make(map[string]string, len(ids))
	lastIsUser := make(map[string]bool, len(ids))
	for rows.Next() {
		var requestID, promptID, role string
		var chars int64
		if err := rows.Scan(&requestID, &promptID, &role, &chars); err != nil {
			return nil, err
		}
		sample, ok := samples[requestID]
		if !ok || !promptRoleIsConversation(role) {
			continue
		}
		sample.MessageCount++
		sample.InputChars += chars
		isUser := strings.EqualFold(role, "user") || strings.EqualFold(role, "input")
		if isUser || !lastIsUser[requestID] {
			last[requestID] = promptID
			lastIsUser[requestID] = isUser
			sample.LastRole = role
			sample.LastChars = chars
		}
		samples[requestID] = sample
	}
	return last, rows.Err()
}

func (s *SQLStore) sampleRequestIOPromptText(ctx context.Context, lastPrompt map[string]string, textChars int, samples map[string]RequestIOSample) error {
	if len(lastPrompt) == 0 {
		return nil
	}
	args := make([]any, 0, len(lastPrompt)+1)
	args = append(args, textChars)
	for _, promptID := range lastPrompt {
		args = append(args, promptID)
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT request_id, SUBSTR(COALESCE(redacted_text, ''), 1, ?)
		FROM prompt_logs
		WHERE id IN (`+strings.Repeat(",?", len(lastPrompt))[1:]+`)
	`), args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var requestID, text string
		if err := rows.Scan(&requestID, &text); err != nil {
			return err
		}
		if sample, ok := samples[requestID]; ok {
			sample.LastInput = text
			samples[requestID] = sample
		}
	}
	return rows.Err()
}

func (s *SQLStore) sampleRequestIOResponses(ctx context.Context, ids []any, placeholders string, textChars int, samples map[string]RequestIOSample) error {
	args := make([]any, 0, len(ids)+1)
	args = append(args, textChars)
	args = append(args, ids...)
	// Ascending order leaves the newest response of a request in the sample.
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT request_id, COALESCE(finish_reason, ''), COALESCE(response_hash, ''),
			LENGTH(COALESCE(response_text_optional, '')), SUBSTR(COALESCE(response_text_optional, ''), 1, ?)
		FROM response_logs
		WHERE request_id IN (`+placeholders+`)
		ORDER BY request_id, created_at ASC
	`), args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var requestID, finishReason, hash, text string
		var chars int64
		if err := rows.Scan(&requestID, &finishReason, &hash, &chars, &text); err != nil {
			return err
		}
		sample, ok := samples[requestID]
		if !ok {
			continue
		}
		sample.ResponseFound = true
		sample.FinishReason = finishReason
		sample.ResponseHash = hash
		sample.OutputChars = chars
		sample.Output = text
		samples[requestID] = sample
	}
	return rows.Err()
}

func (s *SQLStore) sampleRequestIOTools(ctx context.Context, ids []any, placeholders string, samples map[string]RequestIOSample) error {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT request_id, tool_name, source
		FROM tool_invocations
		WHERE request_id IN (`+placeholders+`)
		ORDER BY request_id, created_at ASC
	`), ids...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var requestID, tool, source string
		if err := rows.Scan(&requestID, &tool, &source); err != nil {
			return err
		}
		if sample, ok := samples[requestID]; ok && source == "call" {
			sample.ToolNames = append(sample.ToolNames, tool)
			samples[requestID] = sample
		}
	}
	return rows.Err()
}
