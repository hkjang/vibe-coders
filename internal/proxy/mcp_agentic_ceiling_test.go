package proxy

import "testing"

// Every step of the agentic loop is an LLM turn that may issue several tool calls, so the
// step count is what a run costs. The rule that decides it was inline in the loop and had
// no test: a route could be given a few hundred steps and the only sign would be the bill.
func TestTheAgenticStepCeiling(t *testing.T) {
	cases := []struct {
		name       string
		configured int
		routeSteps int
		want       int
	}{
		{"the gateway setting stands when the route sets nothing", 4, 0, 4},
		{"a route override wins over the gateway setting", 4, 10, 10},
		{"a route override below the gateway setting also wins", 12, 3, 3},
		{"no setting anywhere falls back to the default", 0, 0, agenticDefaultSteps},
		{"a route override of zero is no override", 6, 0, 6},
		// The cap is the part no configuration may raise. A route asking for hundreds of
		// turns gets the cap, not what it asked for.
		{"the cap holds against a route override", 8, 500, agenticMaxSteps},
		{"the cap holds against the gateway setting", 500, 0, agenticMaxSteps},
		{"exactly the cap is allowed", 8, agenticMaxSteps, agenticMaxSteps},
		{"one below the cap is left alone", 8, agenticMaxSteps - 1, agenticMaxSteps - 1},
		// A negative is a misconfiguration, and "no steps" would make the loop do nothing
		// rather than fail loudly, so it falls back like an unset value.
		{"a negative setting falls back to the default", -1, 0, agenticDefaultSteps},
		{"a negative route override is no override", 5, -3, 5},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := agenticStepCeiling(tc.configured, tc.routeSteps); got != tc.want {
				t.Fatalf("agenticStepCeiling(%d, %d) = %d, want %d",
					tc.configured, tc.routeSteps, got, tc.want)
			}
		})
	}

	// Whatever is asked for, the answer is a usable number of turns: never zero, which
	// would run no turns at all, and never above the cap.
	for configured := -5; configured <= 40; configured++ {
		for route := -5; route <= 40; route++ {
			got := agenticStepCeiling(configured, route)
			if got < 1 || got > agenticMaxSteps {
				t.Fatalf("agenticStepCeiling(%d, %d) = %d, outside 1..%d",
					configured, route, got, agenticMaxSteps)
			}
		}
	}
}
