package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"vibe-coders/internal/config"
)

var blobRegex = regexp.MustCompile(`(?i)\bblob\b`)

type SQLStore struct {
	db      *sql.DB
	dialect string
}

func Open(ctx context.Context, cfg config.DatabaseConfig) (*SQLStore, error) {
	driver := strings.ToLower(cfg.Driver)
	dsn := cfg.DSN
	if driver == "" {
		driver = "sqlite"
	}
	if driver == "postgresql" {
		driver = "postgres"
	}
	if driver == "sqlite" {
		if dsn == "" {
			dsn = filepath.Join("data", "gateway.db")
		}
		if !strings.Contains(dsn, "busy_timeout") && !strings.Contains(dsn, "mode=memory") {
			delim := "?"
			if strings.Contains(dsn, "?") {
				delim = "&"
			}
			dsn = dsn + delim + "_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
		}
		dbPath := strings.Split(dsn, "?")[0]
		if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
			return nil, err
		}
	} else if driver != "postgres" {
		return nil, fmt.Errorf("unsupported database driver %q", cfg.Driver)
	}

	sqlDriver := driver
	if driver == "postgres" {
		sqlDriver = "pgx"
		stdlib.GetDefaultDriver()
	}

	db, err := sql.Open(sqlDriver, dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	if driver == "sqlite" {
		db.SetMaxOpenConns(1)
	}

	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}

	return &SQLStore{db: db, dialect: driver}, nil
}

func (s *SQLStore) Close() error {
	return s.db.Close()
}

func (s *SQLStore) Ping(ctx context.Context) error {
	return s.db.PingContext(ctx)
}

func (s *SQLStore) Migrate(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS api_keys (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			key_hash TEXT NOT NULL UNIQUE,
			owner TEXT,
			team TEXT,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`ALTER TABLE api_keys ADD COLUMN user_id TEXT`,
		`ALTER TABLE api_keys ADD COLUMN service_account_id TEXT`,
		`ALTER TABLE api_keys ADD COLUMN role TEXT`,
		`ALTER TABLE api_keys ADD COLUMN scopes TEXT`,
		`ALTER TABLE api_keys ADD COLUMN allowed_ips TEXT`,
		`ALTER TABLE api_keys ADD COLUMN allowed_models TEXT`,
		`ALTER TABLE api_keys ADD COLUMN denied_models TEXT`,
		`ALTER TABLE api_keys ADD COLUMN allowed_providers TEXT`,
		`ALTER TABLE api_keys ADD COLUMN denied_providers TEXT`,
		`ALTER TABLE api_keys ADD COLUMN budget_limit_krw REAL NOT NULL DEFAULT 0`,
		`ALTER TABLE api_keys ADD COLUMN expires_at TEXT`,
		`ALTER TABLE api_keys ADD COLUMN revoked_at TEXT`,
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			name TEXT,
			role TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS teams (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS user_team_memberships (
			user_id TEXT NOT NULL,
			team_id TEXT NOT NULL,
			role TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (user_id, team_id)
		)`,
		`CREATE TABLE IF NOT EXISTS refresh_tokens (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			token_hash TEXT NOT NULL UNIQUE,
			revoked_at TEXT,
			expires_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			rotated_from TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash)`,
		`CREATE TABLE IF NOT EXISTS auth_sessions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			ip TEXT,
			user_agent TEXT,
			revoked_at TEXT,
			expires_at TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS inferred_sessions (
			identity_hash TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			last_seen TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_inferred_sessions_last_seen ON inferred_sessions(last_seen)`,
		`CREATE TABLE IF NOT EXISTS audit_events (
			id TEXT PRIMARY KEY,
			event_type TEXT NOT NULL,
			actor_user_id TEXT,
			api_key_id TEXT,
			team_id TEXT,
			ip TEXT,
			user_agent TEXT,
			detail TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_events_type ON audit_events(event_type)`,
		`CREATE TABLE IF NOT EXISTS login_attempts (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL,
			success INTEGER NOT NULL,
			ip TEXT,
			user_agent TEXT,
			reason TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS request_logs (
			id TEXT PRIMARY KEY,
			trace_id TEXT NOT NULL,
			api_key_id TEXT,
			client_ip TEXT,
			forwarded_for TEXT,
			user_agent TEXT,
			hostname TEXT,
			model TEXT,
			endpoint TEXT NOT NULL,
			stream INTEGER NOT NULL,
			provider TEXT,
			status_code INTEGER NOT NULL,
			latency_ms INTEGER NOT NULL,
			first_chunk_ms INTEGER NOT NULL DEFAULT 0,
			session_id TEXT,
			prompt_name TEXT,
			prompt_version TEXT,
			prompt_variables_hash TEXT,
			tool_count INTEGER NOT NULL DEFAULT 0,
			error TEXT,
			request_hash TEXT,
			body_raw TEXT,
			replay_of TEXT,
			failover INTEGER NOT NULL DEFAULT 0,
			route_reason TEXT,
			route_detail TEXT,
			complexity INTEGER NOT NULL DEFAULT 0,
			fallback_from TEXT,
			fallback_reason TEXT,
			created_at TEXT NOT NULL
		)`,
		// Idempotent ALTERs for legacy installations of request_logs
		`ALTER TABLE request_logs ADD COLUMN body_raw TEXT`,
		`ALTER TABLE request_logs ADD COLUMN replay_of TEXT`,
		`ALTER TABLE request_logs ADD COLUMN failover INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE request_logs ADD COLUMN route_reason TEXT`,
		`ALTER TABLE request_logs ADD COLUMN route_detail TEXT`,
		`ALTER TABLE request_logs ADD COLUMN complexity INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE request_logs ADD COLUMN fallback_from TEXT`,
		`ALTER TABLE request_logs ADD COLUMN fallback_reason TEXT`,
		`ALTER TABLE request_logs ADD COLUMN requested_model TEXT`,
		`ALTER TABLE request_logs ADD COLUMN task_type TEXT`,
		`ALTER TABLE request_logs ADD COLUMN prompt_fingerprint TEXT`,
		`ALTER TABLE request_logs ADD COLUMN first_chunk_ms INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE request_logs ADD COLUMN session_id TEXT`,
		`ALTER TABLE request_logs ADD COLUMN prompt_name TEXT`,
		`ALTER TABLE request_logs ADD COLUMN prompt_version TEXT`,
		`ALTER TABLE request_logs ADD COLUMN prompt_variables_hash TEXT`,
		`ALTER TABLE request_logs ADD COLUMN tool_count INTEGER NOT NULL DEFAULT 0`,
		// Cost-allocation dimensions: repo/branch/project from client headers,
		// service + cost_center for chargeback/budget-code reporting.
		`ALTER TABLE request_logs ADD COLUMN repo TEXT`,
		`ALTER TABLE request_logs ADD COLUMN branch TEXT`,
		`ALTER TABLE request_logs ADD COLUMN project TEXT`,
		`ALTER TABLE request_logs ADD COLUMN service TEXT`,
		`ALTER TABLE request_logs ADD COLUMN cost_center TEXT`,
		`CREATE INDEX IF NOT EXISTS idx_request_logs_repo ON request_logs(repo)`,
		`CREATE INDEX IF NOT EXISTS idx_request_logs_project ON request_logs(project)`,
		`CREATE INDEX IF NOT EXISTS idx_request_logs_cost_center ON request_logs(cost_center)`,
		`CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_request_logs_client_ip ON request_logs(client_ip)`,
		`CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(model)`,
		`CREATE INDEX IF NOT EXISTS idx_request_logs_session_id ON request_logs(session_id)`,
		`CREATE INDEX IF NOT EXISTS idx_request_logs_prompt_name ON request_logs(prompt_name)`,
		`CREATE INDEX IF NOT EXISTS idx_request_logs_prompt_fingerprint ON request_logs(prompt_fingerprint)`,
		`CREATE TABLE IF NOT EXISTS prompt_logs (
			id TEXT PRIMARY KEY,
			request_id TEXT NOT NULL,
			role TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			content_text TEXT,
			redacted_text TEXT,
			language_hint TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_prompt_logs_request_id ON prompt_logs(request_id)`,
		`CREATE TABLE IF NOT EXISTS response_logs (
			id TEXT PRIMARY KEY,
			request_id TEXT NOT NULL,
			status_code INTEGER NOT NULL,
			finish_reason TEXT,
			response_hash TEXT,
			response_text_optional TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS token_usage (
			id TEXT PRIMARY KEY,
			request_id TEXT NOT NULL,
			prompt_tokens INTEGER NOT NULL,
			completion_tokens INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			cached_tokens INTEGER NOT NULL DEFAULT 0,
			reasoning_tokens INTEGER NOT NULL DEFAULT 0,
			estimated_cost REAL NOT NULL,
			currency TEXT NOT NULL,
			source TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		// Idempotent ALTERs for legacy installations of token_usage
		`ALTER TABLE token_usage ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE token_usage ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0`,
		`CREATE INDEX IF NOT EXISTS idx_token_usage_request_id ON token_usage(request_id)`,
		`CREATE TABLE IF NOT EXISTS language_stats (
			id TEXT PRIMARY KEY,
			request_id TEXT NOT NULL,
			language TEXT NOT NULL,
			confidence REAL NOT NULL,
			evidence TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_language_stats_language ON language_stats(language)`,
		`CREATE TABLE IF NOT EXISTS llm_evaluations (
			id TEXT PRIMARY KEY,
			request_id TEXT NOT NULL,
			trace_id TEXT NOT NULL,
			name TEXT NOT NULL,
			category TEXT NOT NULL,
			evaluator TEXT NOT NULL,
			score REAL NOT NULL,
			label TEXT NOT NULL,
			passed INTEGER NOT NULL,
			reason TEXT,
			metadata TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_llm_evaluations_request_id ON llm_evaluations(request_id)`,
		`CREATE INDEX IF NOT EXISTS idx_llm_evaluations_name ON llm_evaluations(name)`,
		`CREATE INDEX IF NOT EXISTS idx_llm_evaluations_created_at ON llm_evaluations(created_at)`,
		`CREATE TABLE IF NOT EXISTS llm_feedback (
			id TEXT PRIMARY KEY,
			request_id TEXT NOT NULL,
			trace_id TEXT NOT NULL,
			rating INTEGER NOT NULL,
			label TEXT NOT NULL,
			comment TEXT,
			source TEXT NOT NULL,
			created_by TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_llm_feedback_request_id ON llm_feedback(request_id)`,
		`CREATE INDEX IF NOT EXISTS idx_llm_feedback_trace_id ON llm_feedback(trace_id)`,
		`CREATE INDEX IF NOT EXISTS idx_llm_feedback_created_at ON llm_feedback(created_at)`,
		`CREATE TABLE IF NOT EXISTS tool_invocations (
			id TEXT PRIMARY KEY,
			request_id TEXT NOT NULL,
			trace_id TEXT NOT NULL,
			api_key_id TEXT,
			server_label TEXT,
			tool_name TEXT NOT NULL,
			source TEXT NOT NULL,
			is_mcp INTEGER NOT NULL DEFAULT 0,
			is_error INTEGER NOT NULL DEFAULT 0,
			arg_hash TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_tool_invocations_request_id ON tool_invocations(request_id)`,
		`CREATE INDEX IF NOT EXISTS idx_tool_invocations_server ON tool_invocations(server_label, tool_name)`,
		`CREATE INDEX IF NOT EXISTS idx_tool_invocations_created_at ON tool_invocations(created_at)`,
		`CREATE TABLE IF NOT EXISTS mcp_policies (
			server_label TEXT PRIMARY KEY,
			mode TEXT NOT NULL,
			note TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS policies (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT,
			enabled INTEGER NOT NULL DEFAULT 1,
			priority INTEGER NOT NULL DEFAULT 100,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS policy_rules (
			id TEXT PRIMARY KEY,
			policy_id TEXT NOT NULL,
			name TEXT,
			enabled INTEGER NOT NULL DEFAULT 1,
			priority INTEGER NOT NULL DEFAULT 100,
			conditions_json TEXT NOT NULL,
			actions_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_policy_rules_policy ON policy_rules(policy_id)`,
		`CREATE TABLE IF NOT EXISTS policy_decision_events (
			id TEXT PRIMARY KEY,
			request_id TEXT,
			api_key_id TEXT,
			user_id TEXT,
			team_id TEXT,
			endpoint TEXT,
			phase TEXT,
			policy_id TEXT,
			rule_id TEXT,
			rule_name TEXT,
			decision TEXT NOT NULL,
			reason TEXT,
			model TEXT,
			provider TEXT,
			risk_score INTEGER NOT NULL DEFAULT 0,
			complexity_score INTEGER NOT NULL DEFAULT 0,
			cost_krw REAL NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_policy_decision_events_request ON policy_decision_events(request_id)`,
		`CREATE INDEX IF NOT EXISTS idx_policy_decision_events_created_at ON policy_decision_events(created_at)`,
		`CREATE TABLE IF NOT EXISTS approvals (
			id TEXT PRIMARY KEY,
			request_id TEXT,
			api_key_id TEXT,
			user_id TEXT,
			team_id TEXT,
			subject_type TEXT,
			subject_id TEXT,
			status TEXT NOT NULL,
			reason TEXT,
			risk_score INTEGER NOT NULL DEFAULT 0,
			cost_krw REAL NOT NULL DEFAULT 0,
			payload TEXT,
			expires_at TEXT,
			decided_by TEXT,
			decided_at TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status)`,
		`CREATE INDEX IF NOT EXISTS idx_approvals_request ON approvals(request_id)`,
		`CREATE TABLE IF NOT EXISTS secret_events (
			id TEXT PRIMARY KEY,
			request_id TEXT,
			api_key_id TEXT,
			user_id TEXT,
			team_id TEXT,
			secret_type TEXT NOT NULL,
			action TEXT NOT NULL,
			location TEXT,
			matched_hash TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_secret_events_created_at ON secret_events(created_at)`,
		`CREATE TABLE IF NOT EXISTS tool_risk_profiles (
			id TEXT PRIMARY KEY,
			server_label TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			risk_level TEXT NOT NULL,
			action TEXT NOT NULL,
			note TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(server_label, tool_name)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_tool_risk_profiles_tool ON tool_risk_profiles(server_label, tool_name)`,
		`CREATE TABLE IF NOT EXISTS replay_jobs (
			id TEXT PRIMARY KEY,
			source_request_id TEXT,
			prompt TEXT NOT NULL,
			models TEXT NOT NULL,
			status TEXT NOT NULL,
			results TEXT,
			created_by TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS golden_prompts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			prompt TEXT NOT NULL,
			expected TEXT,
			tags TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS golden_prompt_results (
			id TEXT PRIMARY KEY,
			prompt_id TEXT NOT NULL,
			model TEXT NOT NULL,
			score REAL NOT NULL DEFAULT 0,
			passed INTEGER NOT NULL DEFAULT 0,
			cost_krw REAL NOT NULL DEFAULT 0,
			latency_ms INTEGER NOT NULL DEFAULT 0,
			response TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_golden_prompt_results_prompt ON golden_prompt_results(prompt_id)`,
		// Golden Workflow: a named, ordered suite of golden steps run as one regression
		// unit. Steps are stored inline as an ordered JSON array of {name,prompt,expected}.
		`CREATE TABLE IF NOT EXISTS golden_workflows (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT,
			steps TEXT NOT NULL,
			tags TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS anomaly_events (
			id TEXT PRIMARY KEY,
			scope TEXT NOT NULL,
			scope_value TEXT,
			metric TEXT NOT NULL,
			value REAL NOT NULL,
			baseline REAL NOT NULL DEFAULT 0,
			severity TEXT NOT NULL,
			channel TEXT,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_anomaly_events_created_at ON anomaly_events(created_at)`,
		`CREATE TABLE IF NOT EXISTS context_registry (
			id TEXT PRIMARY KEY,
			key TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			content TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			token_estimate INTEGER NOT NULL DEFAULT 0,
			use_count INTEGER NOT NULL DEFAULT 0,
			last_used_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS budgets (
			id TEXT PRIMARY KEY,
			scope TEXT NOT NULL,
			scope_value TEXT NOT NULL,
			monthly_krw REAL NOT NULL,
			note TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS vcs_events (
				id TEXT PRIMARY KEY,
				provider TEXT NOT NULL,
				kind TEXT NOT NULL,
				repo TEXT,
				branch TEXT,
				ref TEXT,
				title TEXT,
				url TEXT,
				author_email TEXT,
				author_name TEXT,
				state TEXT,
				session_id TEXT,
				api_key_id TEXT,
				created_at TEXT NOT NULL
			)`,
		`CREATE INDEX IF NOT EXISTS idx_vcs_events_session ON vcs_events(session_id)`,
		`CREATE INDEX IF NOT EXISTS idx_vcs_events_created_at ON vcs_events(created_at)`,
		`CREATE TABLE IF NOT EXISTS mcp_upstreams (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				url TEXT NOT NULL,
				encrypted_auth TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL
			)`,
		`CREATE TABLE IF NOT EXISTS knowledge_snippets (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				content TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 1,
				token_estimate INTEGER NOT NULL DEFAULT 0,
				use_count INTEGER NOT NULL DEFAULT 0,
				last_used_at TEXT,
				created_at TEXT NOT NULL
			)`,
		`CREATE TABLE IF NOT EXISTS text2sql_tables (
				schema_name TEXT NOT NULL,
				table_name TEXT NOT NULL,
				description TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (schema_name, table_name)
			)`,
		`CREATE TABLE IF NOT EXISTS text2sql_columns (
				schema_name TEXT NOT NULL,
				table_name TEXT NOT NULL,
				column_name TEXT NOT NULL,
				data_type TEXT,
				description TEXT,
				sensitivity TEXT NOT NULL DEFAULT 'normal',
				updated_at TEXT NOT NULL,
				PRIMARY KEY (schema_name, table_name, column_name)
			)`,
		`CREATE TABLE IF NOT EXISTS text2sql_permissions (
				id TEXT PRIMARY KEY,
				subject_type TEXT NOT NULL,
				subject_id TEXT NOT NULL,
				schema_name TEXT NOT NULL DEFAULT '*',
				table_name TEXT NOT NULL DEFAULT '*',
				column_name TEXT NOT NULL DEFAULT '*',
				action TEXT NOT NULL,
				created_at TEXT NOT NULL
			)`,
		`CREATE INDEX IF NOT EXISTS idx_text2sql_permissions_subject ON text2sql_permissions(subject_type, subject_id)`,
		`CREATE TABLE IF NOT EXISTS text2sql_profiles (
				virtual_model TEXT PRIMARY KEY,
				mode TEXT NOT NULL DEFAULT 'preview',
				upstream_model TEXT,
				summary_model TEXT,
				schema_name TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				updated_at TEXT NOT NULL
			)`,
		`CREATE TABLE IF NOT EXISTS text2sql_exec_connections (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				driver TEXT NOT NULL DEFAULT 'sqlite',
				encrypted_dsn TEXT NOT NULL DEFAULT '',
				description TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		`ALTER TABLE text2sql_profiles ADD COLUMN exec_connection_id TEXT NOT NULL DEFAULT ''`,
		`CREATE TABLE IF NOT EXISTS text2sql_golden_queries (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				question TEXT NOT NULL,
				expected_sql TEXT NOT NULL,
				schema_name TEXT,
				tags TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		`ALTER TABLE text2sql_golden_queries ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`,
		`ALTER TABLE text2sql_golden_queries ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 0`,
		`CREATE TABLE IF NOT EXISTS text2sql_schemas (
				name TEXT PRIMARY KEY,
				team TEXT,
				dialect TEXT,
				schema_text TEXT NOT NULL,
				allowed_tables TEXT,
				is_default INTEGER NOT NULL DEFAULT 0,
				enabled INTEGER NOT NULL DEFAULT 1,
				updated_at TEXT NOT NULL
			)`,
		`ALTER TABLE text2sql_schemas ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
		`ALTER TABLE text2sql_schemas ADD COLUMN collected_at TEXT`,
		`ALTER TABLE text2sql_schemas ADD COLUMN source_fingerprint TEXT`,
		`CREATE TABLE IF NOT EXISTS text2sql_cache (
				cache_key TEXT PRIMARY KEY,
				schema_name TEXT,
				mode TEXT,
				generated_sql TEXT NOT NULL,
				hits INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				expires_at TEXT NOT NULL
			)`,
		`CREATE INDEX IF NOT EXISTS idx_text2sql_cache_expires ON text2sql_cache(expires_at)`,
		`CREATE TABLE IF NOT EXISTS text2sql_business_terms (
				id TEXT PRIMARY KEY,
				schema_name TEXT NOT NULL DEFAULT '*',
				term TEXT NOT NULL,
				mapping TEXT NOT NULL,
				description TEXT,
				updated_at TEXT NOT NULL
			)`,
		`CREATE INDEX IF NOT EXISTS idx_text2sql_business_terms_schema ON text2sql_business_terms(schema_name)`,
		`CREATE TABLE IF NOT EXISTS text2sql_query_logs (
				id TEXT PRIMARY KEY,
				request_id TEXT,
				api_key_id TEXT,
				team TEXT,
				virtual_model TEXT,
				upstream_model TEXT,
				mode TEXT,
				question TEXT,
				generated_sql TEXT,
				valid INTEGER NOT NULL DEFAULT 0,
				reject_reason TEXT,
				executed INTEGER NOT NULL DEFAULT 0,
				row_count INTEGER NOT NULL DEFAULT 0,
				error TEXT,
				cost_krw REAL NOT NULL DEFAULT 0,
				latency_ms INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL
			)`,
		`CREATE INDEX IF NOT EXISTS idx_text2sql_query_logs_created_at ON text2sql_query_logs(created_at)`,
		`ALTER TABLE text2sql_query_logs ADD COLUMN failure_category TEXT`,
		`ALTER TABLE text2sql_query_logs ADD COLUMN explain_cost REAL NOT NULL DEFAULT 0`,
		`ALTER TABLE text2sql_query_logs ADD COLUMN explain_risk INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE text2sql_query_logs ADD COLUMN schema_name TEXT`,
		`ALTER TABLE text2sql_query_logs ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE text2sql_query_logs ADD COLUMN permission_hash TEXT`,
		`ALTER TABLE text2sql_query_logs ADD COLUMN glossary_hash TEXT`,
		`ALTER TABLE text2sql_query_logs ADD COLUMN generation_cost REAL NOT NULL DEFAULT 0`,
		`ALTER TABLE text2sql_query_logs ADD COLUMN summary_cost REAL NOT NULL DEFAULT 0`,
		`CREATE TABLE IF NOT EXISTS clickhouse_sink_state (
				dimension TEXT PRIMARY KEY,
				last_synced_day TEXT,
				last_success_at TEXT,
				rows_sent INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT
			)`,
		`CREATE TABLE IF NOT EXISTS clickhouse_sink_retry (
				dimension TEXT PRIMARY KEY,
				since_day TEXT,
				error TEXT,
				attempts INTEGER NOT NULL DEFAULT 0,
				first_failed_at TEXT,
				last_attempt_at TEXT
			)`,
		`CREATE TABLE IF NOT EXISTS text2sql_replay_bundles (
				id TEXT PRIMARY KEY,
				request_id TEXT,
				schema_name TEXT,
				schema_version INTEGER NOT NULL DEFAULT 0,
				system_prompt TEXT,
				schema_context TEXT,
				glossary_text TEXT,
				permission_snapshot TEXT,
				generated_sql TEXT,
				created_at TEXT NOT NULL
			)`,
		`CREATE INDEX IF NOT EXISTS idx_text2sql_replay_request ON text2sql_replay_bundles(request_id)`,
		`CREATE TABLE IF NOT EXISTS text2sql_feature_flags (
				name TEXT PRIMARY KEY,
				enabled INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT
			)`,
		`CREATE TABLE IF NOT EXISTS text2sql_saved_reports (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				question TEXT,
				sql TEXT,
				schema_name TEXT,
				kind TEXT,
				created_by TEXT,
				created_at TEXT NOT NULL
			)`,
		`ALTER TABLE text2sql_saved_reports ADD COLUMN schedule_interval TEXT`,
		`ALTER TABLE text2sql_saved_reports ADD COLUMN schedule_enabled INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE text2sql_saved_reports ADD COLUMN deliver_mattermost INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE text2sql_saved_reports ADD COLUMN last_run_at TEXT`,
		`CREATE TABLE IF NOT EXISTS chat_semantic_cache (
				id TEXT PRIMARY KEY,
				model TEXT NOT NULL,
				embedding TEXT NOT NULL,
				content_type TEXT,
				body BLOB,
				created_at TEXT NOT NULL,
				expires_at TEXT
			)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_semantic_model ON chat_semantic_cache(model, created_at)`,
		`CREATE TABLE IF NOT EXISTS model_pricing_versions (
				id TEXT PRIMARY KEY,
				model TEXT NOT NULL,
				input_krw_per_1m REAL NOT NULL DEFAULT 0,
				output_krw_per_1m REAL NOT NULL DEFAULT 0,
				cached_input_krw_per_1m REAL NOT NULL DEFAULT 0,
				source TEXT,
				note TEXT,
				created_at TEXT NOT NULL
			)`,
		`CREATE INDEX IF NOT EXISTS idx_model_pricing_versions_model ON model_pricing_versions(model, created_at)`,
		`CREATE TABLE IF NOT EXISTS analytics_daily (
				day TEXT NOT NULL,
				dimension TEXT NOT NULL,
				dim_value TEXT NOT NULL,
				requests INTEGER NOT NULL DEFAULT 0,
				tokens INTEGER NOT NULL DEFAULT 0,
				cost_krw REAL NOT NULL DEFAULT 0,
				errors INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (day, dimension, dim_value)
			)`,
		`CREATE INDEX IF NOT EXISTS idx_analytics_daily_day ON analytics_daily(day)`,
		`CREATE TABLE IF NOT EXISTS prompt_promotions (
				prompt_name TEXT NOT NULL,
				prompt_version TEXT NOT NULL,
				stage TEXT NOT NULL DEFAULT 'experiment',
				note TEXT,
				promoted_by TEXT,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (prompt_name, prompt_version)
			)`,
		`CREATE TABLE IF NOT EXISTS provider_slos (
				provider TEXT PRIMARY KEY,
				availability_target REAL NOT NULL DEFAULT 0,
				p95_latency_target_ms INTEGER NOT NULL DEFAULT 0,
				error_rate_target REAL NOT NULL DEFAULT 0,
				fallback_rate_target REAL NOT NULL DEFAULT 0,
				enabled INTEGER NOT NULL DEFAULT 1,
				note TEXT,
				updated_at TEXT NOT NULL
			)`,
		`CREATE TABLE IF NOT EXISTS prompt_templates (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				category TEXT NOT NULL DEFAULT 'custom',
				description TEXT,
				body TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 1,
				use_count INTEGER NOT NULL DEFAULT 0,
				last_used_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		// Prompt to Product: a recurring prompt cluster (by fingerprint) promoted into
		// a named, reusable prompt template ("product"), with provenance + a usage
		// snapshot taken at promotion time. The product points at a prompt_templates row.
		`CREATE TABLE IF NOT EXISTS prompt_products (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT,
			category TEXT NOT NULL DEFAULT 'product',
			source_fingerprint TEXT,
			template_id TEXT NOT NULL,
			request_count INTEGER NOT NULL DEFAULT 0,
			distinct_users INTEGER NOT NULL DEFAULT 0,
			created_by TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_prompt_products_fp ON prompt_products(source_fingerprint)`,
		// Personal AI Profile: a per-user summary (model/task/language preferences, cost
		// tendency, reliability) computed from logs. personal_profiles holds the latest
		// computed profile; personal_profile_snapshots keeps point-in-time history.
		`CREATE TABLE IF NOT EXISTS personal_profiles (
			user_id TEXT PRIMARY KEY,
			profile TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS personal_profile_snapshots (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			profile TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_personal_profile_snapshots_user ON personal_profile_snapshots(user_id, created_at)`,
		// My AI Home: per-user self-service recommendations (model switch, template
		// suggestions) generated from the user's own usage. Replaced on each rebuild.
		`CREATE TABLE IF NOT EXISTS personal_recommendations (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			title TEXT NOT NULL,
			detail TEXT,
			est_savings_krw REAL NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_personal_recommendations_user ON personal_recommendations(user_id)`,
		// ref identifies the recommended target (model name / template id) so feedback can
		// be keyed to it across recommendation rebuilds.
		`ALTER TABLE personal_recommendations ADD COLUMN ref TEXT`,
		// Recommendation feedback: records when a user adopts or dismisses a recommendation,
		// for measuring adoption rate.
		`CREATE TABLE IF NOT EXISTS recommendation_feedback (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			ref TEXT,
			title TEXT,
			action TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_recommendation_feedback_kind ON recommendation_feedback(kind, created_at)`,
		// Runtime admin settings: env-bootstrapped defaults overlaid by admin-managed
		// values. Secret values are stored encrypted in value_json (marked is_secret).
		`CREATE TABLE IF NOT EXISTS admin_settings (
			key TEXT PRIMARY KEY,
			category TEXT NOT NULL,
			value_json TEXT NOT NULL,
			value_type TEXT NOT NULL,
			is_secret INTEGER NOT NULL DEFAULT 0,
			source TEXT NOT NULL DEFAULT 'admin',
			version INTEGER NOT NULL DEFAULT 1,
			updated_by TEXT,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS admin_setting_history (
			id TEXT PRIMARY KEY,
			key TEXT NOT NULL,
			old_value_json TEXT,
			new_value_json TEXT,
			is_secret INTEGER NOT NULL DEFAULT 0,
			changed_by TEXT,
			reason TEXT,
			changed_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_admin_setting_history_key ON admin_setting_history(key, changed_at)`,
		// Skills — reusable AI task manuals with metadata, lifecycle status, and policy hints.
		`CREATE TABLE IF NOT EXISTS skills (
			name TEXT PRIMARY KEY,
			description TEXT NOT NULL DEFAULT '',
			version TEXT NOT NULL DEFAULT '0.1.0',
			owner TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'draft',
			risk_level TEXT NOT NULL DEFAULT 'low',
			allowed_models TEXT NOT NULL DEFAULT '',
			allowed_tools TEXT NOT NULL DEFAULT '',
			allowed_teams TEXT NOT NULL DEFAULT '',
			daily_limit INTEGER NOT NULL DEFAULT 0,
			instructions TEXT NOT NULL DEFAULT '',
			metadata TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status)`,
		`ALTER TABLE skills ADD COLUMN allowed_teams TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE skills ADD COLUMN daily_limit INTEGER NOT NULL DEFAULT 0`,
		`CREATE TABLE IF NOT EXISTS skill_runs (
			id TEXT PRIMARY KEY,
			skill_name TEXT NOT NULL,
			skill_version TEXT NOT NULL DEFAULT '',
			actor TEXT NOT NULL DEFAULT '',
			input_hash TEXT NOT NULL DEFAULT '',
			tools_used TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT '',
			cost_krw REAL NOT NULL DEFAULT 0,
			latency_ms INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_skill_runs_name ON skill_runs(skill_name, created_at)`,
		`CREATE TABLE IF NOT EXISTS model_deprecations (
			id TEXT PRIMARY KEY,
			model_glob TEXT NOT NULL,
			replacement TEXT NOT NULL DEFAULT '',
			sunset_date TEXT NOT NULL DEFAULT '',
			message TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS skill_promotions (
			id TEXT PRIMARY KEY,
			skill_name TEXT NOT NULL,
			from_status TEXT NOT NULL DEFAULT '',
			to_status TEXT NOT NULL DEFAULT '',
			from_version TEXT NOT NULL DEFAULT '',
			to_version TEXT NOT NULL DEFAULT '',
			actor TEXT NOT NULL DEFAULT '',
			note TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_skill_promotions_name ON skill_promotions(skill_name, created_at)`,
		// OKF (Open Knowledge Format) — portable knowledge documents + relationship links.
		`CREATE TABLE IF NOT EXISTS okf_documents (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			subject TEXT NOT NULL,
			title TEXT NOT NULL DEFAULT '',
			body TEXT NOT NULL DEFAULT '',
			attributes TEXT NOT NULL DEFAULT '{}',
			tags TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL DEFAULT 'manual',
			status TEXT NOT NULL DEFAULT 'active',
			version INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_okf_documents_kind ON okf_documents(kind, subject)`,
		`CREATE INDEX IF NOT EXISTS idx_okf_documents_status ON okf_documents(status)`,
		`CREATE TABLE IF NOT EXISTS okf_links (
			id TEXT PRIMARY KEY,
			from_subject TEXT NOT NULL,
			relation TEXT NOT NULL,
			to_subject TEXT NOT NULL,
			attributes TEXT NOT NULL DEFAULT '{}',
			source TEXT NOT NULL DEFAULT 'manual',
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_okf_links_from ON okf_links(from_subject)`,
		`CREATE INDEX IF NOT EXISTS idx_okf_links_to ON okf_links(to_subject)`,
		// Failed ClickHouse fact batches, persisted so a ClickHouse outage never loses data
		// and the batch can be replayed (the payload is the JSONEachRow body).
		`CREATE TABLE IF NOT EXISTS clickhouse_fact_retry (
			id TEXT PRIMARY KEY,
			table_name TEXT NOT NULL,
			payload TEXT NOT NULL,
			rows INTEGER NOT NULL DEFAULT 0,
			error TEXT,
			attempts INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_clickhouse_fact_retry_table ON clickhouse_fact_retry(table_name, created_at)`,
		`CREATE TABLE IF NOT EXISTS routing_rules (
			id TEXT PRIMARY KEY,
			enabled INTEGER NOT NULL DEFAULT 1,
			priority INTEGER NOT NULL DEFAULT 100,
			match_pattern TEXT NOT NULL,
			min_complexity INTEGER NOT NULL DEFAULT 0,
			max_complexity INTEGER NOT NULL DEFAULT 100,
			target_model TEXT NOT NULL,
			target_provider TEXT,
			note TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS routing_decisions (
			id TEXT PRIMARY KEY,
			request_id TEXT NOT NULL,
			trace_id TEXT NOT NULL,
			requested_model TEXT,
			selected_model TEXT,
			selected_provider TEXT,
			complexity_score INTEGER NOT NULL DEFAULT 0,
			complexity_tier TEXT,
			prompt_length INTEGER NOT NULL DEFAULT 0,
			token_estimate INTEGER NOT NULL DEFAULT 0,
			code_density REAL NOT NULL DEFAULT 0,
			file_count INTEGER NOT NULL DEFAULT 0,
			conversation_depth INTEGER NOT NULL DEFAULT 0,
			instruction_density REAL NOT NULL DEFAULT 0,
			reasoning_keywords INTEGER NOT NULL DEFAULT 0,
			refactoring_keywords INTEGER NOT NULL DEFAULT 0,
			debugging_keywords INTEGER NOT NULL DEFAULT 0,
			risk_score INTEGER NOT NULL DEFAULT 0,
			risk_tier TEXT,
			risk_categories TEXT,
			health_score INTEGER NOT NULL DEFAULT 0,
			fallback_path TEXT,
			decision_reason TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_routing_decisions_created_at ON routing_decisions(created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_routing_decisions_request_id ON routing_decisions(request_id)`,
		`CREATE TABLE IF NOT EXISTS mcp_tool_catalog (
			server_label TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			is_mcp INTEGER NOT NULL DEFAULT 0,
			first_seen TEXT NOT NULL,
			last_seen TEXT NOT NULL,
			PRIMARY KEY (server_label, tool_name)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_mcp_tool_catalog_first_seen ON mcp_tool_catalog(first_seen)`,
		// Idempotent ALTER for tool argument sensitivity flag
		`ALTER TABLE tool_invocations ADD COLUMN arg_sensitive INTEGER NOT NULL DEFAULT 0`,
		`CREATE TABLE IF NOT EXISTS provider_configs (
			name TEXT PRIMARY KEY,
			base_url TEXT NOT NULL,
			encrypted_api_key TEXT,
			timeout_ms INTEGER NOT NULL,
			enabled INTEGER NOT NULL,
			model_patterns TEXT,
			created_at TEXT NOT NULL
		)`,
		// Idempotent ALTERs for legacy installations of provider_configs
		`ALTER TABLE provider_configs ADD COLUMN model_patterns TEXT`,
		`CREATE TABLE IF NOT EXISTS admin_audit_logs (
			id TEXT PRIMARY KEY,
			admin_id TEXT,
			action TEXT NOT NULL,
			before_value TEXT,
			after_value TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS quotas (
			id TEXT PRIMARY KEY,
			scope TEXT NOT NULL,
			scope_value TEXT NOT NULL,
			period TEXT NOT NULL,
			token_limit INTEGER NOT NULL,
			krw_limit REAL NOT NULL,
			enabled INTEGER NOT NULL,
			note TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_quotas_scope ON quotas(scope, scope_value)`,
		`CREATE INDEX IF NOT EXISTS idx_request_logs_api_key_id ON request_logs(api_key_id)`,
		`CREATE TABLE IF NOT EXISTS runtime_flags (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by TEXT,
			note TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS alert_rules (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			metric TEXT NOT NULL,
			window_seconds INTEGER NOT NULL,
			threshold REAL NOT NULL,
			scope TEXT NOT NULL,
			scope_value TEXT NOT NULL,
			webhook_url TEXT,
			enabled INTEGER NOT NULL,
			note TEXT,
			created_at TEXT NOT NULL,
			last_fired_at TEXT,
			last_value REAL
		)`,
		`CREATE TABLE IF NOT EXISTS alert_events (
			id TEXT PRIMARY KEY,
			rule_id TEXT NOT NULL,
			rule_name TEXT NOT NULL,
			metric TEXT NOT NULL,
			value REAL NOT NULL,
			threshold REAL NOT NULL,
			delivered INTEGER NOT NULL,
			delivery_error TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_alert_events_created_at ON alert_events(created_at)`,
		`CREATE TABLE IF NOT EXISTS embedding_cache (
			cache_key TEXT PRIMARY KEY,
			model TEXT NOT NULL,
			content_type TEXT NOT NULL,
			response_body BLOB NOT NULL,
			hits INTEGER NOT NULL DEFAULT 0,
			byte_size INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			last_hit_at TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_embedding_cache_expires ON embedding_cache(expires_at)`,
		`CREATE TABLE IF NOT EXISTS request_notes (
			request_id TEXT PRIMARY KEY,
			tags TEXT,
			note TEXT,
			created_by TEXT,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_request_notes_tags ON request_notes(tags)`,
		`CREATE TABLE IF NOT EXISTS saved_filters (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			view TEXT NOT NULL,
			params TEXT NOT NULL,
			created_by TEXT,
			created_at TEXT NOT NULL
		)`,
		// Legacy migration: external-key identities used to carry an "ext_" prefix.
		// They now share the "key_" prefix (registration is distinguished by status,
		// not id), so rename existing rows + repoint their logs. Idempotent: after the
		// first run no ext_ rows remain, so these become no-ops.
		`UPDATE request_logs SET api_key_id = 'key_' || substr(api_key_id, 5) WHERE api_key_id LIKE 'ext\_%' ESCAPE '\'`,
		`UPDATE tool_invocations SET api_key_id = 'key_' || substr(api_key_id, 5) WHERE api_key_id LIKE 'ext\_%' ESCAPE '\'`,
		`DELETE FROM api_keys WHERE id LIKE 'ext\_%' ESCAPE '\' AND EXISTS (SELECT 1 FROM api_keys k2 WHERE k2.id = 'key_' || substr(api_keys.id, 5))`,
		`UPDATE api_keys SET id = 'key_' || substr(id, 5) WHERE id LIKE 'ext\_%' ESCAPE '\'`,
		`UPDATE api_keys SET scopes = '["chat:completion","embeddings:create","models:read","mcp:use"]' WHERE status = 'active' AND (scopes IS NULL OR scopes = '' OR scopes = '[]')`,
	}

	for _, statement := range statements {
		execQuery := statement
		if s.dialect == "postgres" {
			// PostgreSQL does not support BLOB; it uses BYTEA instead.
			// Using regex guarantees that any variation of case or spacing is handled properly.
			execQuery = blobRegex.ReplaceAllString(execQuery, "BYTEA")
		}
		if _, err := s.db.ExecContext(ctx, execQuery); err != nil {
			if isAlreadyExistsErr(err) {
				continue
			}
			return err
		}
	}
	return nil
}

// isAlreadyExistsErr swallows the "duplicate column name" / "column already exists"
// errors that ALTER TABLE ADD COLUMN emits when the column was already created on a
// previous run. Both SQLite (modernc.org/sqlite) and pgx surface it with these strings.
func isAlreadyExistsErr(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "duplicate column") ||
		strings.Contains(msg, "already exists") ||
		strings.Contains(msg, "duplicate_column")
}

func (s *SQLStore) ListAPIKeys(ctx context.Context) ([]APIKeyPublic, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, COALESCE(owner, ''), COALESCE(team, ''),
		COALESCE(user_id, ''), COALESCE(service_account_id, ''), COALESCE(role, ''), status,
		COALESCE(scopes, '[]'), COALESCE(allowed_ips, '[]'), COALESCE(allowed_models, '[]'), COALESCE(denied_models, '[]'),
		COALESCE(allowed_providers, '[]'), COALESCE(denied_providers, '[]'), COALESCE(budget_limit_krw, 0),
		COALESCE(expires_at, ''), COALESCE(revoked_at, ''), created_at
		FROM api_keys
		ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []APIKeyPublic
	for rows.Next() {
		var key APIKeyPublic
		var scopes, allowedIPs, allowedModels, deniedModels, allowedProviders, deniedProviders string
		if err := rows.Scan(&key.ID, &key.Name, &key.Owner, &key.Team, &key.UserID, &key.ServiceAccountID, &key.Role, &key.Status,
			&scopes, &allowedIPs, &allowedModels, &deniedModels, &allowedProviders, &deniedProviders, &key.BudgetLimitKRW,
			&key.ExpiresAt, &key.RevokedAt, &key.CreatedAt); err != nil {
			return nil, err
		}
		key.Scopes = decodeStringList(scopes)
		key.AllowedIPs = decodeStringList(allowedIPs)
		key.AllowedModels = decodeStringList(allowedModels)
		key.DeniedModels = decodeStringList(deniedModels)
		key.AllowedProviders = decodeStringList(allowedProviders)
		key.DeniedProviders = decodeStringList(deniedProviders)
		result = append(result, key)
	}
	if result == nil {
		result = []APIKeyPublic{}
	}
	return result, rows.Err()
}

func (s *SQLStore) UpsertAPIKey(ctx context.Context, key APIKeyRecord) error {
	if key.CreatedAt.IsZero() {
		key.CreatedAt = time.Now().UTC()
	}
	if key.Status == "" {
		key.Status = "active"
	}
	query := s.bind(`INSERT INTO api_keys (id, name, key_hash, owner, team, user_id, service_account_id, role, status,
			scopes, allowed_ips, allowed_models, denied_models, allowed_providers, denied_providers, budget_limit_krw,
			expires_at, revoked_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			key_hash = excluded.key_hash,
			owner = excluded.owner,
			team = excluded.team,
			user_id = excluded.user_id,
			service_account_id = excluded.service_account_id,
			role = excluded.role,
			status = excluded.status,
			scopes = excluded.scopes,
			allowed_ips = excluded.allowed_ips,
			allowed_models = excluded.allowed_models,
			denied_models = excluded.denied_models,
			allowed_providers = excluded.allowed_providers,
			denied_providers = excluded.denied_providers,
			budget_limit_krw = excluded.budget_limit_krw,
			expires_at = excluded.expires_at,
			revoked_at = excluded.revoked_at`)
	_, err := s.db.ExecContext(ctx, query, key.ID, key.Name, key.KeyHash, key.Owner, key.Team, key.UserID, key.ServiceAccountID, key.Role, key.Status,
		encodeStringList(key.Scopes), encodeStringList(key.AllowedIPs), encodeStringList(key.AllowedModels), encodeStringList(key.DeniedModels),
		encodeStringList(key.AllowedProviders), encodeStringList(key.DeniedProviders), key.BudgetLimitKRW,
		formatOptionalTime(key.ExpiresAt), formatOptionalTime(key.RevokedAt), formatTime(key.CreatedAt))
	return err
}

// EnsureExternalAPIKey inserts a lightweight row for an externally-attributed key
// (status "external") only if one does not already exist. Uses ON CONFLICT DO
// NOTHING so it never clobbers an operator's later edits (name/team/status) on
// restart or repeat traffic.
func (s *SQLStore) EnsureExternalAPIKey(ctx context.Context, key APIKeyRecord) error {
	if key.CreatedAt.IsZero() {
		key.CreatedAt = time.Now().UTC()
	}
	if key.Status == "" {
		key.Status = "external"
	}
	query := s.bind(`INSERT INTO api_keys (id, name, key_hash, owner, team, user_id, service_account_id, role, status,
			scopes, allowed_ips, allowed_models, denied_models, allowed_providers, denied_providers, budget_limit_krw,
			expires_at, revoked_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO NOTHING`)
	_, err := s.db.ExecContext(ctx, query, key.ID, key.Name, key.KeyHash, key.Owner, key.Team, key.UserID, key.ServiceAccountID, key.Role, key.Status,
		encodeStringList(key.Scopes), encodeStringList(key.AllowedIPs), encodeStringList(key.AllowedModels), encodeStringList(key.DeniedModels),
		encodeStringList(key.AllowedProviders), encodeStringList(key.DeniedProviders), key.BudgetLimitKRW,
		formatOptionalTime(key.ExpiresAt), formatOptionalTime(key.RevokedAt), formatTime(key.CreatedAt))
	return err
}

func (s *SQLStore) FindActiveAPIKeyByHash(ctx context.Context, keyHash string) (APIKeyRecord, bool, error) {
	var key APIKeyRecord
	var scopes, allowedIPs, allowedModels, deniedModels, allowedProviders, deniedProviders string
	var createdAt, expiresAt, revokedAt string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, name, key_hash, COALESCE(owner, ''), COALESCE(team, ''),
			COALESCE(user_id, ''), COALESCE(service_account_id, ''), COALESCE(role, ''), status,
			COALESCE(scopes, '[]'), COALESCE(allowed_ips, '[]'), COALESCE(allowed_models, '[]'), COALESCE(denied_models, '[]'),
			COALESCE(allowed_providers, '[]'), COALESCE(denied_providers, '[]'), COALESCE(budget_limit_krw, 0),
			COALESCE(expires_at, ''), COALESCE(revoked_at, ''), created_at
		FROM api_keys
		WHERE key_hash = ? AND status = 'active'`), keyHash).Scan(&key.ID, &key.Name, &key.KeyHash, &key.Owner, &key.Team,
		&key.UserID, &key.ServiceAccountID, &key.Role, &key.Status, &scopes, &allowedIPs, &allowedModels, &deniedModels,
		&allowedProviders, &deniedProviders, &key.BudgetLimitKRW, &expiresAt, &revokedAt, &createdAt)
	if err == sql.ErrNoRows {
		return APIKeyRecord{}, false, nil
	}
	if err != nil {
		return APIKeyRecord{}, false, err
	}
	if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
		key.CreatedAt = parsed
	}
	key.Scopes = decodeStringList(scopes)
	key.AllowedIPs = decodeStringList(allowedIPs)
	key.AllowedModels = decodeStringList(allowedModels)
	key.DeniedModels = decodeStringList(deniedModels)
	key.AllowedProviders = decodeStringList(allowedProviders)
	key.DeniedProviders = decodeStringList(deniedProviders)
	key.ExpiresAt = parseOptionalTime(expiresAt)
	key.RevokedAt = parseOptionalTime(revokedAt)
	return key, true, nil
}

// GetAPIKey fetches a single api_keys row by id (any status), used to apply
// partial metadata/status updates without losing the stored key_hash.
func (s *SQLStore) GetAPIKey(ctx context.Context, id string) (APIKeyRecord, bool, error) {
	var key APIKeyRecord
	var scopes, allowedIPs, allowedModels, deniedModels, allowedProviders, deniedProviders string
	var createdAt, expiresAt, revokedAt string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, name, key_hash, COALESCE(owner, ''), COALESCE(team, ''),
			COALESCE(user_id, ''), COALESCE(service_account_id, ''), COALESCE(role, ''), status,
			COALESCE(scopes, '[]'), COALESCE(allowed_ips, '[]'), COALESCE(allowed_models, '[]'), COALESCE(denied_models, '[]'),
			COALESCE(allowed_providers, '[]'), COALESCE(denied_providers, '[]'), COALESCE(budget_limit_krw, 0),
			COALESCE(expires_at, ''), COALESCE(revoked_at, ''), created_at
		FROM api_keys WHERE id = ?`), id).Scan(&key.ID, &key.Name, &key.KeyHash, &key.Owner, &key.Team,
		&key.UserID, &key.ServiceAccountID, &key.Role, &key.Status, &scopes, &allowedIPs, &allowedModels, &deniedModels,
		&allowedProviders, &deniedProviders, &key.BudgetLimitKRW, &expiresAt, &revokedAt, &createdAt)
	if err == sql.ErrNoRows {
		return APIKeyRecord{}, false, nil
	}
	if err != nil {
		return APIKeyRecord{}, false, err
	}
	if parsed, perr := time.Parse(time.RFC3339Nano, createdAt); perr == nil {
		key.CreatedAt = parsed
	}
	key.Scopes = decodeStringList(scopes)
	key.AllowedIPs = decodeStringList(allowedIPs)
	key.AllowedModels = decodeStringList(allowedModels)
	key.DeniedModels = decodeStringList(deniedModels)
	key.AllowedProviders = decodeStringList(allowedProviders)
	key.DeniedProviders = decodeStringList(deniedProviders)
	key.ExpiresAt = parseOptionalTime(expiresAt)
	key.RevokedAt = parseOptionalTime(revokedAt)
	return key, true, nil
}

func (s *SQLStore) HasActiveAPIKeys(ctx context.Context) (bool, error) {
	var count int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM api_keys WHERE status = 'active'`).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}

// DeleteAPIKey permanently removes an api_keys row (hard delete). Usage history in
// request_logs keeps the id and shows as external afterwards.
func (s *SQLStore) DeleteAPIKey(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM api_keys WHERE id = ?`), id)
	return err
}

func (s *SQLStore) SetAPIKeyStatus(ctx context.Context, id string, status string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE api_keys SET status = ? WHERE id = ?`), status, id)
	return err
}

func (s *SQLStore) UpsertProvider(ctx context.Context, provider ProviderConfig) error {
	if provider.CreatedAt.IsZero() {
		provider.CreatedAt = time.Now().UTC()
	}
	query := s.bind(`INSERT INTO provider_configs (name, base_url, encrypted_api_key, timeout_ms, enabled, model_patterns, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET
			base_url = excluded.base_url,
			encrypted_api_key = excluded.encrypted_api_key,
			timeout_ms = excluded.timeout_ms,
			enabled = excluded.enabled,
			model_patterns = excluded.model_patterns`)
	_, err := s.db.ExecContext(ctx, query, provider.Name, provider.BaseURL, provider.EncryptedAPIKey, provider.TimeoutMS, boolInt(provider.Enabled), provider.ModelPatterns, formatTime(provider.CreatedAt))
	return err
}

func (s *SQLStore) GetProvider(ctx context.Context, name string) (ProviderConfig, bool, error) {
	var provider ProviderConfig
	var enabled int
	var createdAt string
	var modelPatterns sql.NullString
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT name, base_url, COALESCE(encrypted_api_key, ''), timeout_ms, enabled, model_patterns, created_at
		FROM provider_configs
		WHERE name = ?`), name).Scan(&provider.Name, &provider.BaseURL, &provider.EncryptedAPIKey, &provider.TimeoutMS, &enabled, &modelPatterns, &createdAt)
	if err == sql.ErrNoRows {
		return ProviderConfig{}, false, nil
	}
	if err != nil {
		return ProviderConfig{}, false, err
	}
	provider.Enabled = enabled == 1
	provider.ModelPatterns = modelPatterns.String
	if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
		provider.CreatedAt = parsed
	}
	return provider, true, nil
}

func (s *SQLStore) ListProviders(ctx context.Context) ([]ProviderPublic, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT name, base_url, COALESCE(encrypted_api_key, ''), timeout_ms, enabled, COALESCE(model_patterns, ''), created_at
		FROM provider_configs
		ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []ProviderPublic
	for rows.Next() {
		var provider ProviderPublic
		var encryptedAPIKey string
		var enabled int
		if err := rows.Scan(&provider.Name, &provider.BaseURL, &encryptedAPIKey, &provider.TimeoutMS, &enabled, &provider.ModelPatterns, &provider.CreatedAt); err != nil {
			return nil, err
		}
		provider.APIKeyConfigured = encryptedAPIKey != ""
		provider.Enabled = enabled == 1
		result = append(result, provider)
	}
	if result == nil {
		result = []ProviderPublic{}
	}
	return result, rows.Err()
}

// ListProviderConfigs returns the full provider rows (with model_patterns) used by the
// routing layer. Caller is responsible for decrypting api keys via the secret cipher.
func (s *SQLStore) ListProviderConfigs(ctx context.Context) ([]ProviderConfig, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT name, base_url, COALESCE(encrypted_api_key, ''), timeout_ms, enabled, COALESCE(model_patterns, ''), created_at
		FROM provider_configs
		WHERE enabled = 1
		ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []ProviderConfig
	for rows.Next() {
		var p ProviderConfig
		var enabled int
		var createdAt string
		if err := rows.Scan(&p.Name, &p.BaseURL, &p.EncryptedAPIKey, &p.TimeoutMS, &enabled, &p.ModelPatterns, &createdAt); err != nil {
			return nil, err
		}
		p.Enabled = enabled == 1
		if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			p.CreatedAt = parsed
		}
		result = append(result, p)
	}
	return result, rows.Err()
}

// DeleteProvider deletes a provider by name. Returns true if a row was actually deleted.
func (s *SQLStore) DeleteProvider(ctx context.Context, name string) (bool, error) {
	res, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM provider_configs WHERE name = ?`), name)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *SQLStore) InsertAdminAudit(ctx context.Context, log AdminAuditLog) error {
	if log.CreatedAt.IsZero() {
		log.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO admin_audit_logs (id, admin_id, action, before_value, after_value, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`), log.ID, log.AdminID, log.Action, log.BeforeValue, log.AfterValue, formatTime(log.CreatedAt))
	return err
}

func (s *SQLStore) ListAdminAudit(ctx context.Context, limit int) ([]AdminAuditPublic, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, COALESCE(admin_id, ''), action, COALESCE(before_value, ''), COALESCE(after_value, ''), created_at
		FROM admin_audit_logs
		ORDER BY created_at DESC
		LIMIT ?`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []AdminAuditPublic
	for rows.Next() {
		var log AdminAuditPublic
		if err := rows.Scan(&log.ID, &log.AdminID, &log.Action, &log.BeforeValue, &log.AfterValue, &log.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, log)
	}
	if result == nil {
		result = []AdminAuditPublic{}
	}
	return result, rows.Err()
}

func (s *SQLStore) InsertLogRecord(ctx context.Context, record LogRecord) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	req := record.Request
	if req.CreatedAt.IsZero() {
		req.CreatedAt = time.Now().UTC()
	}
	_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO request_logs
		(id, trace_id, api_key_id, client_ip, forwarded_for, user_agent, hostname, model, endpoint, stream, provider, status_code, latency_ms, first_chunk_ms, session_id, prompt_name, prompt_version, prompt_variables_hash, tool_count, error, request_hash, body_raw, replay_of, failover, route_reason, route_detail, complexity, fallback_from, fallback_reason, requested_model, task_type, prompt_fingerprint, repo, branch, project, service, cost_center, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		req.ID, req.TraceID, req.APIKeyID, req.ClientIP, req.ForwardedFor, req.UserAgent, req.Hostname, req.Model, req.Endpoint, boolInt(req.Stream), req.Provider, req.StatusCode, req.LatencyMS, req.FirstChunkMS, req.SessionID, req.PromptName, req.PromptVersion, req.PromptVariablesHash, req.ToolCount, req.Error, req.RequestHash, req.BodyRaw, req.ReplayOf, boolInt(req.Failover), req.RouteReason, req.RouteDetail, req.Complexity, req.FallbackFrom, req.FallbackReason, req.RequestedModel, req.TaskType, req.PromptFingerprint, req.Repo, req.Branch, req.Project, req.Service, req.CostCenter, formatTime(req.CreatedAt))
	if err != nil {
		return err
	}

	for _, prompt := range record.Prompts {
		if prompt.CreatedAt.IsZero() {
			prompt.CreatedAt = req.CreatedAt
		}
		_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO prompt_logs
			(id, request_id, role, content_hash, content_text, redacted_text, language_hint, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
			prompt.ID, prompt.RequestID, prompt.Role, prompt.ContentHash, prompt.ContentText, prompt.RedactedText, prompt.LanguageHint, formatTime(prompt.CreatedAt))
		if err != nil {
			return err
		}
	}

	if record.Response != nil {
		resp := record.Response
		if resp.CreatedAt.IsZero() {
			resp.CreatedAt = req.CreatedAt
		}
		_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO response_logs
			(id, request_id, status_code, finish_reason, response_hash, response_text_optional, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`),
			resp.ID, resp.RequestID, resp.StatusCode, resp.FinishReason, resp.ResponseHash, resp.ResponseTextOptional, formatTime(resp.CreatedAt))
		if err != nil {
			return err
		}
	}

	if record.Usage != nil {
		usage := record.Usage
		if usage.CreatedAt.IsZero() {
			usage.CreatedAt = req.CreatedAt
		}
		_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO token_usage
			(id, request_id, prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens, estimated_cost, currency, source, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
			usage.ID, usage.RequestID, usage.PromptTokens, usage.CompletionTokens, usage.TotalTokens, usage.CachedTokens, usage.ReasoningTokens, usage.EstimatedCost, usage.Currency, usage.Source, formatTime(usage.CreatedAt))
		if err != nil {
			return err
		}
	}

	for _, language := range record.Languages {
		if language.CreatedAt.IsZero() {
			language.CreatedAt = req.CreatedAt
		}
		_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO language_stats
			(id, request_id, language, confidence, evidence, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`),
			language.ID, language.RequestID, language.Language, language.Confidence, language.Evidence, formatTime(language.CreatedAt))
		if err != nil {
			return err
		}
	}

	for _, evaluation := range record.Evaluations {
		if evaluation.CreatedAt.IsZero() {
			evaluation.CreatedAt = req.CreatedAt
		}
		_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO llm_evaluations
			(id, request_id, trace_id, name, category, evaluator, score, label, passed, reason, metadata, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
			evaluation.ID, evaluation.RequestID, evaluation.TraceID, evaluation.Name, evaluation.Category, evaluation.Evaluator, evaluation.Score,
			evaluation.Label, boolInt(evaluation.Passed), evaluation.Reason, evaluation.Metadata, formatTime(evaluation.CreatedAt))
		if err != nil {
			return err
		}
	}

	for _, tool := range record.Tools {
		if tool.CreatedAt.IsZero() {
			tool.CreatedAt = req.CreatedAt
		}
		_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO tool_invocations
			(id, request_id, trace_id, api_key_id, server_label, tool_name, source, is_mcp, is_error, arg_sensitive, arg_hash, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
			tool.ID, tool.RequestID, tool.TraceID, tool.APIKeyID, tool.ServerLabel, tool.ToolName, tool.Source,
			boolInt(tool.IsMCP), boolInt(tool.IsError), boolInt(tool.ArgSensitive), tool.ArgHash, formatTime(tool.CreatedAt))
		if err != nil {
			return err
		}
		// Maintain the per-server tool catalog from declared definitions.
		if tool.Source == "definition" && tool.ToolName != "" {
			server := tool.ServerLabel
			if server == "" {
				server = "(none)"
			}
			ts := formatTime(tool.CreatedAt)
			_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO mcp_tool_catalog (server_label, tool_name, is_mcp, first_seen, last_seen)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(server_label, tool_name) DO UPDATE SET last_seen = excluded.last_seen, is_mcp = excluded.is_mcp`),
				server, tool.ToolName, boolInt(tool.IsMCP), ts, ts)
			if err != nil {
				return err
			}
		}
	}

	if record.Routing != nil {
		routing := *record.Routing
		if routing.ID == "" {
			routing.ID = "route_" + req.ID
		}
		if routing.RequestID == "" {
			routing.RequestID = req.ID
		}
		if routing.TraceID == "" {
			routing.TraceID = req.TraceID
		}
		if routing.CreatedAt.IsZero() {
			routing.CreatedAt = req.CreatedAt
		}
		riskCategories, _ := json.Marshal(routing.Risk.Categories)
		fallbackPath, _ := json.Marshal(routing.FallbackPath)
		_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO routing_decisions
			(id, request_id, trace_id, requested_model, selected_model, selected_provider,
			 complexity_score, complexity_tier, prompt_length, token_estimate, code_density,
			 file_count, conversation_depth, instruction_density, reasoning_keywords,
			 refactoring_keywords, debugging_keywords, risk_score, risk_tier, risk_categories,
			 health_score, fallback_path, decision_reason, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
			routing.ID, routing.RequestID, routing.TraceID, routing.RequestedModel, routing.SelectedModel, routing.SelectedProvider,
			routing.Complexity.Score, routing.Complexity.Tier, routing.Complexity.PromptLength, routing.Complexity.TokenEstimate, routing.Complexity.CodeDensity,
			routing.Complexity.FileCount, routing.Complexity.ConversationDepth, routing.Complexity.InstructionDensity, routing.Complexity.ReasoningKeywords,
			routing.Complexity.RefactoringKeywords, routing.Complexity.DebuggingKeywords, routing.Risk.Score, routing.Risk.Tier, string(riskCategories),
			routing.HealthScore, string(fallbackPath), routing.DecisionReason, formatTime(routing.CreatedAt))
		if err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (s *SQLStore) InsertLLMEvaluations(ctx context.Context, evaluations []LLMEvaluation) error {
	if len(evaluations) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	now := time.Now().UTC()
	for _, evaluation := range evaluations {
		if evaluation.CreatedAt.IsZero() {
			evaluation.CreatedAt = now
		}
		_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO llm_evaluations
			(id, request_id, trace_id, name, category, evaluator, score, label, passed, reason, metadata, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
			evaluation.ID, evaluation.RequestID, evaluation.TraceID, evaluation.Name, evaluation.Category, evaluation.Evaluator, evaluation.Score,
			evaluation.Label, boolInt(evaluation.Passed), evaluation.Reason, evaluation.Metadata, formatTime(evaluation.CreatedAt))
		if err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (s *SQLStore) InsertLLMFeedback(ctx context.Context, feedback LLMFeedback) error {
	if feedback.CreatedAt.IsZero() {
		feedback.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO llm_feedback
		(id, request_id, trace_id, rating, label, comment, source, created_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		feedback.ID, feedback.RequestID, feedback.TraceID, feedback.Rating, feedback.Label, feedback.Comment, feedback.Source, feedback.CreatedBy, formatTime(feedback.CreatedAt))
	return err
}

func (s *SQLStore) Summary(ctx context.Context) (SummaryStats, error) {
	var stats SummaryStats
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(AVG(latency_ms), 0) FROM request_logs`).Scan(&stats.TotalRequests, &stats.AverageLatencyMS)
	if err != nil {
		return stats, err
	}

	err = s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(total_tokens), 0), COALESCE(SUM(estimated_cost), 0) FROM token_usage`).Scan(&stats.TotalTokens, &stats.TotalCostKRW)
	if err != nil {
		return stats, err
	}

	byIP, err := s.grouped(ctx, "client_ip")
	if err != nil {
		return stats, err
	}
	stats.ByIP = byIP

	byModel, err := s.grouped(ctx, "model")
	if err != nil {
		return stats, err
	}
	stats.ByModel = byModel

	byLanguage, err := s.languages(ctx)
	if err != nil {
		return stats, err
	}
	stats.ByLanguage = byLanguage
	if stats.ByIP == nil {
		stats.ByIP = []GroupedStat{}
	}
	if stats.ByModel == nil {
		stats.ByModel = []GroupedStat{}
	}
	if stats.ByLanguage == nil {
		stats.ByLanguage = []LanguageGrouped{}
	}

	byStatus, err := s.statusBreakdown(ctx)
	if err != nil {
		return stats, err
	}
	stats.ByStatus = byStatus

	topUsers, err := s.topUsers(ctx, 5)
	if err != nil {
		return stats, err
	}
	stats.TopUsers = topUsers
	return stats, nil
}

func (s *SQLStore) statusBreakdown(ctx context.Context) ([]StatusBucket, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT status_code, COUNT(*)
		FROM request_logs
		GROUP BY status_code
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	buckets := map[string]int64{}
	for rows.Next() {
		var code int
		var count int64
		if err := rows.Scan(&code, &count); err != nil {
			return nil, err
		}
		buckets[statusClass(code)] += count
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := []StatusBucket{}
	for _, class := range []string{"2xx", "3xx", "4xx", "quota", "5xx"} {
		if v, ok := buckets[class]; ok && v > 0 {
			result = append(result, StatusBucket{Class: class, Requests: v})
		}
	}
	return result, nil
}

func statusClass(code int) string {
	switch {
	case code == 429:
		return "quota"
	case code >= 200 && code < 300:
		return "2xx"
	case code >= 300 && code < 400:
		return "3xx"
	case code >= 400 && code < 500:
		return "4xx"
	case code >= 500:
		return "5xx"
	default:
		return "other"
	}
}

func (s *SQLStore) topUsers(ctx context.Context, limit int) ([]UserSummary, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT k.id, k.name, COALESCE(k.owner, ''), COALESCE(k.team, ''), k.status,
			COALESCE(stat.requests, 0) AS requests,
			COALESCE(stat.tokens, 0) AS tokens,
			COALESCE(stat.cost, 0) AS cost,
			COALESCE(stat.avg_latency, 0) AS avg_latency,
			COALESCE(stat.last_seen, '') AS last_seen
		FROM api_keys k
		LEFT JOIN (
			SELECT r.api_key_id,
				COUNT(r.id) AS requests,
				SUM(COALESCE(t.total_tokens, 0)) AS tokens,
				SUM(COALESCE(t.estimated_cost, 0)) AS cost,
				AVG(r.latency_ms) AS avg_latency,
				MAX(r.created_at) AS last_seen
			FROM request_logs r
			LEFT JOIN token_usage t ON t.request_id = r.id
			GROUP BY r.api_key_id
		) stat ON stat.api_key_id = k.id
		ORDER BY requests DESC
		LIMIT ?
	`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []UserSummary{}
	for rows.Next() {
		var u UserSummary
		if err := rows.Scan(&u.APIKeyID, &u.Name, &u.Owner, &u.Team, &u.Status, &u.Requests, &u.Tokens, &u.CostKRW, &u.AverageLatencyMS, &u.LastSeen); err != nil {
			return nil, err
		}
		if u.Requests > 0 {
			result = append(result, u)
		}
	}
	return result, rows.Err()
}

func (s *SQLStore) RecentRequests(ctx context.Context, filter RequestFilter) ([]RecentRequest, error) {
	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	where := []string{"1=1"}
	args := []any{}
	if filter.IP != "" {
		where = append(where, "COALESCE(NULLIF(r.client_ip, ''), 'unknown') = ?")
		args = append(args, filter.IP)
	}
	if filter.Model != "" {
		where = append(where, "r.model = ?")
		args = append(args, filter.Model)
	}
	if filter.Language != "" {
		where = append(where, "EXISTS (SELECT 1 FROM language_stats ls WHERE ls.request_id = r.id AND ls.language = ?)")
		args = append(args, filter.Language)
	}
	if filter.APIKeyID != "" {
		where = append(where, "r.api_key_id = ?")
		args = append(args, filter.APIKeyID)
	}
	if filter.Team != "" {
		where = append(where, `COALESCE(NULLIF((SELECT k.team FROM api_keys k WHERE k.id = r.api_key_id), ''), 'unassigned') = ?`)
		args = append(args, filter.Team)
	}
	if filter.SessionID != "" {
		where = append(where, "COALESCE(NULLIF(r.session_id, ''), 'no-session') = ?")
		args = append(args, filter.SessionID)
	}
	if filter.PromptName != "" {
		where = append(where, "r.prompt_name = ?")
		args = append(args, filter.PromptName)
	}
	if filter.PromptVersion != "" {
		where = append(where, "r.prompt_version = ?")
		args = append(args, filter.PromptVersion)
	}
	if filter.EvaluationName != "" {
		where = append(where, "EXISTS (SELECT 1 FROM llm_evaluations e WHERE e.request_id = r.id AND e.name = ?)")
		args = append(args, filter.EvaluationName)
	}
	if filter.ToolServer != "" || filter.ToolName != "" || filter.ToolErrorsOnly {
		toolClauses := []string{"ti.request_id = r.id"}
		if filter.ToolServer != "" {
			toolClauses = append(toolClauses, "COALESCE(NULLIF(ti.server_label, ''), '(none)') = ?")
			args = append(args, filter.ToolServer)
		}
		if filter.ToolName != "" {
			toolClauses = append(toolClauses, "ti.tool_name = ?")
			args = append(args, filter.ToolName)
		}
		if filter.ToolErrorsOnly {
			toolClauses = append(toolClauses, "ti.is_error = 1")
		}
		where = append(where, "EXISTS (SELECT 1 FROM tool_invocations ti WHERE "+strings.Join(toolClauses, " AND ")+")")
	}
	args = append(args, limit)

	query := s.bind(`SELECT r.id, r.trace_id, COALESCE(r.api_key_id, ''), COALESCE(r.client_ip, ''), COALESCE(r.forwarded_for, ''),
			COALESCE(r.user_agent, ''), COALESCE(r.model, ''), r.endpoint, r.stream, COALESCE(r.provider, ''),
			r.status_code, r.latency_ms, COALESCE(r.first_chunk_ms, 0),
			COALESCE(r.session_id, ''), COALESCE(r.prompt_name, ''), COALESCE(r.prompt_version, ''),
			COALESCE(r.prompt_variables_hash, ''), COALESCE(r.tool_count, 0), COALESCE(r.error, ''),
			COALESCE(t.prompt_tokens, 0), COALESCE(t.completion_tokens, 0), COALESCE(t.total_tokens, 0),
			COALESCE(t.cached_tokens, 0), COALESCE(t.reasoning_tokens, 0),
			COALESCE(t.estimated_cost, 0), COALESCE(t.currency, ''), COALESCE(t.source, ''),
			COALESCE(resp.finish_reason, ''), r.created_at
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		LEFT JOIN response_logs resp ON resp.request_id = r.id
		WHERE ` + strings.Join(where, " AND ") + `
		ORDER BY r.created_at DESC
		LIMIT ?`)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}

	var result []RecentRequest
	for rows.Next() {
		var item RecentRequest
		var streamInt int
		if err := rows.Scan(&item.ID, &item.TraceID, &item.APIKeyID, &item.ClientIP, &item.ForwardedFor,
			&item.UserAgent, &item.Model, &item.Endpoint, &streamInt, &item.Provider,
			&item.StatusCode, &item.LatencyMS, &item.FirstChunkMS,
			&item.SessionID, &item.PromptName, &item.PromptVersion, &item.PromptVariablesHash, &item.ToolCount, &item.Error,
			&item.PromptTokens, &item.CompletionTokens, &item.TotalTokens,
			&item.CachedTokens, &item.ReasoningTokens,
			&item.EstimatedCost, &item.Currency, &item.TokenSource,
			&item.FinishReason, &item.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		item.Stream = streamInt == 1
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	for i := range result {
		result[i].Languages, err = s.languagesForRequest(ctx, result[i].ID)
		if err != nil {
			return nil, err
		}
		result[i].Prompts, err = s.promptsForRequest(ctx, result[i].ID)
		if err != nil {
			return nil, err
		}
	}
	if result == nil {
		result = []RecentRequest{}
	}
	if err := s.attachNotes(ctx, result); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *SQLStore) attachNotes(ctx context.Context, rows []RecentRequest) error {
	if len(rows) == 0 {
		return nil
	}
	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	notes, err := s.ListRequestNotes(ctx, ids)
	if err != nil {
		return err
	}
	for i := range rows {
		if n, ok := notes[rows[i].ID]; ok {
			rows[i].Tags = n.Tags
			rows[i].Note = n.Note
		}
	}
	return nil
}

func (s *SQLStore) grouped(ctx context.Context, column string) ([]GroupedStat, error) {
	if column != "client_ip" && column != "model" {
		return nil, fmt.Errorf("unsupported group column %q", column)
	}
	query := fmt.Sprintf(`SELECT COALESCE(NULLIF(r.%s, ''), 'unknown') AS key,
			COUNT(r.id) AS requests,
			COALESCE(SUM(t.total_tokens), 0) AS tokens,
			COALESCE(SUM(t.estimated_cost), 0) AS cost,
			COALESCE(AVG(r.latency_ms), 0) AS avg_latency
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		GROUP BY COALESCE(NULLIF(r.%s, ''), 'unknown')
		ORDER BY requests DESC
		LIMIT 50`, column, column)
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []GroupedStat
	for rows.Next() {
		var stat GroupedStat
		if err := rows.Scan(&stat.Key, &stat.Requests, &stat.Tokens, &stat.CostKRW, &stat.AverageLatencyMS); err != nil {
			return nil, err
		}
		result = append(result, stat)
	}
	return result, rows.Err()
}

func (s *SQLStore) languages(ctx context.Context) ([]LanguageGrouped, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT language, COUNT(DISTINCT request_id), COALESCE(AVG(confidence), 0)
		FROM language_stats
		GROUP BY language
		ORDER BY COUNT(DISTINCT request_id) DESC
		LIMIT 50`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []LanguageGrouped
	for rows.Next() {
		var stat LanguageGrouped
		if err := rows.Scan(&stat.Language, &stat.Requests, &stat.AverageConfidence); err != nil {
			return nil, err
		}
		result = append(result, stat)
	}
	return result, rows.Err()
}

func (s *SQLStore) languagesForRequest(ctx context.Context, requestID string) ([]LanguageStat, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, request_id, language, confidence, COALESCE(evidence, ''), created_at
		FROM language_stats
		WHERE request_id = ?
		ORDER BY confidence DESC`), requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []LanguageStat
	for rows.Next() {
		var stat LanguageStat
		var createdAt string
		if err := rows.Scan(&stat.ID, &stat.RequestID, &stat.Language, &stat.Confidence, &stat.Evidence, &createdAt); err != nil {
			return nil, err
		}
		if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			stat.CreatedAt = parsed
		}
		result = append(result, stat)
	}
	return result, rows.Err()
}

func (s *SQLStore) promptsForRequest(ctx context.Context, requestID string) ([]PromptPreview, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT role, COALESCE(redacted_text, ''), COALESCE(language_hint, '')
		FROM prompt_logs
		WHERE request_id = ?
		ORDER BY created_at ASC
		LIMIT 10`), requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []PromptPreview
	for rows.Next() {
		var prompt PromptPreview
		if err := rows.Scan(&prompt.Role, &prompt.RedactedText, &prompt.LanguageHint); err != nil {
			return nil, err
		}
		result = append(result, prompt)
	}
	return result, rows.Err()
}

func (s *SQLStore) bind(query string) string {
	if s.dialect != "postgres" {
		return query
	}
	var builder strings.Builder
	arg := 1
	for _, r := range query {
		if r == '?' {
			builder.WriteString(fmt.Sprintf("$%d", arg))
			arg++
			continue
		}
		builder.WriteRune(r)
	}
	return builder.String()
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}
