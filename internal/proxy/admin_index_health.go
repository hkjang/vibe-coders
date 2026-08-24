package proxy

import (
	"net/http"

	"vibe-coders/internal/store"
)

// Index health.
//
// Two questions an operator has no way to answer from the console today:
//
//   - Does this database have the indexes the build declares? A production database
//     drifts — an index gets added by hand to fix a slow query, or dropped, or an older
//     definition survives under a name a later migration reused. CREATE INDEX IF NOT
//     EXISTS matches on the name alone, so that last one leaves the migration reporting
//     success over an index that is wrong.
//   - Are the declared indexes the right ones? That is a separate question, answered by
//     what the database reports about its own access patterns rather than by opinion.
//
// Read-only. Neither half executes DDL: each finding carries the statement that would fix
// it for an operator to review, because an index is a write-path and storage cost and
// deciding whether it is worth paying is not this endpoint's call.

// indexHealthResponse is what GET /admin/index-health returns.
type indexHealthResponse struct {
	Drift  store.IndexDriftReport  `json:"drift"`
	Advice store.IndexAdviceReport `json:"advice"`
	// Summary is the one line an operator reads first.
	Summary indexHealthSummary `json:"summary"`
}

type indexHealthSummary struct {
	InSync      bool   `json:"in_sync"`
	Mismatched  int    `json:"mismatched"`
	Missing     int    `json:"missing"`
	Undeclared  int    `json:"undeclared"`
	AdviceHigh  int    `json:"advice_high"`
	AdviceTotal int    `json:"advice_total"`
	Headline    string `json:"headline"`
}

// handleIndexHealth compares the live indexes against the declared schema and reports what
// the database's own counters say about which indexes are missing or unused.
// GET /admin/index-health
func (s *Server) handleIndexHealth(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()

	drift, err := s.db.IndexDrift(ctx)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "index drift check failed: "+err.Error(),
			"server_error", "index_drift_failed")
		return
	}
	advice, err := s.db.IndexAdvice(ctx)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "index advice failed: "+err.Error(),
			"server_error", "index_advice_failed")
		return
	}

	writeJSON(w, http.StatusOK, indexHealthResponse{
		Drift:   drift,
		Advice:  advice,
		Summary: summarizeIndexHealth(drift, advice),
	})
}

func summarizeIndexHealth(drift store.IndexDriftReport, advice store.IndexAdviceReport) indexHealthSummary {
	sum := indexHealthSummary{InSync: drift.InSync(), AdviceTotal: len(advice.Items)}
	for _, it := range drift.Items {
		switch it.Kind {
		case "mismatched":
			sum.Mismatched++
		case "missing":
			sum.Missing++
		case "undeclared":
			sum.Undeclared++
		}
	}
	for _, a := range advice.Items {
		if a.Severity == "high" {
			sum.AdviceHigh++
		}
	}

	// Worst thing first, so the headline is the thing to act on rather than a tally.
	switch {
	case sum.Mismatched > 0:
		sum.Headline = "an index in this database does not match the definition the build declares; " +
			"the migration reported success without changing it"
	case sum.Missing > 0:
		sum.Headline = "the build declares indexes this database does not have"
	case sum.AdviceHigh > 0:
		sum.Headline = "the database is scanning tables that are large enough for it to hurt"
	case sum.Undeclared > 0:
		sum.Headline = "this database has indexes the build does not declare; a fresh install will not have them"
	case sum.AdviceTotal > 0:
		sum.Headline = "indexes match the declared schema; there are suggestions worth reading"
	default:
		sum.Headline = "indexes match the declared schema and nothing stands out in the access counters"
	}
	return sum
}
