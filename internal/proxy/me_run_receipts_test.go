package proxy

import "testing"

func TestRunReceiptID(t *testing.T) {
	cases := []struct {
		path, prefix, want string
		ok                 bool
	}{
		{"/v1/app-runs/apprun_1/receipt", "/v1/app-runs/", "apprun_1", true},
		{"/v1/workflow-runs/wfrun_9/receipt", "/v1/workflow-runs/", "wfrun_9", true},
		{"/v1/app-runs/apprun_1", "/v1/app-runs/", "", false},        // no /receipt
		{"/v1/app-runs//receipt", "/v1/app-runs/", "", false},         // empty id
		{"/v1/app-runs/apprun_1/run", "/v1/app-runs/", "", false},     // wrong action
	}
	for _, c := range cases {
		got, ok := runReceiptID(c.path, c.prefix)
		if ok != c.ok || got != c.want {
			t.Errorf("runReceiptID(%q) = (%q,%v), want (%q,%v)", c.path, got, ok, c.want, c.ok)
		}
	}
}
