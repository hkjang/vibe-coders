package store

import "testing"

// request_logs.error now carries the provider's own words for a failed status. A refused
// request whose message mentions a timeout says nothing about the provider being slow.
func TestTimeoutHealthSignalIgnoresClientErrorText(t *testing.T) {
	for _, tc := range []struct {
		status int
		text   string
		want   bool
	}{
		{400, "upstream_400: invalid value for parameter timeout", false},
		{404, "upstream_404: deadline exceeded is not a model", false},
		{408, "upstream_408: request timeout", true},
		{504, "", true},
		{502, "upstream_timeout", true},
		{200, "context deadline exceeded", true},
		{0, "timeout:alpha->zeta", true},
		{200, "", false},
	} {
		if got := isTimeoutHealthSignal(tc.status, tc.text); got != tc.want {
			t.Errorf("isTimeoutHealthSignal(%d, %q) = %v, want %v", tc.status, tc.text, got, tc.want)
		}
	}
}
