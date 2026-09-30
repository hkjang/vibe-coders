package proxy

import (
	"errors"
	"math"

	"vibe-coders/internal/store"
)

var costGuardFlagKeys = []string{"cost_guard_enabled", "cost_guard_threshold_krw"}

var errInvalidCostGuardConfig = errors.New("invalid stored cost guard configuration")

// costGuardConfig is a confirmed persisted snapshot, not the cached runtime view.
// Missing flags have the established false/zero defaults; malformed flags do not.
type costGuardConfig struct {
	Enabled      bool    `json:"enabled"`
	ThresholdKRW float64 `json:"threshold_krw"`
}

func costGuardConfigFromFlags(flags map[string]store.RuntimeFlag) (costGuardConfig, error) {
	var config costGuardConfig
	if flag, found := flags["cost_guard_enabled"]; found {
		switch flag.Value {
		case "true", "1":
			config.Enabled = true
		case "false", "0":
		default:
			return costGuardConfig{}, errInvalidCostGuardConfig
		}
	}
	if flag, found := flags["cost_guard_threshold_krw"]; found {
		value, err := parseFloat(flag.Value)
		if err != nil || !validCostGuardThreshold(value) {
			return costGuardConfig{}, errInvalidCostGuardConfig
		}
		config.ThresholdKRW = value
	}
	return config, nil
}

func validCostGuardThreshold(value float64) bool {
	return value >= 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}
