package proxy

import (
	"net/http"
	"time"
)

// DW rollups have UTC Date grain. The explicit upper bound is exclusive at the
// API, but SQL uses the last included day so the maximum ClickHouse Date remains
// selectable without casting its out-of-range successor to Date.
type dwRollupRange struct {
	Since string
	Until string
	last  string
}

func readDWRollupRange(w http.ResponseWriter, r *http.Request) (dwRollupRange, bool) {
	query := r.URL.Query()
	since, hasSince := query["since_day"]
	until, hasUntil := query["until_day"]
	if !hasSince && !hasUntil {
		start, _ := dwSinceDate(r)
		return dwRollupRange{Since: start}, true
	}
	invalid := func() (dwRollupRange, bool) {
		writeOpenAIError(w, http.StatusBadRequest, "since_day and until_day must define a valid UTC date range of 1 to 90 days", "invalid_request_error", "invalid_dw_date_range")
		return dwRollupRange{}, false
	}
	if len(since) != 1 || len(until) != 1 {
		return invalid()
	}
	start, startErr := time.Parse(time.DateOnly, since[0])
	end, endErr := time.Parse(time.DateOnly, until[0])
	if startErr != nil || endErr != nil || start.Format(time.DateOnly) != since[0] || end.Format(time.DateOnly) != until[0] {
		return invalid()
	}
	// https://clickhouse.com/docs/reference/data-types/date
	if since[0] < "1970-01-01" || until[0] > "2149-06-07" || !end.After(start) || end.Sub(start) > 90*24*time.Hour {
		return invalid()
	}
	return dwRollupRange{Since: since[0], Until: until[0], last: end.AddDate(0, 0, -1).Format(time.DateOnly)}, true
}

func (bounds dwRollupRange) clause() string {
	clause := "day >= '" + bounds.Since + "'"
	if bounds.Until != "" {
		clause += " AND day <= '" + bounds.last + "'"
	}
	return clause
}
