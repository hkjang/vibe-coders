package proxy

import (
	"os"
	"testing"

	"vibe-coders/internal/config"
)

// A request body is read into memory before anything else looks at it, so without a bound
// io.ReadAll grows to whatever a client sends and one request can take the gateway's
// memory with it. The default is what protects an install nobody has configured.
func TestTheRequestBodyLimitHasADefault(t *testing.T) {
	for _, key := range []string{"LIMITS_MAX_REQUEST_BYTES"} {
		if old, ok := os.LookupEnv(key); ok {
			os.Unsetenv(key)
			t.Cleanup(func() { os.Setenv(key, old) })
		}
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Limits.MaxRequestBytes <= 0 {
		t.Fatal("the request body limit defaults to unlimited; a single client can read the " +
			"gateway out of memory before any check runs")
	}
	// High enough that no realistic agent turn reaches it. A limit small enough to refuse
	// ordinary traffic would be worse than none, because it fails requests that used to work.
	if cfg.Limits.MaxRequestBytes < 16<<20 {
		t.Fatalf("the default limit is %d bytes, which is small enough to refuse a large but "+
			"ordinary agent request", cfg.Limits.MaxRequestBytes)
	}

	// Still settable, including back to unlimited for an operator who wants that.
	os.Setenv("LIMITS_MAX_REQUEST_BYTES", "0")
	t.Cleanup(func() { os.Unsetenv("LIMITS_MAX_REQUEST_BYTES") })
	reloaded, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Limits.MaxRequestBytes; got != 0 {
		t.Fatalf("the limit could not be set back to unlimited: got %d", got)
	}
}

// The routing corpus is bounded by its own window rather than the prompt one, and that
// window has to have a default too — the whole point of the setting is that the text does
// not stay for good.
func TestTheDomainExampleWindowHasADefault(t *testing.T) {
	for _, key := range []string{"RETENTION_DOMAIN_EXAMPLE_DAYS", "RETENTION_PROMPT_DAYS"} {
		if old, ok := os.LookupEnv(key); ok {
			os.Unsetenv(key)
			t.Cleanup(func() { os.Setenv(key, old) })
		}
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Retention.DomainExampleDays <= 0 {
		t.Fatal("promoted prompt text is kept indefinitely by default")
	}
	// Longer than the prompt window, or the corpus would be cleared as often as the prompts
	// and domain routing would lose its evidence on that cycle.
	if cfg.Retention.PromptDays > 0 && cfg.Retention.DomainExampleDays <= cfg.Retention.PromptDays {
		t.Fatalf("the corpus window (%d days) is not longer than the prompt window (%d days)",
			cfg.Retention.DomainExampleDays, cfg.Retention.PromptDays)
	}

	os.Setenv("RETENTION_DOMAIN_EXAMPLE_DAYS", "0")
	t.Cleanup(func() { os.Unsetenv("RETENTION_DOMAIN_EXAMPLE_DAYS") })
	reloaded, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Retention.DomainExampleDays; got != 0 {
		t.Fatalf("the window could not be set back to indefinite: got %d", got)
	}
}
