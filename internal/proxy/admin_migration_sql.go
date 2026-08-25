package proxy

import (
	"net/http"

	"vibe-coders/internal/store"
)

// The migration SQL view.
//
// An operator who has been adding indexes by hand has no way to tell, looking at the
// database, which ones came from the build. The drift report answers that only for
// indexes that disagree; the ones that match are invisible, which is exactly the set the
// question is about. This returns the whole declared schema — every statement Migrate
// applies, in apply order, rendered for this dialect — and marks each declared index with
// what this database has.
//
// Read-only, like the drift report: it displays DDL, it never runs it.

// migrationSQLResponse is what GET /admin/migration-sql returns.
type migrationSQLResponse struct {
	store.MigrationSQLReport
	// IndexStatus maps a declared index name to "present", "missing" or "mismatched".
	// Empty when the live read failed.
	IndexStatus map[string]string `json:"index_status"`
	// IndexDetail carries the drift explanation for the names that are not "present", so
	// a reader does not have to open the drift report to find out what differs.
	IndexDetail map[string]string `json:"index_detail,omitempty"`
	// LiveOnly is the indexes this database has that the build does not declare — the
	// hand-added ones. A fresh install will not have them.
	LiveOnly []store.IndexInfo `json:"live_only_indexes"`
	// LiveError explains why the comparison is absent. The declared schema is still
	// returned: it describes the build, and answering that does not need the database.
	LiveError string `json:"live_error,omitempty"`
}

// handleMigrationSQL returns the declared schema, annotated with what this database has.
// GET /admin/migration-sql
func (s *Server) handleMigrationSQL(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}

	resp := migrationSQLResponse{MigrationSQLReport: s.db.MigrationSQL()}

	drift, err := s.db.IndexDrift(r.Context())
	if err != nil {
		resp.LiveError = err.Error()
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.IndexStatus, resp.IndexDetail, resp.LiveOnly = annotateDeclaredIndexes(resp.Statements, drift)
	writeJSON(w, http.StatusOK, resp)
}

// annotateDeclaredIndexes joins the declared statements to the drift report by index name.
// Every declared index starts as "present" and is downgraded by a drift item, so an index
// that matches is reported as matching rather than as absent from the drift list — the
// distinction the caller cares about.
func annotateDeclaredIndexes(statements []store.MigrationStatement, drift store.IndexDriftReport) (
	status map[string]string, detail map[string]string, liveOnly []store.IndexInfo) {

	status = map[string]string{}
	for _, st := range statements {
		if st.Kind == "create_index" && st.Name != "" {
			status[st.Name] = "present"
		}
	}
	detail = map[string]string{}
	liveOnly = []store.IndexInfo{}
	for _, it := range drift.Items {
		switch it.Kind {
		case "undeclared":
			if it.Live != nil {
				liveOnly = append(liveOnly, *it.Live)
			}
		case "missing", "mismatched":
			// Only downgrade names the schema actually declares. A drift item naming
			// something else would otherwise invent a row the statement list has no
			// entry for, which the UI would render as a status with nothing attached.
			if _, declared := status[it.Name]; declared {
				status[it.Name] = it.Kind
				detail[it.Name] = it.Detail
			}
		}
	}
	if len(detail) == 0 {
		detail = nil
	}
	return status, detail, liveOnly
}
