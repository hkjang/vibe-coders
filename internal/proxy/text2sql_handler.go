package proxy

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
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

	// DB profile override: lets operators define/override virtual-model mappings (and
	// add new virtual models) at runtime without a redeploy.
	profileSchemaName := ""
	if dbp, found, _ := s.db.GetText2SQLProfile(r.Context(), meta.Request.Model); found && dbp.Enabled {
		if dbp.Mode != "" {
			profile.Mode = text2sql.Mode(dbp.Mode)
		}
		if dbp.UpstreamModel != "" {
			profile.UpstreamModel = dbp.UpstreamModel
			profile.Auto = false
		}
		if dbp.SummaryModel != "" {
			profile.SummaryModel = dbp.SummaryModel
		}
		profileSchemaName = dbp.SchemaName
	}

	// Auto profile: pick the upstream model from complexity, then upgrade to the
	// accurate model when recent metrics show the cheaper pick is unreliable.
	upstreamModel := profile.UpstreamModel
	if profile.Auto || upstreamModel == "" {
		base := s.text2sqlAutoModelByComplexity(meta.Request.Complexity)
		upstreamModel = base
		if metrics, err := s.db.Text2SQLModelMetricsSince(r.Context(), time.Now().Add(-7*24*time.Hour)); err == nil {
			for _, m := range metrics {
				if m.UpstreamModel == base {
					upstreamModel = chooseUpstreamByQuality(base, cfg.AccurateModel, m)
					break
				}
			}
		}
	}
	summaryModel := firstNonEmpty(profile.SummaryModel, cfg.SummaryModel, upstreamModel)

	question := text2sql.LastUserQuestion(body)

	// Resolve the schema catalog: an explicitly named schema (team-scoped), else the
	// team/global default, else the inline config schema. The catalog also supplies
	// the table allowlist used to validate the generated SQL.
	team := ""
	if authCtx != nil {
		team = authCtx.TeamID
	}
	dialect := cfg.Dialect
	schema := firstNonEmpty(strings.TrimSpace(r.Header.Get("X-Text2SQL-Schema")), cfg.Schema)
	var allowedTables, blockedColumns, aggregateOnly, maskColumns []string
	resolvedSchemaName := ""
	schemaVersion := 0
	schemaName := firstNonEmpty(strings.TrimSpace(r.Header.Get("X-Text2SQL-Schema-Name")), profileSchemaName)
	if sc, found, _ := s.db.ResolveText2SQLSchema(r.Context(), schemaName, team); found {
		schema = sc.SchemaText
		allowedTables = sc.AllowedTables
		resolvedSchemaName = sc.Name
		schemaVersion = sc.Version
		if sc.Dialect != "" {
			dialect = sc.Dialect
		}
		// Structured registry (tables/columns) takes precedence over the free-text
		// schema blob: render the prompt context from it (excluding sensitive
		// columns) and derive the table allowlist + blocked/aggregate-only lists.
		if cat, err := s.db.BuildSchemaCatalog(r.Context(), sc.Name); err == nil && cat.HasTables {
			schema = cat.ContextText
			allowedTables = cat.AllowedTables
			blockedColumns = cat.ExcludedColumns
			aggregateOnly = cat.AggregateOnlyColumns
			maskColumns = cat.MaskColumns
		}
		// Permission matrix overlay: per subject (api_key/team/*) deny rules restrict
		// the table allowlist + add blocked columns; allow rules grant access to a
		// sensitivity-excluded column for that subject.
		if eff, err := s.db.ResolveText2SQLPermissions(r.Context(), sc.Name, meta.Request.APIKeyID, team); err == nil {
			allowedTables = applyPermissionEffect(allowedTables, &blockedColumns, eff)
		}
	}

	// Glossary text + reproducibility hashes. These capture the exact state that
	// shaped this generation — the effective table/column access after the permission
	// overlay, and the business-glossary revision — so a logged SQL can be explained
	// later, and so the preview cache never reuses SQL across subjects whose access or
	// vocabulary differ.
	glossaryText, _ := s.db.BuildGlossaryText(r.Context(), resolvedSchemaName)
	glossaryHash := shortHash(glossaryText)
	permissionHash := shortHash(strings.Join(sortedCopy(allowedTables), ",") + "|" + strings.Join(sortedCopy(blockedColumns), ",") + "|" + strings.Join(sortedCopy(aggregateOnly), ","))

	logRec := store.Text2SQLQueryLog{
		ID: newID("t2s"), RequestID: meta.Request.ID, APIKeyID: meta.Request.APIKeyID,
		VirtualModel: meta.Request.Model, UpstreamModel: upstreamModel, Mode: string(profile.Mode),
		Question: question, SchemaName: resolvedSchemaName, SchemaVersion: schemaVersion,
		PermissionHash: permissionHash, GlossaryHash: glossaryHash, CreatedAt: time.Now().UTC(),
	}

	// generationPrompt captures the exact messages JSON sent upstream for replay bundles
	// (set once the prompt is assembled). Empty for cache hits / clarifications.
	generationPrompt := ""
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
		logRec.FailureCategory = classifyText2SQLFailure(validation, executed, rowCount, errMsg)
		logRec.CostKRW = costKRW
		logRec.LatencyMS = time.Since(start).Milliseconds()
		_ = s.db.InsertText2SQLLog(r.Context(), logRec)

		// Replay bundle (opt-in): persist the full generation context so an operator can
		// reproduce/explain this SQL later, beyond the hashes on the log row.
		if cfg.ReplayBundles && generationPrompt != "" {
			snapshot, _ := json.Marshal(map[string][]string{
				"allowed_tables": allowedTables, "blocked_columns": blockedColumns,
				"aggregate_only": aggregateOnly, "mask_columns": maskColumns,
			})
			_ = s.db.PutText2SQLReplayBundle(r.Context(), store.Text2SQLReplayBundle{
				ID: logRec.ID, RequestID: logRec.RequestID, SchemaName: resolvedSchemaName, SchemaVersion: schemaVersion,
				SystemPrompt: generationPrompt, SchemaContext: schema, GlossaryText: glossaryText,
				PermissionSnapshot: string(snapshot), GeneratedSQL: validation.SQL,
			})
		}

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
		meta.Evaluations = append(meta.Evaluations, text2sqlEvaluations(meta.Request.ID, meta.Request.TraceID, validation, executed, errMsg)...)
		s.metrics.ObserveLLMEvaluations(meta.Evaluations)
		s.enqueue(meta)
		// Auto-candidate: a valid (and, in execute mode, successful) query is worth
		// proposing as a golden example for later admin promotion. Best-effort, async.
		if validation.OK && question != "" && (profile.Mode != text2sql.ModeExecute || executed) {
			q, sqlText, sn := question, validation.SQL, schemaName
			go func() {
				cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = s.db.AddText2SQLGoldenCandidate(cctx, newID("t2sg"), q, sqlText, sn)
			}()
		}
		s.writeChatCompletion(w, meta.Request.Model, content)
	}

	if question == "" {
		finalize("질문(자연어)이 비어 있습니다. user 메시지에 질의를 입력하세요.", text2sql.ValidationResult{Reason: "empty question"}, false, 0, "empty question", 0)
		return
	}

	// 0) Clarification: ask instead of guessing when the question is underspecified.
	if cfg.ClarifyEnabled {
		if need, missing := text2sql.NeedsClarification(question, cfg.RequireDateFilter); need {
			content := "질문을 명확히 하기 위해 다음 정보가 필요합니다:\n- " + strings.Join(missing, "\n- ") + "\n\n위 내용을 포함해 다시 질문해 주세요."
			finalize(content, text2sql.ValidationResult{Reason: "clarification_required"}, false, 0, "clarification", 0)
			return
		}
	}

	// 1) Generate SQL. Preview results are cached by question+schema(version)+mode to
	// avoid repeated upstream generation cost.
	cacheKey := ""
	if cfg.CacheEnabled && profile.Mode != text2sql.ModeExecute {
		cacheKey = store.Text2SQLCacheKey(question, resolvedSchemaName, string(profile.Mode), schemaVersion, permissionHash, glossaryHash)
		if cached, hit, _ := s.db.GetText2SQLCache(r.Context(), cacheKey); hit {
			validation := text2sql.ValidateSQL(cached, text2sql.ValidateOptions{DefaultLimit: cfg.DefaultLimit, MaxLimit: cfg.MaxLimit, AllowedTables: allowedTables, BlockedColumns: blockedColumns, AggregateOnlyColumns: aggregateOnly})
			if validation.OK {
				finalize(previewContent(question, validation.SQL, "검증된 읽기 전용 SQL입니다 (캐시 적중, 실행하지 않음).", validation), validation, false, 0, "", 0)
				return
			}
		}
	}
	msgs := text2sql.BuildGenerationMessages(dialect, schema, question, cfg.DefaultLimit)
	if glossaryText != "" {
		msgs = text2sql.WithGlossary(msgs, glossaryText)
	}
	// Few-shot: inject the most relevant verified golden queries to improve generation.
	if goldens, err := s.db.ListText2SQLGoldenQueries(r.Context(), true); err == nil && len(goldens) > 0 {
		examples := make([]text2sql.Example, 0, len(goldens))
		for _, g := range goldens {
			examples = append(examples, text2sql.Example{Question: g.Question, SQL: g.ExpectedSQL})
		}
		msgs = text2sql.WithExamples(msgs, text2sql.SelectExamples(examples, question, 3))
	}
	generationPrompt = text2sql.MessagesJSON(msgs)
	gen := s.runGovernanceChat(r.Context(), r, upstreamModel, generationPrompt)
	totalCost := gen.CostKRW
	if gen.Error != "" {
		finalize("SQL 생성 업스트림 호출 실패: "+gen.Error, text2sql.ValidationResult{Reason: "upstream error"}, false, 0, gen.Error, totalCost)
		return
	}

	// 2) Extract + validate.
	rawSQL := text2sql.ExtractSQL(gen.Response)
	validation := text2sql.ValidateSQL(rawSQL, text2sql.ValidateOptions{
		DefaultLimit: cfg.DefaultLimit, MaxLimit: cfg.MaxLimit, AllowedTables: allowedTables, BlockedColumns: blockedColumns, AggregateOnlyColumns: aggregateOnly,
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
		if cacheKey != "" {
			_ = s.db.PutText2SQLCache(r.Context(), cacheKey, resolvedSchemaName, string(profile.Mode), validation.SQL, cfg.CacheTTL)
		}
		// Shadow evaluation: on a sampled fraction of previews, regenerate the SQL with
		// candidate models in the background and record their validity as shadow logs
		// (feeding only the per-model quality view, not the live KPIs). Off by default.
		if validation.OK && len(cfg.ShadowModels) > 0 && shouldShadowSample(question, cfg.ShadowSampleRate) {
			// Validate shadow output under the SAME policy as the live path (table
			// allowlist, blocked + aggregate-only columns), so shadow validity rates are
			// comparable to live quality and not inflated by a laxer check.
			shadowOpts := text2sql.ValidateOptions{
				DefaultLimit: cfg.DefaultLimit, MaxLimit: cfg.MaxLimit,
				AllowedTables: allowedTables, BlockedColumns: blockedColumns, AggregateOnlyColumns: aggregateOnly,
			}
			s.shadowEvaluate(r.Clone(context.Background()), dialect, schema, question, upstreamModel, cfg.ShadowModels, shadowOpts)
		}
		finalize(previewContent(question, validation.SQL, note, validation), validation, false, 0, "", totalCost)
		return
	}

	// 4) Execute mode: run the validated SELECT read-only.
	cols, rows, rowCount, risk, execErr := s.execText2SQL(r.Context(), validation.SQL)
	logRec.ExplainCost = risk.Cost
	logRec.ExplainRisk = risk.Score
	if execErr != nil {
		finalize("SQL 실행 실패: "+execErr.Error()+"\n\n```sql\n"+validation.SQL+"\n```", validation, false, 0, execErr.Error(), totalCost)
		return
	}
	if cfg.MaskResults {
		// Column-policy masking: when the schema marks specific columns as
		// sensitivity=mask, mask only those result columns (matched by name). With no
		// such columns declared, fall back to masking every cell (the prior behavior).
		maskByName := map[string]bool{}
		for _, c := range maskColumns {
			maskByName[strings.ToLower(c)] = true
		}
		if len(maskByName) > 0 {
			maskCol := make([]bool, len(cols))
			for j, name := range cols {
				if maskByName[strings.ToLower(name)] {
					maskCol[j] = true
				}
			}
			for i := range rows {
				for j := range rows[i] {
					if j < len(maskCol) && maskCol[j] {
						rows[i][j] = maskText2SQLCell(rows[i][j])
					}
				}
			}
		} else {
			for i := range rows {
				for j := range rows[i] {
						rows[i][j] = maskSecretText(rows[i][j])
				}
			}
		}
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

	content := executeContent(question, validation.SQL, table, rowCount, summary, validation)
	finalize(content, validation, true, rowCount, "", totalCost)
}

// applyPermissionEffect overlays the permission matrix onto the catalog-derived
// allowlist/blocklist: deny removes tables and adds blocked columns; allow removes
// a column from the blocked set (granting access to an otherwise-sensitive column).
func applyPermissionEffect(allowedTables []string, blocked *[]string, eff store.Text2SQLPermissionEffect) []string {
	denyAll := false
	deniedT := map[string]bool{}
	for _, t := range eff.DeniedTables {
		if t == "*" {
			denyAll = true
		}
		deniedT[t] = true
	}
	if denyAll {
		allowedTables = []string{} // schema-wide deny → nothing allowed
	} else if len(deniedT) > 0 {
		kept := allowedTables[:0]
		for _, t := range allowedTables {
			if !deniedT[strings.ToLower(t)] {
				kept = append(kept, t)
			}
		}
		allowedTables = kept
	}
	// Add denied columns to the blocked set.
	*blocked = append(*blocked, eff.DeniedColumns...)
	// Remove explicitly-allowed columns from the blocked set.
	if len(eff.AllowedColumns) > 0 {
		allow := map[string]bool{}
		for _, c := range eff.AllowedColumns {
			allow[strings.ToLower(c)] = true
		}
		kept := (*blocked)[:0]
		for _, c := range *blocked {
			if !allow[strings.ToLower(c)] {
				kept = append(kept, c)
			}
		}
		*blocked = kept
	}
	return allowedTables
}

// shouldShadowSample decides, deterministically per question, whether to shadow-eval
// this request — so the same question is consistently sampled or not, and there is no
// shared RNG state. rate<=0 disables, rate>=1 always samples.
func shouldShadowSample(question string, rate float64) bool {
	if rate <= 0 {
		return false
	}
	if rate >= 1 {
		return true
	}
	h := sha256.Sum256([]byte(question))
	return float64(h[0])/255.0 < rate
}

// shadowEvaluate regenerates SQL for the same question with each candidate model in the
// background and records the outcome as a shadow log (mode="shadow"), which feeds the
// per-model quality metrics without affecting the live query KPIs. Runs in its own
// goroutine with a detached context; the cloned request carries headers for routing.
func (s *Server) shadowEvaluate(rc *http.Request, dialect, schema, question, primaryModel string, candidates []string, opts text2sql.ValidateOptions) {
	go func() {
		for _, model := range candidates {
			model = strings.TrimSpace(model)
			if model == "" || model == primaryModel {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			started := time.Now()
			msgs := text2sql.MessagesJSON(text2sql.BuildGenerationMessages(dialect, schema, question, opts.DefaultLimit))
			gen := s.runGovernanceChat(ctx, rc, model, msgs)
			genSQL := text2sql.ExtractSQL(gen.Response)
			validation := text2sql.ValidateSQL(genSQL, opts)
			_ = s.db.InsertText2SQLLog(ctx, store.Text2SQLQueryLog{
				ID: newID("t2ssh"), VirtualModel: "vibe/text2sql-shadow", UpstreamModel: model, Mode: "shadow",
				Question: question, GeneratedSQL: genSQL, Valid: validation.OK, RejectReason: validation.Reason,
				Error: gen.Error, CostKRW: gen.CostKRW, LatencyMS: time.Since(started).Milliseconds(), CreatedAt: time.Now().UTC(),
			})
			cancel()
		}
	}()
}

// maskText2SQLCell fully masks a result cell from a column declared sensitivity=mask.
// Unlike the heuristic secret scrubber, this masks the whole value (the column itself
// is the policy), while preserving an empty cell as empty and keeping a short hint of
// length so the result stays readable.
func maskText2SQLCell(v string) string {
	if v == "" {
		return ""
	}
	return "***"
}

// shortHash returns a stable 16-hex-char fingerprint of a string, used to snapshot
// the permission/glossary state into a log row and the cache key. Empty input maps
// to "" so an absent glossary doesn't shift the key.
func shortHash(s string) string {
	if s == "" {
		return ""
	}
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:8])
}

// sortedCopy returns a sorted copy of a slice without mutating the input (the input
// slices back the live allowlist/blocklist, which must stay in their original order).
func sortedCopy(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

// chooseUpstreamByQuality upgrades a complexity-chosen base model to the accurate
// model when the base has a meaningful sample size but a low SQL-validity rate.
func chooseUpstreamByQuality(base, accurate string, m store.Text2SQLModelMetric) string {
	if accurate != "" && accurate != base && m.Total >= 10 && m.ValidRate < 0.7 {
		return accurate
	}
	return base
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

// previewContent renders a business-friendly preview response: interpretation,
// the generated SQL, cautions, executability, and follow-up suggestions.
func previewContent(question, sql, note string, v text2sql.ValidationResult) string {
	var b strings.Builder
	b.WriteString("### 해석\n" + question + "\n\n")
	b.WriteString("### 생성 SQL\n```sql\n" + sql + "\n```\n\n")
	b.WriteString("### 주의사항\n")
	cautions := []string{}
	if v.LimitAdded {
		cautions = append(cautions, "결과 보호를 위해 LIMIT 이 자동 추가되었습니다.")
	}
	if len(v.Tables) > 0 {
		cautions = append(cautions, "참조 테이블: "+strings.Join(v.Tables, ", "))
	}
	cautions = append(cautions, note)
	for _, c := range cautions {
		b.WriteString("- " + c + "\n")
	}
	b.WriteString("\n### 실행 가능 여부\n- 검증 통과(읽기 전용). 이 모드는 SQL 만 생성하고 실행하지 않습니다. 실행하려면 `vibe/text2sql-execute` 를 사용하세요.\n\n")
	b.WriteString("### 다음 질문 제안\n" + nextQuestionHints(v.Tables))
	return b.String()
}

func executeContent(question, sql, table string, rowCount int64, summary string, v text2sql.ValidationResult) string {
	var b strings.Builder
	b.WriteString("### 해석\n")
	if summary != "" {
		b.WriteString(summary + "\n\n")
	} else {
		b.WriteString(question + "\n\n")
	}
	b.WriteString(fmt.Sprintf("### 결과 (%d행)\n%s\n\n", rowCount, table))
	b.WriteString("### 생성 SQL\n```sql\n" + sql + "\n```\n\n")
	b.WriteString("### 주의사항\n")
	if v.LimitAdded {
		b.WriteString("- LIMIT 이 자동 적용되어 일부 행만 표시될 수 있습니다.\n")
	}
	b.WriteString("- 결과의 민감 컬럼은 마스킹될 수 있습니다.\n\n")
	b.WriteString("### 실행 가능 여부\n- 읽기 전용으로 실행 완료.\n\n")
	b.WriteString("### 다음 질문 제안\n" + nextQuestionHints(v.Tables))
	return b.String()
}

// nextQuestionHints offers lightweight follow-up suggestions derived from the
// referenced tables (no extra LLM call).
func nextQuestionHints(tables []string) string {
	if len(tables) == 0 {
		return "- 기간/그룹 기준을 바꿔 다시 질문해 보세요 (예: 월별, 팀별)."
	}
	t := tables[0]
	return "- " + t + " 를 기간별(월/주)로 집계해 보세요.\n- " + t + " 를 다른 차원(부서/상태)으로 분해해 보세요."
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

// text2sqlEvaluations emits quality signals for a Text2SQL request into the shared
// llm_evaluations pipeline: SQL validity (and the rejection reason) plus, for
// execute mode, whether the query actually ran.
func text2sqlEvaluations(requestID, traceID string, v text2sql.ValidationResult, executed bool, errMsg string) []store.LLMEvaluation {
	now := time.Now().UTC()
	score := 0.0
	label := "rejected"
	if v.OK {
		score, label = 1, "valid"
	}
	evals := []store.LLMEvaluation{{
		ID: newID("eval"), RequestID: requestID, TraceID: traceID, Name: "text2sql.sql_valid",
		Category: "text2sql", Evaluator: "gateway", Score: score, Passed: v.OK, Label: label,
		Reason: v.Reason, CreatedAt: now,
	}}
	if v.OK {
		execScore := 0.0
		if executed {
			execScore = 1
		}
		evals = append(evals, store.LLMEvaluation{
			ID: newID("eval"), RequestID: requestID, TraceID: traceID, Name: "text2sql.executed",
			Category: "text2sql", Evaluator: "gateway", Score: execScore, Passed: executed,
			Label: map[bool]string{true: "executed", false: "not_executed"}[executed], Reason: errMsg, CreatedAt: now,
		})
	}
	return evals
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

// execText2SQL opens (lazily) the read-only execute DB, scores the plan, and runs
// the validated query. The returned explainRisk is recorded even when the query is
// allowed (risk < 50).
func (s *Server) execText2SQL(ctx context.Context, query string) ([]string, [][]string, int64, explainRisk, error) {
	db, err := s.text2sqlExecDB()
	if err != nil {
		return nil, nil, 0, explainRisk{}, err
	}
	rowLimit := s.cfg.Text2SQL.MaxLimit
	if rowLimit <= 0 {
		rowLimit = 1000
	}
	driver := strings.ToLower(strings.TrimSpace(s.cfg.Text2SQL.ExecDriver))
	var risk explainRisk
	// EXPLAIN risk guard (PostgreSQL): score the plan (cost + seq-scan/nested-loop on
	// large row estimates) and reject high-risk plans before running the query.
	if s.cfg.Text2SQL.MaxExplainCost > 0 && (driver == "postgres" || driver == "postgresql" || driver == "pgx") {
		if plan, err := explainPlanFor(ctx, db, query); err == nil {
			risk = scoreExplainPlan(plan, s.cfg.Text2SQL.MaxExplainCost)
			if risk.Score >= 50 {
				return nil, nil, 0, risk, fmt.Errorf("EXPLAIN risk %d/100: %s", risk.Score, strings.Join(risk.Reasons, "; "))
			}
		}
	}
	cols, rows, count, err := executeReadOnlyQuery(ctx, db, driver, query, rowLimit, s.cfg.Text2SQL.StatementTimeout, s.cfg.Text2SQL.WorkMem)
	return cols, rows, count, risk, err
}

// classifyText2SQLFailure maps a request outcome to a standard failure category for
// operational analysis. Returns "" on success.
func classifyText2SQLFailure(v text2sql.ValidationResult, executed bool, rowCount int64, errMsg string) string {
	if !v.OK {
		reason := strings.ToLower(v.Reason)
		switch {
		case strings.Contains(reason, "not allowed"), strings.Contains(reason, "sensitive"):
			return "permission_denied"
		case strings.Contains(reason, "upstream"):
			return "generation_error"
		case strings.Contains(reason, "empty"):
			return "empty_generation"
		default: // SELECT-only, forbidden keyword, stacked, dangerous, etc.
			return "syntax_error"
		}
	}
	if errMsg != "" {
		lower := strings.ToLower(errMsg)
		switch {
		case strings.Contains(lower, "explain risk"), strings.Contains(lower, "cost"):
			return "cost_exceeded"
		case strings.Contains(lower, "timeout"), strings.Contains(lower, "deadline"):
			return "timeout"
		case strings.Contains(lower, "column"), strings.Contains(lower, "does not exist"), strings.Contains(lower, "no such"):
			return "unknown_column"
		default:
			return "execution_error"
		}
	}
	if executed && rowCount == 0 {
		return "empty_result"
	}
	return ""
}

// explainPlanFor runs EXPLAIN (FORMAT JSON) and parses the plan tree.
func explainPlanFor(ctx context.Context, db *sql.DB, query string) (explainPlan, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var raw string
	if err := db.QueryRowContext(ctx, "EXPLAIN (FORMAT JSON) "+query).Scan(&raw); err != nil {
		return explainPlan{}, err
	}
	return parseExplainPlan([]byte(raw))
}

// handleText2SQLHealthcheck probes the Text2SQL execute database: connectivity, that
// the read-only transaction sandbox works, whether the connecting account itself is
// write-restricted (defense in depth), and that a statement timeout can be applied.
// GET /admin/text2sql/healthcheck
func (s *Server) handleText2SQLHealthcheck(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	cfg := s.cfg.Text2SQL
	out := map[string]any{
		"configured":        cfg.ExecDSN != "",
		"driver":            cfg.ExecDriver,
		"statement_timeout": cfg.StatementTimeout.String(),
	}
	if cfg.ExecDSN == "" {
		out["status"] = "preview_only"
		out["detail"] = "TEXT2SQL_EXEC_DSN 미설정 — preview 전용 (실행 비활성)"
		writeJSON(w, http.StatusOK, out)
		return
	}
	db, err := s.text2sqlExecDB()
	if err != nil {
		out["status"] = "error"
		out["reachable"] = false
		out["detail"] = "DB open 실패: " + err.Error()
		writeJSON(w, http.StatusOK, out)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		out["status"] = "error"
		out["reachable"] = false
		out["detail"] = "ping 실패: " + err.Error()
		writeJSON(w, http.StatusOK, out)
		return
	}
	out["reachable"] = true

	driver := strings.ToLower(strings.TrimSpace(cfg.ExecDriver))
	isPG := driver == "postgres" || driver == "postgresql" || driver == "pgx"
	readOnlyTxOK := true
	timeoutOK := true
	accountReadOnly := false
	accountChecked := false
	if isPG {
		// Read-only tx + statement_timeout: confirms the sandbox we run queries in.
		if tx, terr := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true}); terr == nil {
			if _, e := tx.ExecContext(ctx, "SET LOCAL statement_timeout = 1000"); e != nil {
				timeoutOK = false
			}
			var one int
			if e := tx.QueryRowContext(ctx, "SELECT 1").Scan(&one); e != nil || one != 1 {
				readOnlyTxOK = false
			}
			_ = tx.Rollback()
		} else {
			readOnlyTxOK = false
		}
		// Account-level write check (defense in depth): a write attempt that the
		// account rejects means the DSN is a properly restricted read-only role.
		accountChecked = true
		if tx, terr := db.BeginTx(ctx, &sql.TxOptions{}); terr == nil {
			_, e := tx.ExecContext(ctx, "CREATE TEMP TABLE _t2s_ro_probe (x int)")
			accountReadOnly = e != nil
			_ = tx.Rollback()
		}
	} else {
		var one int
		if e := db.QueryRowContext(ctx, "SELECT 1").Scan(&one); e != nil || one != 1 {
			readOnlyTxOK = false
		}
	}
	out["read_only_tx_ok"] = readOnlyTxOK
	out["statement_timeout_ok"] = timeoutOK
	if accountChecked {
		out["account_write_restricted"] = accountReadOnly
	}
	switch {
	case !readOnlyTxOK:
		out["status"] = "error"
		out["detail"] = "read-only 트랜잭션 프로브 실패"
	case isPG && !accountReadOnly:
		out["status"] = "warn"
		out["detail"] = "연결 계정이 쓰기 가능 — 읽기 전용 역할 사용 권장 (트랜잭션 샌드박스는 동작)"
	default:
		out["status"] = "ok"
		out["detail"] = "실행 DB 정상 (read-only 샌드박스 동작)"
	}
	writeJSON(w, http.StatusOK, out)
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
// been validated as a single read-only statement. For PostgreSQL it runs inside a
// READ ONLY transaction with a per-statement timeout and optional work_mem cap
// (sandbox), so a heavy or accidentally-mutating query can't harm the source DB.
func executeReadOnlyQuery(ctx context.Context, db *sql.DB, driver, query string, rowLimit int, stmtTimeout time.Duration, workMem string) ([]string, [][]string, int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	driver = strings.ToLower(strings.TrimSpace(driver))
	var rows *sql.Rows
	var err error
	if driver == "postgres" || driver == "postgresql" || driver == "pgx" {
		tx, terr := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
		if terr != nil {
			return nil, nil, 0, terr
		}
		defer tx.Rollback()
		if stmtTimeout > 0 {
			_, _ = tx.ExecContext(ctx, fmt.Sprintf("SET LOCAL statement_timeout = %d", stmtTimeout.Milliseconds()))
		}
		if workMem != "" {
			_, _ = tx.ExecContext(ctx, "SET LOCAL work_mem = '"+strings.ReplaceAll(workMem, "'", "")+"'")
		}
		rows, err = tx.QueryContext(ctx, query)
	} else {
		rows, err = db.QueryContext(ctx, query)
	}
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
