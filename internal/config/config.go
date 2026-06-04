package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddr string
	Upstream   UpstreamConfig
	Database   DatabaseConfig
	Logging    LoggingConfig
	Retention  RetentionConfig
	Cache      CacheConfig
	Auth       AuthConfig
	Secret     SecretConfig
	Pricing    map[string]ModelPrice
}

type UpstreamConfig struct {
	Provider string
	BaseURL  string
	APIKey   string
	Timeout  time.Duration
}

type DatabaseConfig struct {
	Driver string
	DSN    string
}

type LoggingConfig struct {
	RawPrompts       bool
	RawBodies        bool
	ResponseText     bool
	ResponseMaxBytes int
	QueueSize        int
	FallbackPath     string
}

type RetentionConfig struct {
	RequestDays  int
	PromptDays   int
	ResponseDays int
	Interval     time.Duration
}

type CacheConfig struct {
	EmbeddingEnabled  bool
	EmbeddingTTL      time.Duration
	EmbeddingMaxBytes int
}

type AuthConfig struct {
	ProxyAPIKeys     []ProxyAPIKey
	AdminToken       string
	AdminReadonlyToken string
}

type SecretConfig struct {
	GatewaySecret string
}

type ProxyAPIKey struct {
	ID      string
	Name    string
	KeyHash string
	Owner   string
	Team    string
}

type ModelPrice struct {
	InputKRWPer1M        float64 `json:"input_krw_per_1m"`
	OutputKRWPer1M       float64 `json:"output_krw_per_1m"`
	CachedInputKRWPer1M  float64 `json:"cached_input_krw_per_1m"`
}

func Load() (Config, error) {
	cfg := Config{
		ListenAddr: getEnv("LISTEN_ADDR", ":8080"),
		Upstream: UpstreamConfig{
			Provider: getEnv("UPSTREAM_PROVIDER", "openai"),
			BaseURL:  strings.TrimRight(getEnv("UPSTREAM_BASE_URL", "https://api.openai.com"), "/"),
			APIKey:   firstNonEmpty(os.Getenv("UPSTREAM_API_KEY"), os.Getenv("OPENAI_API_KEY")),
			Timeout:  durationEnv("UPSTREAM_TIMEOUT", 10*time.Minute),
		},
		Database: databaseConfig(),
		Logging: LoggingConfig{
			RawPrompts:       boolEnv("LOG_RAW_PROMPTS", false),
			RawBodies:        boolEnv("LOG_RAW_BODIES", false),
			ResponseText:     boolEnv("LOG_RESPONSE_TEXT", false),
			ResponseMaxBytes: intEnv("LOG_RESPONSE_MAX_BYTES", 1<<20),
			QueueSize:        intEnv("LOG_QUEUE_SIZE", 4096),
			FallbackPath:     getEnv("LOG_FALLBACK_PATH", filepath.Join("data", "fallback.ndjson")),
		},
		Retention: RetentionConfig{
			RequestDays:  intEnv("RETENTION_REQUEST_DAYS", 90),
			PromptDays:   intEnv("RETENTION_PROMPT_DAYS", 30),
			ResponseDays: intEnv("RETENTION_RESPONSE_DAYS", 30),
			Interval:     durationEnv("RETENTION_INTERVAL", time.Hour),
		},
		Cache: CacheConfig{
			EmbeddingEnabled:  boolEnv("CACHE_EMBEDDING_ENABLED", true),
			EmbeddingTTL:      durationEnv("CACHE_EMBEDDING_TTL", 24*time.Hour),
			EmbeddingMaxBytes: intEnv("CACHE_EMBEDDING_MAX_BYTES", 1<<20), // 1 MB per entry
		},
		Auth: AuthConfig{
			ProxyAPIKeys:       parseProxyKeys(os.Getenv("PROXY_API_KEYS")),
			AdminToken:         os.Getenv("ADMIN_TOKEN"),
			AdminReadonlyToken: os.Getenv("ADMIN_READONLY_TOKEN"),
		},
		Secret: SecretConfig{
			GatewaySecret: getEnv("GATEWAY_SECRET", "dev-local-insecure-secret-change-me"),
		},
		Pricing: map[string]ModelPrice{},
	}

	if cfg.Upstream.BaseURL == "" {
		return Config{}, fmt.Errorf("UPSTREAM_BASE_URL cannot be empty")
	}
	if cfg.Logging.ResponseMaxBytes < 0 {
		return Config{}, fmt.Errorf("LOG_RESPONSE_MAX_BYTES must be non-negative")
	}
	if cfg.Logging.QueueSize <= 0 {
		return Config{}, fmt.Errorf("LOG_QUEUE_SIZE must be positive")
	}
	if err := json.Unmarshal([]byte(getEnv("MODEL_PRICING_KRW_PER_1M", "{}")), &cfg.Pricing); err != nil {
		return Config{}, fmt.Errorf("parse MODEL_PRICING_KRW_PER_1M: %w", err)
	}

	return cfg, nil
}

func databaseConfig() DatabaseConfig {
	if dsn := firstNonEmpty(os.Getenv("POSTGRES_DSN"), os.Getenv("DATABASE_URL")); strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		return DatabaseConfig{Driver: "postgres", DSN: dsn}
	}

	driver := strings.ToLower(getEnv("DB_DRIVER", "sqlite"))
	if driver == "postgres" || driver == "postgresql" {
		return DatabaseConfig{Driver: "postgres", DSN: firstNonEmpty(os.Getenv("DB_DSN"), os.Getenv("POSTGRES_DSN"), os.Getenv("DATABASE_URL"))}
	}

	return DatabaseConfig{Driver: "sqlite", DSN: getEnv("DB_DSN", filepath.Join("data", "gateway.db"))}
}

func parseProxyKeys(raw string) []ProxyAPIKey {
	if strings.TrimSpace(raw) == "" {
		return nil
	}

	parts := strings.Split(raw, ",")
	keys := make([]ProxyAPIKey, 0, len(parts))
	for i, part := range parts {
		fields := strings.Split(strings.TrimSpace(part), ":")
		if len(fields) == 0 || strings.TrimSpace(fields[0]) == "" {
			continue
		}

		key := fields[0]
		name := fmt.Sprintf("key-%d", i+1)
		owner := ""
		team := ""
		if len(fields) >= 2 {
			name = fields[0]
			key = fields[1]
		}
		if len(fields) >= 3 {
			owner = fields[2]
		}
		if len(fields) >= 4 {
			team = fields[3]
		}
		sum := sha256.Sum256([]byte(key))
		keyHash := hex.EncodeToString(sum[:])
		keys = append(keys, ProxyAPIKey{
			ID:      "key_" + keyHash[:16],
			Name:    name,
			KeyHash: keyHash,
			Owner:   owner,
			Team:    team,
		})
	}
	return keys
}

func getEnv(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func boolEnv(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func intEnv(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err == nil {
		return parsed
	}
	seconds, err := strconv.Atoi(value)
	if err == nil {
		return time.Duration(seconds) * time.Second
	}
	return fallback
}
