package proxy

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// Runtime settings of work intelligence (docs/WORK_INTELLIGENCE_DESIGN.md,
// section 6). They follow the self-contained module pattern of tracking.go:
// the definitions, the Korean help text and the snapshot the rest of the
// feature reads all live here, and a change made on the settings screen takes
// effect on the next reload without a restart.
//
// Each key also has an environment variable of the name shown in its
// description; it supplies the default until an administrator overrides it.

const (
	workIntelCategory = "업무 활용 분석"

	workIntelClassifyEnabledKey   = "work_intel.classify_enabled"
	workIntelAnalyticsEnabledKey  = "work_intel.analytics_enabled"
	workIntelIntervalKey          = "work_intel.interval"
	workIntelBatchSizeKey         = "work_intel.batch_size"
	workIntelBackfillDaysKey      = "work_intel.backfill_days"
	workIntelLLMEnabledKey        = "work_intel.llm_enabled"
	workIntelLLMModelKey          = "work_intel.llm_model"
	workIntelLLMProviderKey       = "work_intel.llm_provider"
	workIntelLLMAllowExternalKey  = "work_intel.llm_allow_external"
	workIntelLLMConcurrencyKey    = "work_intel.llm_concurrency"
	workIntelLLMMaxPerMinuteKey   = "work_intel.llm_max_per_minute"
	workIntelLLMTimeoutKey        = "work_intel.llm_timeout"
	workIntelInsightEnabledKey    = "work_intel.insight_enabled"
	workIntelInsightIntervalKey   = "work_intel.insight_interval"
	workIntelInsightLLMEnabledKey = "work_intel.insight_llm_enabled"
	workIntelRetentionDaysKey     = "work_intel.retention_days"
)

// workIntelConfig is the runtime snapshot of the settings.
type workIntelConfig struct {
	ClassifyEnabled   bool
	AnalyticsEnabled  bool
	Interval          time.Duration
	BatchSize         int
	BackfillDays      int
	LLMEnabled        bool
	LLMModel          string
	LLMProvider       string
	LLMAllowExternal  bool
	LLMConcurrency    int
	LLMMaxPerMinute   int
	LLMTimeout        time.Duration
	InsightEnabled    bool
	InsightInterval   time.Duration
	InsightLLMEnabled bool
	RetentionDays     int
}

// defaultWorkIntelConfig is the design's default: rule classification and
// analytics on, the LLM step off.
func defaultWorkIntelConfig() workIntelConfig {
	return workIntelConfig{
		ClassifyEnabled:  true,
		AnalyticsEnabled: true,
		Interval:         15 * time.Second,
		BatchSize:        200,
		BackfillDays:     7,
		LLMConcurrency:   2,
		LLMMaxPerMinute:  60,
		LLMTimeout:       20 * time.Second,
		InsightEnabled:   true,
		InsightInterval:  6 * time.Hour,
		RetentionDays:    400,
	}
}

type workIntelSetting struct {
	key, env, fallback string
	kind               settingType
	validate           func(string) error
	description        string
}

func workIntelSettings() []workIntelSetting {
	intRange := func(min, max int) func(string) error {
		return func(value string) error {
			n, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil || n < min || n > max {
				return fmt.Errorf("must be an integer between %d and %d", min, max)
			}
			return nil
		}
	}
	durationRange := func(min, max time.Duration) func(string) error {
		return func(value string) error {
			d, err := time.ParseDuration(strings.TrimSpace(value))
			if err != nil || d < min || d > max {
				return fmt.Errorf("must be a duration between %s and %s", min, max)
			}
			return nil
		}
	}
	label := func(max int) func(string) error {
		return func(value string) error {
			if len(value) > max || strings.ContainsAny(value, "\r\n\x00") {
				return fmt.Errorf("must be a single line of at most %d bytes", max)
			}
			return nil
		}
	}
	def := defaultWorkIntelConfig()
	return []workIntelSetting{
		{workIntelClassifyEnabledKey, "WORK_INTEL_CLASSIFY_ENABLED", "true", stBool, nil,
			"업무 분류 워커 사용 여부(WORK_INTEL_CLASSIFY_ENABLED). 켜면 요청 로그를 뒤따라가며 업무 유형을 분류하고 집계를 만듭니다. 요청 처리 경로와는 별개로 동작하므로 꺼도 프록시 응답에는 영향이 없습니다. 끄면 새 요청이 분류되지 않고 미처리로 쌓였다가 다시 켤 때 이어서 처리됩니다."},
		{workIntelAnalyticsEnabledKey, "WORK_INTEL_ANALYTICS_ENABLED", "true", stBool, nil,
			"업무 활용 분석 API와 화면 사용 여부(WORK_INTEL_ANALYTICS_ENABLED). 끄면 분석 조회만 막고, 분류 워커와 이미 쌓인 집계는 그대로 둡니다."},
		{workIntelIntervalKey, "WORK_INTEL_INTERVAL", def.Interval.String(), stDuration, durationRange(time.Second, time.Hour),
			"분류 워커 주기(WORK_INTEL_INTERVAL, 기본 15s, 1s~1h). 주기마다 미처리 요청을 한 묶음씩 분류합니다. 짧게 하면 대시보드가 더 빨리 채워지고 DB 조회가 늘어납니다."},
		{workIntelBatchSizeKey, "WORK_INTEL_BATCH_SIZE", strconv.Itoa(def.BatchSize), stInt, intRange(1, store.WorkIntelMaxBatch),
			fmt.Sprintf("주기당 최대 처리 건수(WORK_INTEL_BATCH_SIZE, 기본 200, 1~%d). 한 묶음은 한 트랜잭션으로 반영됩니다. 미처리가 계속 늘면 이 값을 키우거나 주기를 줄이세요.", store.WorkIntelMaxBatch)},
		{workIntelBackfillDaysKey, "WORK_INTEL_BACKFILL_DAYS", strconv.Itoa(def.BackfillDays), stInt, intRange(0, 365),
			"처음 켤 때 과거 며칠 치 요청부터 분류할지(WORK_INTEL_BACKFILL_DAYS, 기본 7, 0~365). 워커가 한 번이라도 돈 뒤에는 바꿔도 시작 위치가 달라지지 않습니다."},
		{workIntelLLMEnabledKey, "WORK_INTEL_LLM_ENABLED", "false", stBool, nil,
			"LLM 의미 분류 사용 여부(WORK_INTEL_LLM_ENABLED). 기본 꺼짐. 켜면 규칙과 캐시로 확정하지 못한 요청만 분류 모델에 묻습니다. 가린 프롬프트 일부와 카테고리 ID 목록이 전송되고 호출 비용이 발생합니다. work_intel.llm_model 이 비어 있으면 호출하지 않습니다."},
		{workIntelLLMModelKey, "WORK_INTEL_LLM_MODEL", "", stString, label(200),
			"분류에 쓰는 모델 이름(WORK_INTEL_LLM_MODEL). 운영 트래픽 모델과 분리해 작고 빠른 모델을 지정하세요. 비어 있으면 LLM 분류를 하지 않습니다."},
		{workIntelLLMProviderKey, "WORK_INTEL_LLM_PROVIDER", "", stString, label(200),
			"분류 모델을 호출할 Provider 이름(WORK_INTEL_LLM_PROVIDER). 비어 있으면 모델 이름으로 Provider를 고르고, 맞는 것이 없으면 기본 Provider를 씁니다."},
		{workIntelLLMAllowExternalKey, "WORK_INTEL_LLM_ALLOW_EXTERNAL", "false", stBool, nil,
			"외부 Provider로 분류 텍스트 전송 허용(WORK_INTEL_LLM_ALLOW_EXTERNAL). 기본 꺼짐. 꺼져 있으면 주소가 루프백·사설망·내부 도메인(.internal, .local, .svc, .cluster.local, 점 없는 이름)인 Provider로만 보내고, 그 밖의 Provider면 호출하지 않고 상태 화면에 사유를 남깁니다."},
		{workIntelLLMConcurrencyKey, "WORK_INTEL_LLM_CONCURRENCY", strconv.Itoa(def.LLMConcurrency), stInt, intRange(1, 16),
			"분류 모델 동시 호출 수(WORK_INTEL_LLM_CONCURRENCY, 기본 2, 1~16)."},
		{workIntelLLMMaxPerMinuteKey, "WORK_INTEL_LLM_MAX_PER_MINUTE", strconv.Itoa(def.LLMMaxPerMinute), stInt, intRange(1, 6000),
			"분당 분류 모델 호출 상한(WORK_INTEL_LLM_MAX_PER_MINUTE, 기본 60, 1~6000). 넘는 요청은 규칙 결과로 저장해 두었다가 다음 주기에 다시 시도합니다."},
		{workIntelLLMTimeoutKey, "WORK_INTEL_LLM_TIMEOUT", def.LLMTimeout.String(), stDuration, durationRange(time.Second, 5*time.Minute),
			"분류 모델 호출 1회의 제한 시간(WORK_INTEL_LLM_TIMEOUT, 기본 20s, 1s~5m). 넘으면 실패로 세고 규칙 결과를 씁니다."},
		{workIntelInsightEnabledKey, "WORK_INTEL_INSIGHT_ENABLED", "true", stBool, nil,
			"트렌드·자동화 후보·인사이트 주기 작업 사용 여부(WORK_INTEL_INSIGHT_ENABLED). 꺼도 오래된 집계 정리는 계속합니다."},
		{workIntelInsightIntervalKey, "WORK_INTEL_INSIGHT_INTERVAL", def.InsightInterval.String(), stDuration, durationRange(time.Minute, 7*24*time.Hour),
			"주기 작업 간격(WORK_INTEL_INSIGHT_INTERVAL, 기본 6h, 1m~168h). 오래된 집계 정리도 이 간격으로 실행됩니다."},
		{workIntelInsightLLMEnabledKey, "WORK_INTEL_INSIGHT_LLM_ENABLED", "false", stBool, nil,
			"인사이트 문장을 LLM으로 다듬을지(WORK_INTEL_INSIGHT_LLM_ENABLED). 기본 꺼짐. 켜도 집계 수치만 전달하고 프롬프트 내용은 보내지 않습니다."},
		{workIntelRetentionDaysKey, "WORK_INTEL_RETENTION_DAYS", strconv.Itoa(def.RetentionDays), stInt, intRange(0, 3650),
			"업무 집계·세션·인사이트 보존 일수(WORK_INTEL_RETENTION_DAYS, 기본 400, 0~3650). 0이면 지우지 않습니다. 요청별 분류 결과는 요청 로그 보존 기간을 따라 함께 지워집니다."},
	}
}

func workIntelEnvDefault(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}

func workIntelSettingDefs() []settingDef {
	settings := workIntelSettings()
	defs := make([]settingDef, 0, len(settings))
	for _, st := range settings {
		env, fallback := st.env, st.fallback
		defs = append(defs, settingDef{
			Key: st.key, Category: workIntelCategory, Type: st.kind, validate: st.validate,
			envValue: func(config.Config) string { return workIntelEnvDefault(env, fallback) },
		})
	}
	return defs
}

func init() {
	for _, st := range workIntelSettings() {
		settingDescriptions[st.key] = st.description
	}
}

// workIntelConf returns the runtime snapshot; the defaults until the first
// settings reload.
func (s *Server) workIntelConf() workIntelConfig {
	if value := s.workIntelRuntime.Load(); value != nil {
		return *value
	}
	return defaultWorkIntelConfig()
}

// reloadWorkIntelRuntime rebuilds the snapshot from the stored settings. A
// value that does not parse or is out of range (an environment variable is
// not validated when it is set) falls back to the default rather than
// stopping the worker.
func (s *Server) reloadWorkIntelRuntime(stored map[string]store.AdminSetting) {
	raw := func(key string) (string, bool) {
		def, ok := settingDefByKey(key)
		if !ok {
			return "", false
		}
		value, _, err := s.effectiveSettingValue(stored, def)
		if err != nil {
			return "", false
		}
		value = strings.TrimSpace(value)
		if def.validate != nil && def.validate(value) != nil {
			return "", false
		}
		return value, true
	}
	boolValue := func(key string, fallback bool) bool {
		if value, ok := raw(key); ok {
			if parsed, err := strconv.ParseBool(value); err == nil {
				return parsed
			}
		}
		return fallback
	}
	intValue := func(key string, fallback int) int {
		if value, ok := raw(key); ok {
			if parsed, err := strconv.Atoi(value); err == nil {
				return parsed
			}
		}
		return fallback
	}
	durationValue := func(key string, fallback time.Duration) time.Duration {
		if value, ok := raw(key); ok {
			if parsed, err := time.ParseDuration(value); err == nil {
				return parsed
			}
		}
		return fallback
	}
	text := func(key string) string {
		value, _ := raw(key)
		return value
	}
	def := defaultWorkIntelConfig()
	conf := workIntelConfig{
		ClassifyEnabled:   boolValue(workIntelClassifyEnabledKey, def.ClassifyEnabled),
		AnalyticsEnabled:  boolValue(workIntelAnalyticsEnabledKey, def.AnalyticsEnabled),
		Interval:          durationValue(workIntelIntervalKey, def.Interval),
		BatchSize:         intValue(workIntelBatchSizeKey, def.BatchSize),
		BackfillDays:      intValue(workIntelBackfillDaysKey, def.BackfillDays),
		LLMEnabled:        boolValue(workIntelLLMEnabledKey, def.LLMEnabled),
		LLMModel:          text(workIntelLLMModelKey),
		LLMProvider:       text(workIntelLLMProviderKey),
		LLMAllowExternal:  boolValue(workIntelLLMAllowExternalKey, def.LLMAllowExternal),
		LLMConcurrency:    intValue(workIntelLLMConcurrencyKey, def.LLMConcurrency),
		LLMMaxPerMinute:   intValue(workIntelLLMMaxPerMinuteKey, def.LLMMaxPerMinute),
		LLMTimeout:        durationValue(workIntelLLMTimeoutKey, def.LLMTimeout),
		InsightEnabled:    boolValue(workIntelInsightEnabledKey, def.InsightEnabled),
		InsightInterval:   durationValue(workIntelInsightIntervalKey, def.InsightInterval),
		InsightLLMEnabled: boolValue(workIntelInsightLLMEnabledKey, def.InsightLLMEnabled),
		RetentionDays:     intValue(workIntelRetentionDaysKey, def.RetentionDays),
	}
	s.workIntelRuntime.Store(&conf)
}
