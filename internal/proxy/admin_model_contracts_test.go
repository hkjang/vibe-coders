package proxy

import "testing"

func TestEvalMin(t *testing.T) {
	if evalMin("q", 90, 80, true).Status != "pass" {
		t.Error("90>=80 should pass")
	}
	if evalMin("q", 82, 80, true).Status != "warn" {
		t.Error("82 within 5% of 80 should warn")
	}
	if evalMin("q", 70, 80, true).Status != "fail" {
		t.Error("70<80 should fail")
	}
	if evalMin("q", 0, 80, false).Status != "no_data" {
		t.Error("no data should be no_data")
	}
}

func TestEvalMax(t *testing.T) {
	if evalMax("lat", 1000, 3000, true).Status != "pass" {
		t.Error("1000<=3000 should pass")
	}
	if evalMax("lat", 2900, 3000, true).Status != "warn" {
		t.Error("2900 within 5% under 3000 should warn")
	}
	if evalMax("lat", 3500, 3000, true).Status != "fail" {
		t.Error("3500>3000 should fail")
	}
	if evalMax("lat", 0, 3000, false).Status != "no_data" {
		t.Error("no data should be no_data")
	}
}

func TestContractVerdict(t *testing.T) {
	if contractVerdict(nil) != "no_data" {
		t.Error("empty → no_data")
	}
	if contractVerdict([]contractCheck{{Status: "pass"}, {Status: "warn"}}) != "warn" {
		t.Error("pass+warn → warn")
	}
	if contractVerdict([]contractCheck{{Status: "warn"}, {Status: "fail"}}) != "fail" {
		t.Error("any fail → fail")
	}
	if contractVerdict([]contractCheck{{Status: "pass"}, {Status: "no_data"}}) != "no_data" {
		t.Error("pass+no_data → no_data")
	}
	if contractVerdict([]contractCheck{{Status: "pass"}, {Status: "pass"}}) != "pass" {
		t.Error("all pass → pass")
	}
}
