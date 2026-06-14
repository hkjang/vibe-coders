package proxy

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
	"vibe-coders/internal/text2sql"
)

// handleText2SQL runs the Text2SQL pipeline for a vibe/text2sql-* request: it picks
// a real upstream model, generates read-only SQL via an internal (non-recursive)
// LLM call, validates it, optionally executes it read-only and summarizes the
// result, and returns a normal Chat Completion response. It returns false from the
// upstream step's perspective (the response is fully written here).
func (s *Server) handleText2SQL(w http.ResponseWriter, r *http.Request, meta store.LogRecord, body []byte, authCtx *store.AuthContext) {
	start := time.Now()
	cfg := s.cfg.Text2SQL
	models := text2sql.Models{
		Preview: cfg.PreviewModel, Execute: cfg.ExecuteModel, Accurate: cfg.AccurateModel,
		Local: cfg.LocalModel, Summary: cfg.SummaryModel,
	}
	profile := text2sql.ResolveProfile(meta.Request.Model, models)

	// Auto profile: pick the upstream model from the (already computed) complexity.
	upstreamModel := profile.UpstreamModel
	if profile.Auto || upstreamModel == "" {
		upstreamModel = s.text2sqlAutoModelByComplexity(meta.Request.Complexity)
	}
	summaryModel := firstNonEmpty(profile.SummaryModel, cfg.SummaryModel, upstreamModel)

	question := text2sql.LastUserQuestion(body)
	schema := firstNonEmpty(strings.TrimSpace(r.Header.Get("X-Text2SQL-Schema")), cfg.Schema)

	logRec := store.Text2SQLQueryLog{
		ID: newID("t2s"), RequestID: meta.Request.ID, APIKeyID: meta.Request.APIKeyID,
		VirtualModel: meta.Request.Model, UpstreamModel: upstreamModel, Mode: string(profile.Mode),
		Question: question, CreatedAt: time.Now().UTC(),
	}
	if authCtx != nil {
		logRec.Team = authCtx.TeamID
	}

	// finalize writes the response + audit + t2s log with a consistent shape.
	finalize := func(content string, validation text2sql.ValidationResult, executed bool, rowCount int64, errMsg string, costKRW float64) {
		logRec.GeneratedSQL = validation.SQL
		logRec.Valid = validation.OK
		logRec.RejectReason = validation.Reason
		logRec.Executed = executed
		logRec.RowCount = rowCount
		logRec.Error = errMsg
		logRec.CostKRW = costKRW
		logRec.LatencyMS = time.Since(start).Milliseconds()
		_ = s.db.InsertText2SQLLog(r.Context(), logRec)

		meta.Request.TaskType = "text2sql"
		meta.Request.RouteReason = "text2sql"
		meta.Request.RouteDetail = "upstream:" + upstreamModel
		meta.Request.StatusCode = http.StatusOK
		meta.Request.LatencyMS = time.Since(start).Milliseconds()
		if costKRW > 0 {
			meta.Usage = &store.TokenUsage{
				ID: newID("usage"), RequestID: meta.Request.ID, EstimatedCost: costKRW,
				Currency: "KRW", Source: "text2sql", CreatedAt: time.Now().UTC(),
			}
		}
		meta.Evaluations = buildLLMEvaluations(meta, ResponseAnalysis{})
		s.enqueue(meta)
		s.writeChatCompletion(w, meta.Request.Model, content)
	}

	if question == "" {
		finalize("질문(자연어)이 비어 있습니다. user 메시지에 질의를 입력하세요.", text2sql.ValidationResult{Reason: "empty question"}, false, 0, "empty question", 0)
		return
	}

	// 1) Generate SQL via the chosen upstream model (internal, non-recursive call).
	msgs := text2sql.BuildGenerationMessages(cfg.Dialect, schema, question, cfg.DefaultLimit)
	gen := s.runGovernanceChat(r.Context(), r, upstreamModel, text2sql.MessagesJSON(msgs))
	totalCost := gen.CostKRW
	if gen.Error != "" {
		finalize("SQL 생성 업스트림 호출 실패: "+gen.Error, text2sql.ValidationResult{Reason: "upstream error"}, false, 0, gen.Error, totalCost)
		return
	}

	// 2) Extract + validate.
	rawSQL := text2sql.ExtractSQL(gen.Response)
	validation := text2sql.ValidateSQL(rawSQL, text2sql.ValidateOptions{
		DefaultLimit: cfg.DefaultLimit, MaxLimit: cfg.MaxLimit,
	})
	if !validation.OK {
		content := fmt.Sprintf("생성된 SQL이 안전 검증을 통과하지 못했습니다 (사유: %s).\n\n```sql\n%s\n```", validation.Reason, strings.TrimSpace(rawSQL))
		finalize(content, validation, false, 0, validation.Reason, totalCost)
		return
	}

	// 3) Preview mode (default): return the validated SQL + a short note.
	if profile.Mode != text2sql.ModeExecute || cfg.ExecDSN == "" {
		note := "검증된 읽기 전용 SQL입니다 (실행하지 않음)."
		if profile.Mode == text2sql.ModeExecute && cfg.ExecDSN == "" {
			note = "실행 DB가 설정되지 않아 미리보기만 제공합니다 (TEXT2SQL_EXEC_DSN)."
		}
		finalize(previewContent(validation.SQL, note, validation.Tables), validation, false, 0, "", totalCost)
		return
	}

	// 4) Execute mode: run the validated SELECT read-only.
	cols, rows, rowCount, execErr := s.execText2SQL(r.Context(), validation.SQL)
	if execErr != nil {
		finalize("SQL 실행 실패: "+execErr.Error()+"\n\n```sql\n"+validation.SQL+"\n```", validation, false, 0, execErr.Error(), totalCost)
		return
	}
	table := renderResultTable(cols, rows)

	// 5) Optional natural-language summary of the result.
	summary := ""
	if summaryModel != "" && rowCount > 0 {
		sumPrompt := text2sql.MessagesJSON([]text2sql.Message{
			{Role: "system", Content: "다음 SQL 실행 결과를 한국어로 2~3문장으로 간결하게 요약하라. 숫자는 정확히."},
			{Role: "user", Content: "질문: " + question + "\n\nSQL:\n" + validation.SQL + "\n\n결과(상위 행):\n" + table},
		})
		sum := s.runGovernanceChat(r.Context(), r, summaryModel, sumPrompt)
		totalCost += sum.CostKRW
		if sum.Error == "" {
			summary = strings.TrimSpace(sum.Response)
		}
	}

	content := executeContent(validation.SQL, table, rowCount, summary)
	finalize(content, validation, true, rowCount, "", totalCost)
}

// text2sqlAutoModelByComplexity maps a complexity score to an upstream model for
// the auto profile (reusing the already-computed request complexity).
func (s *Server) text2sqlAutoModelByComplexity(complexity int) string {
	cfg := s.cfg.Text2SQL
	switch {
	case complexity >= 67:
		return firstNonEmpty(cfg.AccurateModel, cfg.ExecuteModel, cfg.PreviewModel)
	case complexity >= 34:
		return firstNonEmpty(cfg.ExecuteModel, cfg.PreviewModel)
	default:
		return firstNonEmpty(cfg.PreviewModel, cfg.ExecuteModel)
	}
}

func previewContent(sql, note string, tables []string) string {
	var b strings.Builder
	b.WriteString("```sql\n")
	b.WriteString(sql)
	b.WriteString("\n```\n\n")
	b.WriteString(note)
	if len(tables) > 0 {
		b.WriteString("\n\n참조 테이블: " + strings.Join(tables, ", "))
	}
	return b.String()
}

func executeContent(sql, table string, rowCount int64, summary string) string {
	var b strings.Builder
	if summary != "" {
		b.WriteString(summary)
		b.WriteString("\n\n")
	}
	b.WriteString(fmt.Sprintf("결과 %d행.\n\n", rowCount))
	b.WriteString(table)
	b.WriteString("\n\n```sql\n")
	b.WriteString(sql)
	b.WriteString("\n```")
	return b.String()
}

// writeChatCompletion emits an OpenAI-compatible chat.completion response so the
// client sees a normal response for the virtual model.
func (s *Server) writeChatCompletion(w http.ResponseWriter, model, content string) {
	resp := map[string]any{
		"id":      "chatcmpl-" + newID("t2s"),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []map[string]any{{
			"index":         0,
			"message":       map[string]any{"role": "assistant", "content": content},
			"finish_reason": "stop",
		}},
		"usage": map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Task-Type", "text2sql")
	_ = json.NewEncoder(w).Encode(resp)
}

// renderResultTable renders columns + rows as a compact Markdown table (capped).
func renderResultTable(cols []string, rows [][]string) string {
	if len(cols) == 0 {
		return "(컬럼 없음)"
	}
	var b strings.Builder
	b.WriteString("| " + strings.Join(cols, " | ") + " |\n")
	b.WriteString("|" + strings.Repeat(" --- |", len(cols)) + "\n")
	for i, row := range rows {
		if i >= 50 {
			b.WriteString(fmt.Sprintf("\n…(%d행 더 있음)", len(rows)-50))
			break
		}
		b.WriteString("| " + strings.Join(row, " | ") + " |\n")
	}
	return b.String()
}

// execText2SQL opens (lazily) the read-only execute DB and runs the validated query.
func (s *Server) execText2SQL(ctx context.Context, query string) ([]string, [][]string, int64, error) {
	db, err := s.text2sqlExecDB()
	if err != nil {
		return nil, nil, 0, err
	}
	rowLimit := s.cfg.Text2SQL.MaxLimit
	if rowLimit <= 0 {
		rowLimit = 1000
	}
	return executeReadOnlyQuery(ctx, db, s.cfg.Text2SQL.ExecDriver, query, rowLimit)
}

func (s *Server) text2sqlExecDB() (*sql.DB, error) {
	if db := s.t2sExec.Load(); db != nil {
		return db, nil
	}
	driver := strings.ToLower(strings.TrimSpace(s.cfg.Text2SQL.ExecDriver))
	if driver == "postgres" || driver == "postgresql" {
		driver = "pgx"
	}
	if driver == "" {
		driver = "sqlite"
	}
	db, err := sql.Open(driver, s.cfg.Text2SQL.ExecDSN)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	s.t2sExec.Store(db)
	return db, nil
}

// executeReadOnlyQuery runs a SELECT with a timeout and row cap. The SQL has already
// been validated as a single read-only statement.
func executeReadOnlyQuery(ctx context.Context, db *sql.DB, driver, query string, rowLimit int) ([]string, [][]string, int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, 0, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, nil, 0, err
	}
	out := [][]string{}
	var count int64
	for rows.Next() {
		count++
		if len(out) >= rowLimit {
			continue // keep counting but stop materializing
		}
		cells := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range cells {
			ptrs[i] = &cells[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, nil, 0, err
		}
		strRow := make([]string, len(cols))
		for i, c := range cells {
			strRow[i] = cellToString(c)
		}
		out = append(out, strRow)
	}
	return cols, out, count, rows.Err()
}

func cellToString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case []byte:
		return string(t)
	case string:
		return t
	default:
		return fmt.Sprintf("%v", t)
	}
}
