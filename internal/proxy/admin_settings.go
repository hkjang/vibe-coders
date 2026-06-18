package proxy

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// openTransientSQLDB opens a short-lived DB connection (for connection tests), applying the
// same driver normalization as the Text2SQL execute/twin DBs.
func openTransientSQLDB(dsn, driver string) (*sql.DB, string, error) {
	d := strings.ToLower(strings.TrimSpace(driver))
	if d == "postgres" || d == "postgresql" {
		d = "pgx"
	}
	if d == "" {
		d = "sqlite"
	}
	db, err := sql.Open(d, dsn)
	if err != nil {
		return nil, d, err
	}
	db.SetMaxOpenConns(2)
	return db, d, nil
}

// settingType describes how a setting's string value is parsed/validated.
type settingType string

const (
	stString   settingType = "string"
	stInt      settingType = "int"
	stBool     settingType = "bool"
	stFloat    settingType = "float"
	stDuration settingType = "duration"
	stCSV      settingType = "csv"
)

// settingDef is a registry entry: the env/default source, type, category, and whether the
// value is a secret (encrypted at rest, masked in responses). validate is optional.
// ReadOnly=true entries are shown in the UI as view-only (no save/revert) and reject PUT via API.
type settingDef struct {
	Key      string
	Category string
	Type     settingType
	Secret   bool
	Restart  bool     // changing this requires a worker restart / connection swap (informational)
	ReadOnly bool     // env-only: shown for visibility but cannot be changed via admin settings
	envValue func(cfg config.Config) string
	validate func(string) error
}

// settingRegistry is the ordered set of admin-manageable settings. First slice: ClickHouse
// and Text2SQL (the spec's 1차 범위).
var settingRegistry = buildSettingRegistry()

func buildSettingRegistry() []settingDef {
	posInt := func(v string) error {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			return fmt.Errorf("must be a non-negative integer")
		}
		return nil
	}
	rate01 := func(v string) error {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || f < 0 || f > 1 {
			return fmt.Errorf("must be between 0 and 1")
		}
		return nil
	}
	nonNegFloat := func(v string) error {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || f < 0 {
			return fmt.Errorf("must be a non-negative number")
		}
		return nil
	}
	posFloat := func(v string) error {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || f <= 0 {
			return fmt.Errorf("must be a positive number")
		}
		return nil
	}
	dur := func(v string) error {
		if _, err := time.ParseDuration(v); err != nil {
			return fmt.Errorf("must be a duration (e.g. 15s, 1h)")
		}
		return nil
	}
	chIdent := func(v string) error {
		if !validCHIdentifier(v) {
			return fmt.Errorf("must be a valid ClickHouse identifier (letters, digits, underscore, optional db.table)")
		}
		return nil
	}
	return []settingDef{
		// ---- ClickHouse ----
		{Key: "clickhouse.url", Category: "clickhouse", Type: stString, Restart: true, envValue: func(c config.Config) string { return c.ClickHouse.URL }},
		{Key: "clickhouse.database", Category: "clickhouse", Type: stString, validate: chIdent, envValue: func(c config.Config) string { return c.ClickHouse.Database }},
		{Key: "clickhouse.table", Category: "clickhouse", Type: stString, validate: chIdent, envValue: func(c config.Config) string { return c.ClickHouse.Table }},
		{Key: "clickhouse.user", Category: "clickhouse", Type: stString, envValue: func(c config.Config) string { return c.ClickHouse.User }},
		{Key: "clickhouse.password", Category: "clickhouse", Type: stString, Secret: true, envValue: func(c config.Config) string { return c.ClickHouse.Password }},
		{Key: "clickhouse.sink_interval", Category: "clickhouse", Type: stDuration, Restart: true, validate: dur, envValue: func(c config.Config) string { return c.ClickHouse.SinkInterval.String() }},
		{Key: "clickhouse.sink_days", Category: "clickhouse", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.ClickHouse.SinkDays) }},
		{Key: "clickhouse.text2sql_fact_table", Category: "clickhouse", Type: stString, validate: chIdent, envValue: func(c config.Config) string { return c.ClickHouse.Text2SQLFactTable }},
		{Key: "clickhouse.request_fact_table", Category: "clickhouse", Type: stString, validate: chIdent, envValue: func(c config.Config) string { return c.ClickHouse.RequestFactTable }},
		{Key: "clickhouse.tool_fact_table", Category: "clickhouse", Type: stString, validate: chIdent, envValue: func(c config.Config) string { return c.ClickHouse.ToolFactTable }},
		{Key: "clickhouse.routing_fact_table", Category: "clickhouse", Type: stString, validate: chIdent, envValue: func(c config.Config) string { return c.ClickHouse.RoutingFactTable }},
		{Key: "clickhouse.eval_fact_table", Category: "clickhouse", Type: stString, validate: chIdent, envValue: func(c config.Config) string { return c.ClickHouse.EvalFactTable }},
		{Key: "clickhouse.feedback_fact_table", Category: "clickhouse", Type: stString, validate: chIdent, envValue: func(c config.Config) string { return c.ClickHouse.FeedbackFactTable }},
		{Key: "clickhouse.policy_fact_table", Category: "clickhouse", Type: stString, validate: chIdent, envValue: func(c config.Config) string { return c.ClickHouse.PolicyFactTable }},
		{Key: "clickhouse.skill_fact_table", Category: "clickhouse", Type: stString, validate: chIdent, envValue: func(c config.Config) string { return c.ClickHouse.SkillFactTable }},
		{Key: "clickhouse.batch_size", Category: "clickhouse", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.ClickHouse.BatchSize) }},
		{Key: "clickhouse.flush_interval", Category: "clickhouse", Type: stDuration, validate: dur, envValue: func(c config.Config) string { return c.ClickHouse.FlushInterval.String() }},

		// ---- Text2SQL ----
		{Key: "text2sql.enabled", Category: "text2sql", Type: stBool, envValue: func(c config.Config) string { return strconv.FormatBool(c.Text2SQL.Enabled) }},
		{Key: "text2sql.preview_model", Category: "text2sql.models", Type: stString, envValue: func(c config.Config) string { return c.Text2SQL.PreviewModel }},
		{Key: "text2sql.execute_model", Category: "text2sql.models", Type: stString, envValue: func(c config.Config) string { return c.Text2SQL.ExecuteModel }},
		{Key: "text2sql.accurate_model", Category: "text2sql.models", Type: stString, envValue: func(c config.Config) string { return c.Text2SQL.AccurateModel }},
		{Key: "text2sql.local_model", Category: "text2sql.models", Type: stString, envValue: func(c config.Config) string { return c.Text2SQL.LocalModel }},
		{Key: "text2sql.summary_model", Category: "text2sql.models", Type: stString, envValue: func(c config.Config) string { return c.Text2SQL.SummaryModel }},
		{Key: "text2sql.dialect", Category: "text2sql", Type: stString, envValue: func(c config.Config) string { return c.Text2SQL.Dialect }},
		{Key: "text2sql.default_limit", Category: "text2sql.safety", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.Text2SQL.DefaultLimit) }},
		{Key: "text2sql.max_limit", Category: "text2sql.safety", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.Text2SQL.MaxLimit) }},
		{Key: "text2sql.max_explain_cost", Category: "text2sql.safety", Type: stFloat, envValue: func(c config.Config) string { return strconv.FormatFloat(c.Text2SQL.MaxExplainCost, 'f', -1, 64) }},
		{Key: "text2sql.mask_results", Category: "text2sql.safety", Type: stBool, envValue: func(c config.Config) string { return strconv.FormatBool(c.Text2SQL.MaskResults) }},
		{Key: "text2sql.exec_driver", Category: "text2sql", Type: stString, Restart: true, envValue: func(c config.Config) string { return c.Text2SQL.ExecDriver }},
		{Key: "text2sql.exec_dsn", Category: "text2sql", Type: stString, Secret: true, Restart: true, envValue: func(c config.Config) string { return c.Text2SQL.ExecDSN }},
		{Key: "text2sql.cache_enabled", Category: "text2sql", Type: stBool, envValue: func(c config.Config) string { return strconv.FormatBool(c.Text2SQL.CacheEnabled) }},
		{Key: "text2sql.cache_ttl", Category: "text2sql", Type: stDuration, validate: dur, envValue: func(c config.Config) string { return c.Text2SQL.CacheTTL.String() }},
		{Key: "text2sql.clarify_enabled", Category: "text2sql", Type: stBool, envValue: func(c config.Config) string { return strconv.FormatBool(c.Text2SQL.ClarifyEnabled) }},
		{Key: "text2sql.require_date_filter", Category: "text2sql", Type: stBool, envValue: func(c config.Config) string { return strconv.FormatBool(c.Text2SQL.RequireDateFilter) }},
		{Key: "text2sql.statement_timeout", Category: "text2sql.safety", Type: stDuration, validate: dur, envValue: func(c config.Config) string { return c.Text2SQL.StatementTimeout.String() }},
		{Key: "text2sql.work_mem", Category: "text2sql.safety", Type: stString, envValue: func(c config.Config) string { return c.Text2SQL.WorkMem }},
		{Key: "text2sql.shadow_models", Category: "text2sql.eval", Type: stCSV, envValue: func(c config.Config) string { return strings.Join(c.Text2SQL.ShadowModels, ",") }},
		{Key: "text2sql.shadow_sample_rate", Category: "text2sql.eval", Type: stFloat, validate: rate01, envValue: func(c config.Config) string { return strconv.FormatFloat(c.Text2SQL.ShadowSampleRate, 'f', -1, 64) }},
		{Key: "text2sql.replay_bundles", Category: "text2sql", Type: stBool, envValue: func(c config.Config) string { return strconv.FormatBool(c.Text2SQL.ReplayBundles) }},
		{Key: "text2sql.daily_risk_limit", Category: "text2sql.safety", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.Text2SQL.DailyRiskLimit) }},
		{Key: "text2sql.daily_risk_warn", Category: "text2sql.safety", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.Text2SQL.DailyRiskWarn) }},
		{Key: "text2sql.twin_driver", Category: "text2sql", Type: stString, Restart: true, envValue: func(c config.Config) string { return c.Text2SQL.TwinDriver }},
		{Key: "text2sql.twin_dsn", Category: "text2sql", Type: stString, Secret: true, Restart: true, envValue: func(c config.Config) string { return c.Text2SQL.TwinDSN }},

		// ---- Carbon (Prompt Carbon Score coefficients) ----
		{Key: "carbon.wh_per_1k_tokens", Category: "carbon", Type: stFloat, validate: nonNegFloat, envValue: func(c config.Config) string { return strconv.FormatFloat(c.Carbon.WhPer1KTokens, 'f', -1, 64) }},
		{Key: "carbon.pue", Category: "carbon", Type: stFloat, validate: nonNegFloat, envValue: func(c config.Config) string { return strconv.FormatFloat(c.Carbon.PUE, 'f', -1, 64) }},
		{Key: "carbon.grid_intensity_g", Category: "carbon", Type: stFloat, validate: nonNegFloat, envValue: func(c config.Config) string { return strconv.FormatFloat(c.Carbon.GridIntensityG, 'f', -1, 64) }},

		// ---- Insurance (AI request SLA) ----
		{Key: "insurance.sla_target", Category: "insurance", Type: stFloat, validate: rate01, envValue: func(c config.Config) string { return strconv.FormatFloat(c.Insurance.SLATarget, 'f', -1, 64) }},
		{Key: "insurance.fast_burn", Category: "insurance", Type: stFloat, validate: posFloat, envValue: func(c config.Config) string { return strconv.FormatFloat(c.Insurance.FastBurnThreshold, 'f', -1, 64) }},
		{Key: "insurance.slow_burn", Category: "insurance", Type: stFloat, validate: posFloat, envValue: func(c config.Config) string { return strconv.FormatFloat(c.Insurance.SlowBurnThreshold, 'f', -1, 64) }},

		// ---- Cache ----
		{Key: "cache.embedding_enabled", Category: "cache", Type: stBool, envValue: func(c config.Config) string { return strconv.FormatBool(c.Cache.EmbeddingEnabled) }},
		{Key: "cache.embedding_ttl", Category: "cache", Type: stDuration, validate: dur, envValue: func(c config.Config) string { return c.Cache.EmbeddingTTL.String() }},
		{Key: "cache.embedding_max_bytes", Category: "cache", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.Cache.EmbeddingMaxBytes) }},
		{Key: "cache.chat_enabled", Category: "cache", Type: stBool, envValue: func(c config.Config) string { return strconv.FormatBool(c.Cache.ChatEnabled) }},
		{Key: "cache.chat_ttl", Category: "cache", Type: stDuration, validate: dur, envValue: func(c config.Config) string { return c.Cache.ChatTTL.String() }},
		{Key: "cache.chat_semantic_enabled", Category: "cache", Type: stBool, envValue: func(c config.Config) string { return strconv.FormatBool(c.Cache.ChatSemanticEnabled) }},
		{Key: "cache.chat_semantic_model", Category: "cache", Type: stString, envValue: func(c config.Config) string { return c.Cache.ChatSemanticModel }},
		{Key: "cache.chat_semantic_threshold", Category: "cache", Type: stFloat, validate: rate01, envValue: func(c config.Config) string { return strconv.FormatFloat(c.Cache.ChatSemanticThreshold, 'f', -1, 64) }},
		{Key: "cache.chat_semantic_max_candidates", Category: "cache", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.Cache.ChatSemanticMaxCandidates) }},
		{Key: "cache.chat_semantic_multiturn", Category: "cache", Type: stBool, envValue: func(c config.Config) string { return strconv.FormatBool(c.Cache.ChatSemanticMultiTurn) }},
		{Key: "cache.embedding_provider", Category: "cache", Type: stString, envValue: func(c config.Config) string { return c.Cache.EmbeddingProvider }},
		{Key: "cache.embedding_base_url", Category: "cache", Type: stString, envValue: func(c config.Config) string { return c.Cache.EmbeddingBaseURL }},
		{Key: "cache.embedding_api_key", Category: "cache", Type: stString, Secret: true, envValue: func(c config.Config) string { return c.Cache.EmbeddingAPIKey }},

		// ---- Retention ----
		{Key: "retention.request_days", Category: "retention", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.Retention.RequestDays) }},
		{Key: "retention.prompt_days", Category: "retention", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.Retention.PromptDays) }},
		{Key: "retention.response_days", Category: "retention", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.Retention.ResponseDays) }},
		{Key: "retention.text2sql_replay_days", Category: "retention", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.Retention.Text2SQLReplayDays) }},
		{Key: "retention.interval", Category: "retention", Type: stDuration, Restart: true, validate: dur, envValue: func(c config.Config) string { return c.Retention.Interval.String() }},

		// ---- Pricing ----
		{Key: "pricing.fallback_model", Category: "pricing", Type: stString, envValue: func(c config.Config) string { return c.PricingConf.FallbackModel }},
		{Key: "pricing.usd_krw", Category: "pricing", Type: stFloat, validate: posFloat, envValue: func(c config.Config) string { return strconv.FormatFloat(c.PricingConf.USDToKRW, 'f', -1, 64) }},

		// ---- Skills (policy enforcement) ----
		{Key: "skills.enforcement", Category: "skills", Type: stString, validate: skillEnforceMode, envValue: func(c config.Config) string { return c.Skills.Enforcement }},

		// ---- Limits (request guardrails) ----
		{Key: "limits.max_output_tokens", Category: "limits", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.Limits.MaxOutputTokens) }},
		{Key: "limits.max_request_bytes", Category: "limits", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.Limits.MaxRequestBytes) }},
		{Key: "limits.max_messages", Category: "limits", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.Limits.MaxMessages) }},

		// ---- Logging (runtime-adjustable capture flags) ----
		{Key: "logging.response_text", Category: "logging", Type: stBool, envValue: func(c config.Config) string { return strconv.FormatBool(c.Logging.ResponseText) }},
		{Key: "logging.raw_prompts", Category: "logging", Type: stBool, envValue: func(c config.Config) string { return strconv.FormatBool(c.Logging.RawPrompts) }},
		{Key: "logging.raw_bodies", Category: "logging", Type: stBool, envValue: func(c config.Config) string { return strconv.FormatBool(c.Logging.RawBodies) }},
		{Key: "logging.response_max_bytes", Category: "logging", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.Logging.ResponseMaxBytes) }},

		// ---- Env (read-only view of startup environment variables) ----
		{Key: "env.upstream_base_url", Category: "env", Type: stString, ReadOnly: true, envValue: func(c config.Config) string { return c.Upstream.BaseURL }},
		{Key: "env.upstream_provider", Category: "env", Type: stString, ReadOnly: true, envValue: func(c config.Config) string { return c.Upstream.Provider }},
		{Key: "env.upstream_api_key", Category: "env", Type: stString, Secret: true, ReadOnly: true, envValue: func(c config.Config) string { return c.Upstream.APIKey }},
		{Key: "env.listen_addr", Category: "env", Type: stString, ReadOnly: true, envValue: func(c config.Config) string { return c.ListenAddr }},
		{Key: "env.log_queue_size", Category: "env", Type: stInt, ReadOnly: true, envValue: func(c config.Config) string { return strconv.Itoa(c.Logging.QueueSize) }},
		{Key: "env.log_fallback_path", Category: "env", Type: stString, ReadOnly: true, envValue: func(c config.Config) string { return c.Logging.FallbackPath }},
	}
}

// skillEnforceMode validates the Skill enforcement mode setting.
func skillEnforceMode(v string) error {
	switch strings.TrimSpace(strings.ToLower(v)) {
	case "off", "warn", "enforce", "":
		return nil
	}
	return fmt.Errorf("must be one of off|warn|enforce")
}

// settingDescriptions maps each setting key to a short Korean help string shown under the key
// in the admin UI. Kept separate from the registry so the registry stays terse.
var settingDescriptions = map[string]string{
	// ClickHouse
	"clickhouse.url":                 "ClickHouse HTTP 엔드포인트 URL. 비우면 DW 적재 비활성. 변경 시 sink 워커 재시작.",
	"clickhouse.database":            "적재 대상 데이터베이스 이름.",
	"clickhouse.table":               "일별 rollup 적재 테이블 이름.",
	"clickhouse.user":                "ClickHouse 접속 계정.",
	"clickhouse.password":            "ClickHouse 접속 비밀번호. 암호화 저장·마스킹.",
	"clickhouse.sink_interval":       "자동 적재 주기(예: 1h). 변경 시 sink 워커 재시작.",
	"clickhouse.sink_days":           "적재 시 조회할 최근 일수(증분 watermark 기준 백필 범위).",
	"clickhouse.text2sql_fact_table": "Text2SQL 질의 단위 fact 테이블 이름. 지정 시 질의별 상세 적재(질문 원문 제외).",
	"clickhouse.request_fact_table":  "요청 단위 fact 테이블 이름(예: ai_request_fact). 지정 시 모든 요청을 1행씩 비동기 배치 적재(프롬프트 원문 제외, IP는 해시).",
	"clickhouse.tool_fact_table":     "도구/MCP 호출 fact 테이블 이름(예: ai_tool_fact). 지정 시 호출 1건당 1행 적재(server/tool/source/error/arg_hash).",
	"clickhouse.routing_fact_table":  "라우팅 결정 fact 테이블 이름(예: ai_routing_fact). 요청당 1행(요청/선택 모델·complexity·risk·health·fallback).",
	"clickhouse.eval_fact_table":     "LLM 평가 fact 테이블 이름(예: ai_eval_fact). 평가 1건당 1행(name/category/score/passed).",
	"clickhouse.feedback_fact_table": "사람 피드백 fact 테이블 이름(예: ai_feedback_fact). 피드백 1건당 1행(rating/label/source/created_by). 직접 best-effort 적재.",
	"clickhouse.policy_fact_table":   "거버넌스 정책 결정 fact 테이블 이름(예: ai_policy_fact). 결정 1건당 1행(phase/policy/rule/decision/risk). best-effort 적재.",
	"clickhouse.skill_fact_table":    "Skill 실행 fact 테이블 이름(예: ai_skill_fact). Skill 실행 1건당 1행(skill/version/actor/model/status/cost/latency). best-effort 적재.",
	"clickhouse.batch_size":          "요청 fact 배치 적재 시 1회 INSERT 행 수(기본 200).",
	"clickhouse.flush_interval":      "요청 fact 큐가 배치 미달이어도 강제 flush하는 주기(예: 5s).",
	// Text2SQL
	"text2sql.enabled":             "Text2SQL 가상 모델(자연어→읽기전용 SQL) 기능 전체 on/off.",
	"text2sql.preview_model":       "preview(미실행 SQL 생성) 모드에 사용할 업스트림 모델.",
	"text2sql.execute_model":       "execute(실행 포함) 모드의 SQL 생성 모델.",
	"text2sql.accurate_model":      "정확도 우선 승격 시 사용할 모델(기본 모델 유효율 저하 시).",
	"text2sql.local_model":         "로컬/저비용 경로용 모델.",
	"text2sql.summary_model":       "결과 요약·자연어 설명 생성 모델.",
	"text2sql.dialect":             "생성 SQL 방언(예: PostgreSQL, MySQL).",
	"text2sql.default_limit":       "SQL에 자동 주입할 기본 LIMIT 행 수.",
	"text2sql.max_limit":           "허용 최대 LIMIT(초과 시 강제 축소). default_limit ≤ max_limit 이어야 함.",
	"text2sql.max_explain_cost":    "EXPLAIN 추정 비용 상한. 초과 시 위험 처리(차단/경고).",
	"text2sql.mask_results":        "실행 결과의 민감 컬럼 마스킹 여부.",
	"text2sql.exec_driver":         "실행 DB 드라이버(postgres/mysql/sqlite). 변경 시 커넥션 재오픈.",
	"text2sql.exec_dsn":            "실행 DB 접속 DSN. read-only 계정 권장. 암호화 저장·마스킹, 변경 시 재오픈.",
	"text2sql.cache_enabled":       "preview 결과 캐시 사용 여부.",
	"text2sql.cache_ttl":           "preview 캐시 보존 시간(예: 10m).",
	"text2sql.clarify_enabled":     "모호한 질문에 재질문(clarification) 게이트 사용.",
	"text2sql.require_date_filter": "기간 필터가 없는 질문을 차단/재질문.",
	"text2sql.statement_timeout":   "실행 SQL의 statement timeout(예: 15s).",
	"text2sql.work_mem":            "실행 세션 work_mem(예: 64MB).",
	"text2sql.shadow_models":       "shadow 평가용 후보 모델(CSV). 비동기 재생성으로 라이브 KPI 비오염.",
	"text2sql.shadow_sample_rate":  "shadow 평가 샘플 비율(0~1).",
	"text2sql.replay_bundles":      "질의 사후 재현용 Replay Bundle 저장 on/off.",
	"text2sql.daily_risk_limit":    "API Key 일일 위험 요청 차단 한도(초과 시 SQL 생성 전 차단).",
	"text2sql.daily_risk_warn":     "일일 위험 요청 경고 임계값(차단 한도 미만 경고 구간).",
	"text2sql.twin_driver":         "Twin(마스킹·샘플) DB 드라이버. 변경 시 커넥션 재오픈.",
	"text2sql.twin_dsn":            "Twin DB DSN. 골든 결과 동등성 검증용. 암호화 저장·마스킹, 변경 시 재오픈.",
	// Carbon
	"carbon.wh_per_1k_tokens": "토큰 1K당 기본 전력(Wh). 탄소 점수 계산 계수.",
	"carbon.pue":              "데이터센터 PUE(전력 사용 효율). 전력 환산 배수.",
	"carbon.grid_intensity_g": "전력망 탄소 강도(gCO2e/kWh).",
	// Insurance
	"insurance.sla_target": "SLA 목표 성공률(0~1, 예: 0.99).",
	"insurance.fast_burn":  "fast burn 임계 배수(즉시 page 경보 기준).",
	"insurance.slow_burn":  "slow burn 임계 배수(ticket 경보 기준).",
	// Cache
	"cache.embedding_enabled":            "임베딩 응답 캐시 on/off.",
	"cache.embedding_ttl":                "임베딩 캐시 보존 시간.",
	"cache.embedding_max_bytes":          "임베딩 캐시 항목 최대 바이트.",
	"cache.chat_enabled":                 "chat 정확 캐시(temperature 0/seed 고정) on/off.",
	"cache.chat_ttl":                     "chat 캐시 보존 시간.",
	"cache.chat_semantic_enabled":        "의미(임베딩) 유사도 기반 chat 근사 캐시 on/off.",
	"cache.chat_semantic_model":          "시맨틱 캐시용 임베딩 모델.",
	"cache.chat_semantic_threshold":      "시맨틱 캐시 적중 코사인 유사도 임계값(0~1).",
	"cache.chat_semantic_max_candidates": "시맨틱 비교 후보 최대 개수.",
	"cache.chat_semantic_multiturn":      "멀티턴/툴 요청도 임베딩할지 여부. 기본 off(단발성 요청만) — 멀티턴은 적중률이 낮고 잘못 적중 위험이 있어 임베딩 호출을 생략.",
	"cache.embedding_provider":           "임베딩 호출에 강제할 프로바이더 이름. 비우면 기존 라우팅(모델 glob→기본 업스트림) 사용.",
	"cache.embedding_base_url":           "임베딩 전용 엔드포인트 base URL(예: 사내 임베딩 서버). 설정 시 {base_url}/v1/embeddings로 직접 호출. 비우면 프로바이더 라우팅 사용.",
	"cache.embedding_api_key":            "임베딩 base URL용 인증 키. 암호화 저장·마스킹. 비우면 기본 업스트림 키로 폴백(또는 무인증).",
	// Retention
	"retention.request_days":         "요청 로그 보존 일수.",
	"retention.prompt_days":          "프롬프트 본문 보존 일수.",
	"retention.response_days":        "응답 본문 보존 일수.",
	"retention.text2sql_replay_days": "Text2SQL Replay Bundle 보존 일수.",
	"retention.interval":             "보존 정리 워커 실행 주기(예: 6h). 변경 시 ticker 재생성.",
	// Pricing
	"pricing.fallback_model": "가격표에 매칭되지 않는 모델의 비용을 계산할 기준 모델(기본 qwen-plus). 해당 모델이 가격표에 있어야 적용, 없으면 0 처리.",
	"pricing.usd_krw":        "가격 카탈로그 시드 시 USD→KRW 환율(기본 1380). 변경 후 /admin/pricing/seed?overwrite=1로 재적용.",
	// Skills
	"skills.enforcement": "Skill 정책(allowed_models/allowed_tools) 적용 모드. off=비활성, warn=위반 시 헤더 경고만(기본), enforce=위반 시 요청 차단(403). 요청은 X-Vibe-Skill 헤더로 Skill을 지정해야 검사됨.",
	// Limits
	"limits.max_output_tokens": "응답 최대 출력 토큰 상한(0=비활성). >0이면 chat 요청의 max_tokens/max_completion_tokens를 이 값으로 클램프(없으면 주입). 런어웨이 생성·비용 폭주 가드.",
	"limits.max_request_bytes": "chat 요청 본문 최대 바이트(0=비활성). 초과 시 413 payload_too_large로 거부. 비정상적으로 큰 프롬프트·남용 차단.",
	"limits.max_messages":      "chat 요청 messages 배열 최대 개수(0=비활성). 초과 시 400 too_many_messages로 거부. 컨텍스트 스터핑·과도한 멀티턴 누적 차단.",
	// Logging
	"logging.response_text":       "AI 응답 본문 캡처 여부(LOG_RESPONSE_TEXT). true면 response_text_optional에 전체 응답 텍스트를 저장, 요청 상세에서 조회 가능. 저장 공간 증가 주의.",
	"logging.raw_prompts":         "프롬프트 원문 캡처 여부(LOG_RAW_PROMPTS). true면 content_text(원문)도 별도 저장. false면 redacted_text(리덕션)만 보관.",
	"logging.raw_bodies":          "요청·응답 원시 바디 캡처 여부(LOG_RAW_BODIES). true면 raw_request/raw_response 컬럼에 전체 바이트 저장. 디버그 목적. 저장 공간 주의.",
	"logging.response_max_bytes":  "응답 캡처 최대 바이트(LOG_RESPONSE_MAX_BYTES). 초과 분 잘림. 기본 1MB.",
	// Env (read-only)
	"env.upstream_base_url":  "업스트림 엔드포인트 URL(UPSTREAM_BASE_URL). 변경하려면 컨테이너 환경변수를 수정 후 재시작.",
	"env.upstream_provider":  "업스트림 프로바이더 이름(UPSTREAM_PROVIDER). 변경하려면 환경변수 수정 후 재시작.",
	"env.upstream_api_key":   "업스트림 API 키(UPSTREAM_API_KEY). 마스킹 표시. 변경하려면 환경변수 수정 후 재시작.",
	"env.listen_addr":        "게이트웨이 수신 주소/포트(PORT or LISTEN_ADDR). 변경하려면 환경변수 수정 후 재시작.",
	"env.log_queue_size":     "비동기 로그 큐 크기(LOG_QUEUE_SIZE). 변경하려면 환경변수 수정 후 재시작.",
	"env.log_fallback_path":  "로그 큐 오버플로 시 fallback NDJSON 파일 경로(LOG_FALLBACK_PATH).",
}

// t2sConf returns the effective Text2SQL config (admin-settings overlay over env/default).
func (s *Server) t2sConf() config.Text2SQLConfig {
	if p := s.t2sRuntime.Load(); p != nil {
		return *p
	}
	return s.cfg.Text2SQL
}

// chConf returns the effective ClickHouse config (admin-settings overlay over env/default).
func (s *Server) chConf() config.ClickHouseConfig {
	if p := s.chRuntime.Load(); p != nil {
		return *p
	}
	return s.cfg.ClickHouse
}

// carbonConf returns the effective Carbon config (admin-settings overlay over env/default).
func (s *Server) carbonConf() config.CarbonConfig {
	if p := s.carbonRuntime.Load(); p != nil {
		return *p
	}
	return s.cfg.Carbon
}

// insuranceConf returns the effective Insurance config (admin-settings overlay over env/default).
func (s *Server) insuranceConf() config.InsuranceConfig {
	if p := s.insRuntime.Load(); p != nil {
		return *p
	}
	return s.cfg.Insurance
}

// cacheConf returns the effective Cache config (admin-settings overlay over env/default).
func (s *Server) cacheConf() config.CacheConfig {
	if p := s.cacheRuntime.Load(); p != nil {
		return *p
	}
	return s.cfg.Cache
}

// pricingConf returns the effective pricing policy (admin-settings overlay over env/default).
func (s *Server) pricingConf() config.PricingConfig {
	if p := s.pricingRuntime.Load(); p != nil {
		return *p
	}
	return s.cfg.PricingConf
}

// skillsConf returns the effective Skills config (admin-settings overlay over env/default).
func (s *Server) skillsConf() config.SkillsConfig {
	if p := s.skillsRuntime.Load(); p != nil {
		return *p
	}
	return s.cfg.Skills
}

// limitsConf returns the effective Limits config (admin-settings overlay over env/default).
func (s *Server) limitsConf() config.LimitsConfig {
	if p := s.limitsRuntime.Load(); p != nil {
		return *p
	}
	return s.cfg.Limits
}

// loggingConf returns the effective Logging config (admin-settings overlay over env/default).
func (s *Server) loggingConf() config.LoggingConfig {
	if p := s.loggingRuntime.Load(); p != nil {
		return *p
	}
	return s.cfg.Logging
}

// reloadRuntimeConfig rebuilds the Text2SQL/ClickHouse runtime snapshots from env defaults
// overlaid with admin-managed settings. Called at startup and after every settings change.
func (s *Server) reloadRuntimeConfig(ctx context.Context) {
	stored := map[string]store.AdminSetting{}
	if list, err := s.db.ListAdminSettings(ctx); err == nil {
		for _, a := range list {
			stored[a.Key] = a
		}
	}
	prevT2S := s.t2sConf()
	prevCH := s.chConf()
	prevRet := s.cfg.Retention
	if s.retention != nil {
		prevRet = s.retention.Config()
	}
	t2s := s.cfg.Text2SQL
	ch := s.cfg.ClickHouse
	carbon := s.cfg.Carbon
	ins := s.cfg.Insurance
	cache := s.cfg.Cache
	ret := s.cfg.Retention
	pricing := s.cfg.PricingConf
	skills := s.cfg.Skills
	limits := s.cfg.Limits
	logging := s.cfg.Logging
	for _, d := range settingRegistry {
		if d.ReadOnly {
			continue
		}
		if _, ok := stored[d.Key]; !ok {
			continue
		}
		val, source := s.effectiveSettingValue(stored, d)
		if source != "admin" {
			continue
		}
		applyRuntimeSetting(&t2s, &ch, &carbon, &ins, &cache, &ret, &pricing, &skills, &limits, &logging, d.Key, val)
	}
	s.t2sRuntime.Store(&t2s)
	s.chRuntime.Store(&ch)
	s.carbonRuntime.Store(&carbon)
	s.insRuntime.Store(&ins)
	s.cacheRuntime.Store(&cache)
	s.pricingRuntime.Store(&pricing)
	s.skillsRuntime.Store(&skills)
	s.limitsRuntime.Store(&limits)
	s.loggingRuntime.Store(&logging)
	audit.SetFallbackPriceModel(pricing.FallbackModel) // apply the runtime fallback model
	// Apply retention changes to the running worker (day thresholds next run; interval recreates the ticker).
	if s.retention != nil && prevRet != ret {
		s.retention.Reconfigure(ret)
	}

	// Swap Text2SQL execute/twin DB connections when their DSN/driver changed: close the
	// cached *sql.DB so the next request lazily reopens against the new target.
	if prevT2S.ExecDSN != t2s.ExecDSN || prevT2S.ExecDriver != t2s.ExecDriver {
		if db := s.t2sExec.Swap(nil); db != nil {
			_ = db.Close()
		}
	}
	if prevT2S.TwinDSN != t2s.TwinDSN || prevT2S.TwinDriver != t2s.TwinDriver {
		if db := s.t2sTwin.Swap(nil); db != nil {
			_ = db.Close()
		}
	}
	// Restart the ClickHouse sink worker when its URL or interval changed (start/stop too).
	if s.chSinkStarted && (prevCH.URL != ch.URL || prevCH.SinkInterval != ch.SinkInterval) {
		s.applyClickHouseSinkWorker()
	}
}

func applyRuntimeSetting(t2s *config.Text2SQLConfig, ch *config.ClickHouseConfig, carbon *config.CarbonConfig, ins *config.InsuranceConfig, cache *config.CacheConfig, ret *config.RetentionConfig, pricing *config.PricingConfig, skills *config.SkillsConfig, limits *config.LimitsConfig, logging *config.LoggingConfig, key, val string) {
	val = strings.TrimSpace(val)
	atoi := func() int { n, _ := strconv.Atoi(val); return n }
	atof := func() float64 { f, _ := strconv.ParseFloat(val, 64); return f }
	atob := func() bool { b, _ := strconv.ParseBool(val); return b }
	adur := func(d time.Duration) time.Duration {
		if v, err := time.ParseDuration(val); err == nil {
			return v
		}
		return d
	}
	switch key {
	case "clickhouse.url":
		ch.URL = val
	case "clickhouse.database":
		ch.Database = val
	case "clickhouse.table":
		ch.Table = val
	case "clickhouse.user":
		ch.User = val
	case "clickhouse.password":
		ch.Password = val
	case "clickhouse.sink_interval":
		ch.SinkInterval = adur(ch.SinkInterval)
	case "clickhouse.sink_days":
		ch.SinkDays = atoi()
	case "clickhouse.text2sql_fact_table":
		ch.Text2SQLFactTable = val
	case "clickhouse.request_fact_table":
		ch.RequestFactTable = val
	case "clickhouse.tool_fact_table":
		ch.ToolFactTable = val
	case "clickhouse.routing_fact_table":
		ch.RoutingFactTable = val
	case "clickhouse.eval_fact_table":
		ch.EvalFactTable = val
	case "clickhouse.feedback_fact_table":
		ch.FeedbackFactTable = val
	case "clickhouse.skill_fact_table":
		ch.SkillFactTable = val
	case "clickhouse.policy_fact_table":
		ch.PolicyFactTable = val
	case "clickhouse.batch_size":
		ch.BatchSize = atoi()
	case "clickhouse.flush_interval":
		ch.FlushInterval = adur(ch.FlushInterval)
	case "text2sql.enabled":
		t2s.Enabled = atob()
	case "text2sql.preview_model":
		t2s.PreviewModel = val
	case "text2sql.execute_model":
		t2s.ExecuteModel = val
	case "text2sql.accurate_model":
		t2s.AccurateModel = val
	case "text2sql.local_model":
		t2s.LocalModel = val
	case "text2sql.summary_model":
		t2s.SummaryModel = val
	case "text2sql.dialect":
		t2s.Dialect = val
	case "text2sql.default_limit":
		t2s.DefaultLimit = atoi()
	case "text2sql.max_limit":
		t2s.MaxLimit = atoi()
	case "text2sql.max_explain_cost":
		t2s.MaxExplainCost = atof()
	case "text2sql.mask_results":
		t2s.MaskResults = atob()
	case "text2sql.exec_driver":
		t2s.ExecDriver = val
	case "text2sql.exec_dsn":
		t2s.ExecDSN = val
	case "text2sql.cache_enabled":
		t2s.CacheEnabled = atob()
	case "text2sql.cache_ttl":
		t2s.CacheTTL = adur(t2s.CacheTTL)
	case "text2sql.clarify_enabled":
		t2s.ClarifyEnabled = atob()
	case "text2sql.require_date_filter":
		t2s.RequireDateFilter = atob()
	case "text2sql.statement_timeout":
		t2s.StatementTimeout = adur(t2s.StatementTimeout)
	case "text2sql.work_mem":
		t2s.WorkMem = val
	case "text2sql.shadow_models":
		parts := strings.Split(val, ",")
		out := parts[:0]
		for _, p := range parts {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		if len(out) == 0 {
			t2s.ShadowModels = nil
		} else {
			t2s.ShadowModels = out
		}
	case "text2sql.shadow_sample_rate":
		t2s.ShadowSampleRate = atof()
	case "text2sql.replay_bundles":
		t2s.ReplayBundles = atob()
	case "text2sql.daily_risk_limit":
		t2s.DailyRiskLimit = atoi()
	case "text2sql.daily_risk_warn":
		t2s.DailyRiskWarn = atoi()
	case "text2sql.twin_driver":
		t2s.TwinDriver = val
	case "text2sql.twin_dsn":
		t2s.TwinDSN = val
	case "carbon.wh_per_1k_tokens":
		carbon.WhPer1KTokens = atof()
	case "carbon.pue":
		carbon.PUE = atof()
	case "carbon.grid_intensity_g":
		carbon.GridIntensityG = atof()
	case "insurance.sla_target":
		ins.SLATarget = atof()
	case "insurance.fast_burn":
		ins.FastBurnThreshold = atof()
	case "insurance.slow_burn":
		ins.SlowBurnThreshold = atof()
	case "cache.embedding_enabled":
		cache.EmbeddingEnabled = atob()
	case "cache.embedding_ttl":
		cache.EmbeddingTTL = adur(cache.EmbeddingTTL)
	case "cache.embedding_max_bytes":
		cache.EmbeddingMaxBytes = atoi()
	case "cache.chat_enabled":
		cache.ChatEnabled = atob()
	case "cache.chat_ttl":
		cache.ChatTTL = adur(cache.ChatTTL)
	case "cache.chat_semantic_enabled":
		cache.ChatSemanticEnabled = atob()
	case "cache.chat_semantic_model":
		cache.ChatSemanticModel = val
	case "cache.chat_semantic_threshold":
		cache.ChatSemanticThreshold = atof()
	case "cache.chat_semantic_max_candidates":
		cache.ChatSemanticMaxCandidates = atoi()
	case "cache.chat_semantic_multiturn":
		cache.ChatSemanticMultiTurn = atob()
	case "cache.embedding_provider":
		cache.EmbeddingProvider = val
	case "cache.embedding_base_url":
		cache.EmbeddingBaseURL = val
	case "cache.embedding_api_key":
		cache.EmbeddingAPIKey = val
	case "retention.request_days":
		ret.RequestDays = atoi()
	case "retention.prompt_days":
		ret.PromptDays = atoi()
	case "retention.response_days":
		ret.ResponseDays = atoi()
	case "retention.text2sql_replay_days":
		ret.Text2SQLReplayDays = atoi()
	case "retention.interval":
		ret.Interval = adur(ret.Interval)
	case "pricing.fallback_model":
		pricing.FallbackModel = val
	case "pricing.usd_krw":
		pricing.USDToKRW = atof()
	case "skills.enforcement":
		skills.Enforcement = strings.ToLower(val)
	case "limits.max_output_tokens":
		limits.MaxOutputTokens = atoi()
	case "limits.max_request_bytes":
		limits.MaxRequestBytes = atoi()
	case "limits.max_messages":
		limits.MaxMessages = atoi()
	case "logging.response_text":
		logging.ResponseText = atob()
	case "logging.raw_prompts":
		logging.RawPrompts = atob()
	case "logging.raw_bodies":
		logging.RawBodies = atob()
	case "logging.response_max_bytes":
		logging.ResponseMaxBytes = atoi()
	}
}

// settingPermissionGroup classifies a setting key into a permission group so role-scoped
// admins can be limited to their slice (per spec §11). Secret keys and masking/risk/replay
// controls are "security"; ClickHouse/retention/cache are "ops"; Text2SQL (model/eval/etc.)
// is "ai"; everything else (carbon/insurance) is admin-only.
func settingPermissionGroup(d settingDef) string {
	if d.Secret {
		return "security"
	}
	switch d.Key {
	case "text2sql.mask_results", "text2sql.daily_risk_limit", "text2sql.daily_risk_warn", "text2sql.replay_bundles":
		return "security"
	}
	if strings.HasPrefix(d.Category, "skills") {
		return "security" // Skill policy enforcement is a governance gate
	}
	switch {
	case strings.HasPrefix(d.Category, "clickhouse"), strings.HasPrefix(d.Category, "retention"), strings.HasPrefix(d.Category, "cache"), strings.HasPrefix(d.Category, "limits"):
		return "ops"
	case strings.HasPrefix(d.Category, "text2sql"):
		return "ai"
	case strings.HasPrefix(d.Category, "logging"):
		return "security" // captures sensitive content (prompts/responses)
	default:
		return "admin"
	}
}

// settingsSubAdminRole reports whether a role is one of the settings-scoped sub-admins.
func settingsSubAdminRole(role string) bool {
	switch role {
	case "ops_admin", "ai_admin", "security_admin":
		return true
	}
	return false
}

// roleCanWriteGroup reports whether a role may write settings in a permission group.
func roleCanWriteGroup(role, group string) bool {
	switch role {
	case "super_admin", "admin", "":
		return true // full admins (and legacy ADMIN_TOKEN mode → empty role) write anything
	case "ops_admin":
		return group == "ops"
	case "ai_admin":
		return group == "ai"
	case "security_admin":
		return group == "security"
	default:
		return false
	}
}

// callerSettingsRole returns the caller's role for settings authorization. In ADMIN_TOKEN
// mode (no JWT) it returns "" which roleCanWriteGroup treats as full admin.
func (s *Server) callerSettingsRole(r *http.Request) string {
	if claims, ok := s.currentAccessClaims(r); ok {
		return claims.Role
	}
	return ""
}

// canWriteSetting reports whether the caller may modify a specific setting.
func (s *Server) canWriteSetting(r *http.Request, d settingDef) bool {
	return roleCanWriteGroup(s.callerSettingsRole(r), settingPermissionGroup(d))
}

func settingDefByKey(key string) (settingDef, bool) {
	for _, d := range settingRegistry {
		if d.Key == key {
			return d, true
		}
	}
	return settingDef{}, false
}

// validateSettingValue checks the proposed string value against the key's type + validator.
func validateSettingValue(d settingDef, value string) error {
	switch d.Type {
	case stInt:
		if _, err := strconv.Atoi(strings.TrimSpace(value)); err != nil {
			return fmt.Errorf("must be an integer")
		}
	case stBool:
		if _, err := strconv.ParseBool(strings.TrimSpace(value)); err != nil {
			return fmt.Errorf("must be true or false")
		}
	case stFloat:
		if _, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err != nil {
			return fmt.Errorf("must be a number")
		}
	case stDuration:
		if _, err := time.ParseDuration(strings.TrimSpace(value)); err != nil {
			return fmt.Errorf("must be a duration (e.g. 15s, 1h)")
		}
	}
	if d.validate != nil {
		return d.validate(strings.TrimSpace(value))
	}
	return nil
}

// effectiveSettingValue returns the current effective string value for a key: the stored
// admin override (decrypted for secrets) if present, else the env/default. The second
// return reports the source ("admin" or "env").
func (s *Server) effectiveSettingValue(stored map[string]store.AdminSetting, d settingDef) (string, string) {
	if a, ok := stored[d.Key]; ok {
		raw := a.ValueJSON
		var decoded string
		if json.Unmarshal([]byte(raw), &decoded) != nil {
			decoded = raw
		}
		if d.Secret {
			if plain, err := s.secrets.Load().Decrypt(decoded); err == nil {
				return plain, "admin"
			}
			return "", "admin"
		}
		return decoded, "admin"
	}
	return d.envValue(s.cfg), "env"
}

// settingView is the API representation of one setting (secret-masked).
func (s *Server) settingView(stored map[string]store.AdminSetting, d settingDef) map[string]any {
	eff, source := s.effectiveSettingValue(stored, d)
	view := map[string]any{
		"key": d.Key, "category": d.Category, "type": string(d.Type),
		"is_secret": d.Secret, "restart_required": d.Restart, "source": source,
		"description": settingDescriptions[d.Key], "read_only": d.ReadOnly,
	}
	if a, ok := stored[d.Key]; ok {
		view["version"] = a.Version
		view["updated_by"] = a.UpdatedBy
		view["updated_at"] = a.UpdatedAt
	}
	if d.Secret {
		view["is_set"] = strings.TrimSpace(eff) != ""
		if strings.TrimSpace(eff) != "" {
			view["value"] = "********"
		} else {
			view["value"] = ""
		}
	} else {
		view["value"] = eff
	}
	return view
}

func (s *Server) loadStoredSettings(r *http.Request) (map[string]store.AdminSetting, error) {
	list, err := s.db.ListAdminSettings(r.Context())
	if err != nil {
		return nil, err
	}
	m := map[string]store.AdminSetting{}
	for _, a := range list {
		m[a.Key] = a
	}
	return m, nil
}

// handleAdminSettings serves GET /admin/settings and GET /admin/settings/{category}.
func (s *Server) handleAdminSettings(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	category := strings.Trim(strings.TrimPrefix(r.URL.Path, "/admin/settings"), "/")
	stored, err := s.loadStoredSettings(r)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "settings_failed")
		return
	}
	items := []map[string]any{}
	for _, d := range settingRegistry {
		if category != "" && d.Category != category && !strings.HasPrefix(d.Category, category+".") {
			continue
		}
		view := s.settingView(stored, d)
		view["permission_group"] = settingPermissionGroup(d)
		view["can_write"] = s.canWriteSetting(r, d)
		items = append(items, view)
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": items, "category": category})
}

// handleAdminSettingByKey serves PUT (set) and DELETE (revert to env) for one key.
func (s *Server) handleAdminSettingByKey(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	key := strings.Trim(strings.TrimPrefix(r.URL.Path, "/admin/settings/by-key/"), "/")
	d, ok := settingDefByKey(key)
	if !ok {
		writeOpenAIError(w, http.StatusNotFound, "unknown setting key", "invalid_request_error", "unknown_key")
		return
	}
	if (r.Method == http.MethodPut || r.Method == http.MethodDelete) && d.ReadOnly {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "this setting is read-only (env variable); change it via container environment", "invalid_request_error", "setting_read_only")
		return
	}
	if (r.Method == http.MethodPut || r.Method == http.MethodDelete) && !s.canWriteSetting(r, d) {
		writeOpenAIError(w, http.StatusForbidden, "your role cannot modify this setting category", "permission_error", "settings_role_denied")
		return
	}
	switch r.Method {
	case http.MethodPut:
		var payload struct {
			Value  string `json:"value"`
			Reason string `json:"reason"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if err := s.applySettingWrite(r, d, payload.Value, payload.Reason); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "setting_invalid")
			return
		}
		s.auditAdmin(r, "setting.update", key, auditJSON(map[string]any{"key": key, "secret": d.Secret}))
		stored, _ := s.loadStoredSettings(r)
		writeJSON(w, http.StatusOK, s.settingView(stored, d))
	case http.MethodDelete:
		if err := s.db.DeleteAdminSetting(r.Context(), key, adminID(r), strings.TrimSpace(r.URL.Query().Get("reason"))); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "setting_delete_failed")
			return
		}
		s.reloadRuntimeConfig(r.Context())
		s.auditAdmin(r, "setting.revert", key, "")
		stored, _ := s.loadStoredSettings(r)
		writeJSON(w, http.StatusOK, s.settingView(stored, d))
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// applySettingWrite persists one setting value and reloads the runtime snapshot.
func (s *Server) applySettingWrite(r *http.Request, d settingDef, value, reason string) error {
	if err := s.persistSettingValue(r, d, value, reason); err != nil {
		return err
	}
	s.reloadRuntimeConfig(r.Context())
	return nil
}

// persistSettingValue validates, encrypts (if secret), and writes a setting WITHOUT
// reloading the runtime snapshot (callers reload once after a batch).
func (s *Server) persistSettingValue(r *http.Request, d settingDef, value, reason string) error {
	value = strings.TrimSpace(value)
	if !d.Secret && value == "" && d.Type != stString && d.Type != stCSV {
		return fmt.Errorf("value is required")
	}
	if !d.Secret || value != "" {
		if err := validateSettingValue(d, value); err != nil {
			return err
		}
	}
	// Secret with empty value = leave unchanged (don't overwrite with blank).
	if d.Secret && value == "" {
		return fmt.Errorf("secret value is empty; provide a value to change it or use DELETE to revert")
	}
	storeValue := value
	if d.Secret {
		enc, err := s.secrets.Load().Encrypt(value)
		if err != nil {
			return fmt.Errorf("encrypt secret: %w", err)
		}
		storeValue = enc
	}
	encoded, err := json.Marshal(storeValue)
	if err != nil {
		return err
	}
	return s.db.UpsertAdminSetting(r.Context(), store.AdminSetting{
		Key: d.Key, Category: d.Category, ValueJSON: string(encoded), ValueType: string(d.Type), IsSecret: d.Secret, Source: "admin",
	}, adminID(r), reason)
}

// handleAdminSettingsBulk applies many settings atomically: validate all first, then write
// all and reload once. POST /admin/settings/bulk {settings:[{key,value}], reason}
func (s *Server) handleAdminSettingsBulk(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	var payload struct {
		Settings []struct{ Key, Value string } `json:"settings"`
		Reason   string                        `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	s.applySettingsBatch(w, r, payload.Settings, payload.Reason, false)
}

// handleAdminSettingsImport imports non-secret settings (the export format). Secret keys
// are rejected (they must be set individually). POST /admin/settings/import
func (s *Server) handleAdminSettingsImport(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	var payload struct {
		Settings []struct{ Key, Value string } `json:"settings"`
		Reason   string                        `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	s.applySettingsBatch(w, r, payload.Settings, payload.Reason, true)
}

// applySettingsBatch validates every item (rejecting the whole batch on any error, so a
// partial apply can't break the gateway), then persists all and reloads once. When
// rejectSecret is set (import), secret keys are refused.
func (s *Server) applySettingsBatch(w http.ResponseWriter, r *http.Request, items []struct{ Key, Value string }, reason string, rejectSecret bool) {
	if len(items) == 0 {
		writeOpenAIError(w, http.StatusBadRequest, "no settings provided", "invalid_request_error", "empty_batch")
		return
	}
	type resolved struct {
		def   settingDef
		value string
	}
	out := make([]resolved, 0, len(items))
	errs := map[string]string{}
	proposed := map[string]string{}
	for _, it := range items {
		key := strings.TrimSpace(it.Key)
		d, ok := settingDefByKey(key)
		if !ok {
			errs[key] = "unknown setting key"
			continue
		}
		if rejectSecret && d.Secret {
			errs[key] = "secret keys cannot be imported; set them individually"
			continue
		}
		if !s.canWriteSetting(r, d) {
			errs[key] = "your role cannot modify this setting category"
			continue
		}
		val := strings.TrimSpace(it.Value)
		if !d.Secret || val != "" {
			if err := validateSettingValue(d, val); err != nil {
				errs[key] = err.Error()
				continue
			}
		}
		proposed[key] = val
		out = append(out, resolved{def: d, value: val})
	}
	// Cross-key: default_limit <= max_limit after the batch is applied.
	if errs["text2sql.default_limit"] == "" && errs["text2sql.max_limit"] == "" {
		stored, _ := s.loadStoredSettings(r)
		get := func(key string) int {
			if v, ok := proposed[key]; ok {
				n, _ := strconv.Atoi(v)
				return n
			}
			d, _ := settingDefByKey(key)
			eff, _ := s.effectiveSettingValue(stored, d)
			n, _ := strconv.Atoi(eff)
			return n
		}
		if get("text2sql.default_limit") > get("text2sql.max_limit") {
			errs["text2sql.default_limit"] = "default_limit must be <= max_limit"
		}
	}
	if len(errs) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "errors": errs})
		return
	}
	for _, rsv := range out {
		if err := s.persistSettingValue(r, rsv.def, rsv.value, reason); err != nil {
			// Validation already passed; a write error here is a server fault.
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "bulk_write_failed")
			return
		}
	}
	s.reloadRuntimeConfig(r.Context())
	s.auditAdmin(r, "setting.bulk", "", auditJSON(map[string]any{"count": len(out), "import": rejectSecret}))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "applied": len(out)})
}

// handleAdminSettingsExport returns admin-overridden, non-secret settings (the importable
// format). Secrets are excluded. GET /admin/settings/export
func (s *Server) handleAdminSettingsExport(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	stored, err := s.loadStoredSettings(r)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "export_failed")
		return
	}
	items := []map[string]string{}
	for _, d := range settingRegistry {
		if d.Secret {
			continue
		}
		if _, ok := stored[d.Key]; !ok {
			continue // only export admin overrides
		}
		val, _ := s.effectiveSettingValue(stored, d)
		items = append(items, map[string]string{"key": d.Key, "value": val})
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": items, "note": "secrets excluded; set them individually after import"})
}

// handleAdminSettingsValidate validates a proposed value without persisting it.
// POST /admin/settings/validate {key, value}
func (s *Server) handleAdminSettingsValidate(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	var payload struct{ Key, Value string }
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	d, ok := settingDefByKey(strings.TrimSpace(payload.Key))
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "unknown setting key"})
		return
	}
	if err := validateSettingValue(d, strings.TrimSpace(payload.Value)); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": err.Error()})
		return
	}
	// Cross-key check: default_limit <= max_limit.
	stored, _ := s.loadStoredSettings(r)
	if d.Key == "text2sql.default_limit" || d.Key == "text2sql.max_limit" {
		def, max := s.crossLimit(stored, d.Key, strings.TrimSpace(payload.Value))
		if def > max {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "default_limit must be <= max_limit"})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) crossLimit(stored map[string]store.AdminSetting, changingKey, newValue string) (int, int) {
	get := func(key string) int {
		d, _ := settingDefByKey(key)
		eff, _ := s.effectiveSettingValue(stored, d)
		n, _ := strconv.Atoi(eff)
		return n
	}
	def, max := get("text2sql.default_limit"), get("text2sql.max_limit")
	n, _ := strconv.Atoi(newValue)
	if changingKey == "text2sql.default_limit" {
		def = n
	} else {
		max = n
	}
	return def, max
}

// handleSettingsTestClickHouse pings ClickHouse and (when a table is given) checks the
// table exists, using provided overrides or the current effective config.
// POST /admin/settings/test/clickhouse {url?,user?,password?,database?,table?}
func (s *Server) handleSettingsTestClickHouse(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	var p struct{ URL, User, Password, Database, Table string }
	_ = json.NewDecoder(r.Body).Decode(&p)
	ch := s.chConf()
	pick := func(override, cur string) string {
		if strings.TrimSpace(override) != "" {
			return strings.TrimSpace(override)
		}
		return cur
	}
	chURL := pick(p.URL, ch.URL)
	if chURL == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "no ClickHouse URL configured or provided"})
		return
	}
	user, pass, dbName := pick(p.User, ch.User), pick(p.Password, ch.Password), pick(p.Database, ch.Database)
	table := pick(p.Table, ch.Table)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	start := time.Now()
	chGet := func(query string) (int, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, chURL+"/?query="+url.QueryEscape(query), nil)
		if err != nil {
			return 0, err
		}
		if user != "" {
			req.Header.Set("X-ClickHouse-User", user)
			req.Header.Set("X-ClickHouse-Key", pass)
		}
		resp, err := s.client.Do(req)
		if err != nil {
			return 0, err
		}
		resp.Body.Close()
		return resp.StatusCode, nil
	}
	code, err := chGet("SELECT 1")
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "ping failed: " + err.Error()})
		return
	}
	if code != http.StatusOK {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": fmt.Sprintf("ping returned HTTP %d (check auth/url)", code)})
		return
	}
	result := map[string]any{"ok": true, "latency_ms": time.Since(start).Milliseconds(), "ping": "ok"}
	if table != "" {
		ref := table
		if dbName != "" && !strings.Contains(table, ".") {
			ref = dbName + "." + table
		}
		tc, terr := chGet("EXISTS TABLE " + ref)
		result["table_checked"] = ref
		result["table_ok"] = terr == nil && tc == http.StatusOK
		if terr != nil || tc != http.StatusOK {
			result["table_message"] = "table existence check failed (table may be missing or no permission)"
		}
	}
	s.auditAdmin(r, "setting.test.clickhouse", "", auditJSON(map[string]any{"url_set": chURL != "", "table": table}))
	writeJSON(w, http.StatusOK, result)
}

// handleSettingsTestText2SQLDB opens a Text2SQL execute/twin DB (provided override or
// effective config) and runs SELECT 1. dbKind is "exec" or "twin".
func (s *Server) handleSettingsTestText2SQLDB(w http.ResponseWriter, r *http.Request, dbKind string) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	var p struct{ DSN, Driver string }
	_ = json.NewDecoder(r.Body).Decode(&p)
	t2s := s.t2sConf()
	dsn, driver := strings.TrimSpace(p.DSN), strings.TrimSpace(p.Driver)
	if dsn == "" {
		if dbKind == "twin" {
			dsn, driver = t2s.TwinDSN, t2s.TwinDriver
		} else {
			dsn, driver = t2s.ExecDSN, t2s.ExecDriver
		}
	}
	if strings.TrimSpace(dsn) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "no DSN configured or provided"})
		return
	}
	db, drv, err := openTransientSQLDB(dsn, driver)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "open failed: " + err.Error()})
		return
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	start := time.Now()
	var one int
	if err := db.QueryRowContext(ctx, "SELECT 1").Scan(&one); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "SELECT 1 failed: " + err.Error()})
		return
	}
	result := map[string]any{"ok": true, "driver": drv, "latency_ms": time.Since(start).Milliseconds()}
	if dbKind == "twin" && dsn == t2s.ExecDSN && dsn != "" {
		result["warning"] = "twin DSN equals the execute DSN — a separate masked/sample DB is recommended"
	}
	s.auditAdmin(r, "setting.test.text2sql_"+dbKind, "", "")
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleSettingsTestText2SQLExec(w http.ResponseWriter, r *http.Request) {
	s.handleSettingsTestText2SQLDB(w, r, "exec")
}
func (s *Server) handleSettingsTestText2SQLTwin(w http.ResponseWriter, r *http.Request) {
	s.handleSettingsTestText2SQLDB(w, r, "twin")
}

// handleAdminSettingsHistory serves GET /admin/settings/history?key=.
func (s *Server) handleAdminSettingsHistory(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	hist, err := s.db.ListAdminSettingHistory(r.Context(), strings.TrimSpace(r.URL.Query().Get("key")), recentLimit(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "history_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"history": hist})
}

// handleAdminSettingsRollback reverts a (non-secret) key to its previous value from history.
// POST /admin/settings/rollback {key, reason}
func (s *Server) handleAdminSettingsRollback(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	var payload struct{ Key, Reason string }
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	key := strings.TrimSpace(payload.Key)
	d, ok := settingDefByKey(key)
	if !ok {
		writeOpenAIError(w, http.StatusNotFound, "unknown setting key", "invalid_request_error", "unknown_key")
		return
	}
	if !s.canWriteSetting(r, d) {
		writeOpenAIError(w, http.StatusForbidden, "your role cannot modify this setting category", "permission_error", "settings_role_denied")
		return
	}
	if d.Secret {
		writeOpenAIError(w, http.StatusBadRequest, "secret values cannot be rolled back (history stores no value); set or revert instead", "invalid_request_error", "secret_rollback_unsupported")
		return
	}
	hist, err := s.db.ListAdminSettingHistory(r.Context(), key, 5)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "rollback_failed")
		return
	}
	if len(hist) == 0 || strings.TrimSpace(hist[0].OldValueJSON) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "no previous value to roll back to", "invalid_request_error", "no_history")
		return
	}
	var prev string
	if json.Unmarshal([]byte(hist[0].OldValueJSON), &prev) != nil {
		prev = hist[0].OldValueJSON
	}
	if err := s.applySettingWrite(r, d, prev, "rollback: "+strings.TrimSpace(payload.Reason)); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "rollback_failed")
		return
	}
	s.auditAdmin(r, "setting.rollback", key, auditJSON(map[string]any{"key": key}))
	stored, _ := s.loadStoredSettings(r)
	writeJSON(w, http.StatusOK, s.settingView(stored, d))
}
