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
type settingDef struct {
	Key      string
	Category string
	Type     settingType
	Secret   bool
	Restart  bool // changing this requires a worker restart / connection swap (informational)
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
	return []settingDef{
		// ---- ClickHouse ----
		{Key: "clickhouse.url", Category: "clickhouse", Type: stString, Restart: true, envValue: func(c config.Config) string { return c.ClickHouse.URL }},
		{Key: "clickhouse.database", Category: "clickhouse", Type: stString, envValue: func(c config.Config) string { return c.ClickHouse.Database }},
		{Key: "clickhouse.table", Category: "clickhouse", Type: stString, envValue: func(c config.Config) string { return c.ClickHouse.Table }},
		{Key: "clickhouse.user", Category: "clickhouse", Type: stString, envValue: func(c config.Config) string { return c.ClickHouse.User }},
		{Key: "clickhouse.password", Category: "clickhouse", Type: stString, Secret: true, envValue: func(c config.Config) string { return c.ClickHouse.Password }},
		{Key: "clickhouse.sink_interval", Category: "clickhouse", Type: stDuration, Restart: true, validate: dur, envValue: func(c config.Config) string { return c.ClickHouse.SinkInterval.String() }},
		{Key: "clickhouse.sink_days", Category: "clickhouse", Type: stInt, validate: posInt, envValue: func(c config.Config) string { return strconv.Itoa(c.ClickHouse.SinkDays) }},
		{Key: "clickhouse.text2sql_fact_table", Category: "clickhouse", Type: stString, envValue: func(c config.Config) string { return c.ClickHouse.Text2SQLFactTable }},

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
	}
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
	t2s := s.cfg.Text2SQL
	ch := s.cfg.ClickHouse
	carbon := s.cfg.Carbon
	ins := s.cfg.Insurance
	for _, d := range settingRegistry {
		if _, ok := stored[d.Key]; !ok {
			continue
		}
		val, source := s.effectiveSettingValue(stored, d)
		if source != "admin" {
			continue
		}
		applyRuntimeSetting(&t2s, &ch, &carbon, &ins, d.Key, val)
	}
	s.t2sRuntime.Store(&t2s)
	s.chRuntime.Store(&ch)
	s.carbonRuntime.Store(&carbon)
	s.insRuntime.Store(&ins)

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

func applyRuntimeSetting(t2s *config.Text2SQLConfig, ch *config.ClickHouseConfig, carbon *config.CarbonConfig, ins *config.InsuranceConfig, key, val string) {
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
	}
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
			if plain, err := s.secrets.Decrypt(decoded); err == nil {
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
		items = append(items, s.settingView(stored, d))
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

// applySettingWrite validates, encrypts (if secret), and persists a setting value.
func (s *Server) applySettingWrite(r *http.Request, d settingDef, value, reason string) error {
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
		enc, err := s.secrets.Encrypt(value)
		if err != nil {
			return fmt.Errorf("encrypt secret: %w", err)
		}
		storeValue = enc
	}
	encoded, err := json.Marshal(storeValue)
	if err != nil {
		return err
	}
	if err := s.db.UpsertAdminSetting(r.Context(), store.AdminSetting{
		Key: d.Key, Category: d.Category, ValueJSON: string(encoded), ValueType: string(d.Type), IsSecret: d.Secret, Source: "admin",
	}, adminID(r), reason); err != nil {
		return err
	}
	s.reloadRuntimeConfig(r.Context())
	return nil
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
