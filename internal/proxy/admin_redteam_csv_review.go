package proxy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

const probeImportReviewResponseMaxBytes = 32 << 20

func (s *Server) probeImportReviewIdentity(r *http.Request) string {
	if claims, ok := s.currentAccessClaims(r); ok {
		scopes := append([]string{}, claims.Scopes...)
		sort.Strings(scopes)
		binding := struct {
			Subject, Team, Role, Session string
			Scopes                       []string
		}{claims.Subject, claims.TeamID, claims.Role, claims.SessionID, scopes}
		return audit.HashText(auditJSON(binding))
	}
	return adminID(r)
}

func probeImportReviewRevision(r *http.Request, required bool) (string, bool) {
	values := r.Header.Values("If-Match")
	if len(values) == 0 {
		return "", !required
	}
	if len(values) != 1 {
		return "", false
	}
	value := values[0]
	if len(value) != 66 || value[0] != '"' || value[len(value)-1] != '"' {
		return "", false
	}
	revision := value[1 : len(value)-1]
	raw, err := hex.DecodeString(revision)
	return revision, err == nil && len(raw) == 32 && revision == strings.ToLower(revision)
}

func probeImportReviewPage(raw string) (int, int, bool) {
	q, err := url.ParseQuery(raw)
	if err != nil {
		return 0, 0, false
	}
	offset, limit := 0, 50
	for name, values := range q {
		if len(values) != 1 || (name != "offset" && name != "limit") {
			return 0, 0, false
		}
		n, err := strconv.Atoi(values[0])
		if err != nil {
			return 0, 0, false
		}
		if name == "offset" {
			if n < 0 || n > 2*store.RedTeamProbeReviewMaxRows {
				return 0, 0, false
			}
			offset = n
		} else {
			if n < 1 || n > 100 {
				return 0, 0, false
			}
			limit = n
		}
	}
	return offset, limit, true
}

func readProbeImportReviewPlan(w http.ResponseWriter, r *http.Request) (redTeamProbeCSVPlan, string, bool) {
	var empty redTeamProbeCSVPlan
	kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || (kind != "text/csv" && kind != "multipart/form-data") {
		writeOpenAIError(w, 400, "CSV Content-Type is required", "invalid_request_error", "invalid_csv_format")
		return empty, "", false
	}
	raw, err := readRedTeamProbeCSV(w, r)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) || errors.Is(err, multipart.ErrMessageTooLarge) {
			writeOpenAIError(w, 413, "CSV exceeds the 8 MiB file or bounded multipart request limit", "invalid_request_error", "csv_too_large")
		} else {
			writeOpenAIError(w, 400, "cannot read CSV upload", "invalid_request_error", "bad_body")
		}
		return empty, "", false
	}
	if !utf8.Valid(raw) || strings.ContainsRune(string(raw), 0) {
		writeOpenAIError(w, 400, "review requires UTF-8 CSV without NUL characters", "invalid_request_error", "invalid_csv_format")
		return empty, "", false
	}
	plan, err := prepareRedTeamProbeCSVBounded(raw, adminID(r), store.RedTeamProbeReviewMaxRows)
	if err != nil {
		var invalid *redTeamProbeCSVPlanError
		if errors.As(err, &invalid) {
			status := 400
			if invalid.code == "redteam_import_review_limit" {
				status = 413
			}
			writeOpenAIError(w, status, invalid.message, "invalid_request_error", invalid.code)
		} else {
			writeOpenAIError(w, 400, "invalid CSV review input", "invalid_request_error", "invalid_csv_format")
		}
		return empty, "", false
	}
	if len(plan.Content.Cases) == 0 {
		writeOpenAIError(w, 400, "CSV has no eligible prompt rows", "invalid_request_error", "empty_csv")
		return empty, "", false
	}
	hash := sha256.Sum256(raw)
	return plan, hex.EncodeToString(hash[:]), true
}

func writeProbeImportReviewError(w http.ResponseWriter, err error, applying bool) {
	switch {
	case errors.Is(err, store.ErrRedTeamProbeReviewConflict):
		writeOpenAIError(w, 409, "CSV file, account/session or catalogue changed; review again", "invalid_request_error", "redteam_import_review_changed")
	case errors.Is(err, store.ErrRedTeamProbeReviewLimit):
		writeOpenAIError(w, 413, "CSV review exceeds its row or stored-text bounds; split the file", "invalid_request_error", "redteam_import_review_limit")
	default:
		if !applying {
			writeOpenAIError(w, 503, "CSV review is unavailable; reload and review again", "server_error", "redteam_import_review_unavailable")
			return
		}
		code := "redteam_import_save_failed"
		if errors.Is(err, store.ErrRedTeamProbeImportPack) {
			code = "redteam_pack_save_failed"
		}
		if errors.Is(err, store.ErrRedTeamProbeImportCase) {
			code = "redteam_case_save_failed"
		}
		writeOpenAIError(w, 500, "CSV import could not be confirmed; check the current catalogue before retrying", "server_error", code)
	}
}

// The subtree authorizer retains admin:write. Before-content disclosure also
// requires the existing admin:read check; it never uses an app-only permission.
func (s *Server) handleRedTeamProbeCSVReviewed(w http.ResponseWriter, r *http.Request, applying bool) {
	w.Header().Set("Cache-Control", "no-store")
	read := r.Clone(r.Context())
	read.Method = http.MethodGet
	if !s.authorizeAdmin(read) {
		writeOpenAIError(w, 403, "CSV review also requires catalogue read permission", "permission_error", "redteam_import_read_required")
		return
	}
	offset, limit, valid := probeImportReviewPage(r.URL.RawQuery)
	if !valid || (applying && r.URL.RawQuery != "") {
		writeOpenAIError(w, 400, "invalid CSV review page", "invalid_request_error", "invalid_csv_review")
		return
	}
	revision, valid := probeImportReviewRevision(r, applying || offset > 0)
	if !valid {
		writeOpenAIError(w, 400, "a single strong If-Match revision is required", "invalid_request_error", "invalid_csv_review")
		return
	}
	plan, fileSHA, valid := readProbeImportReviewPlan(w, r)
	if !valid {
		return
	}
	identity := s.probeImportReviewIdentity(r)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if applying {
		summary := auditJSON(map[string]any{"packs": len(plan.Content.Packs), "cases": len(plan.Content.Cases), "skipped": len(plan.Skipped), "review_revision": revision, "file_sha256": fileSHA})
		event := store.AdminAuditLog{ID: newID("audit"), AdminID: adminID(r), Action: "redteam.probe.import", AfterValue: summary}
		if err := s.db.ImportRedTeamProbeContentReviewed(ctx, plan.Content, fileSHA, identity, revision, event); err != nil {
			writeProbeImportReviewError(w, err, true)
			return
		}
		s.runAdminPostChange(r, event.Action, "", summary, "")
		writeJSON(w, 200, map[string]any{"review_applied": true, "applied_revision": revision, "imported_cases": len(plan.Content.Cases), "packs_touched": len(plan.Content.Packs), "skipped": plan.Skipped})
		return
	}
	review, err := s.db.ReviewRedTeamProbeImport(ctx, plan.Content, fileSHA, identity)
	if err != nil {
		writeProbeImportReviewError(w, err, false)
		return
	}
	if revision != "" && revision != review.Revision {
		writeProbeImportReviewError(w, store.ErrRedTeamProbeReviewConflict, false)
		return
	}
	if offset > len(review.Changes) {
		writeOpenAIError(w, 400, "CSV review page is out of range", "invalid_request_error", "invalid_csv_review")
		return
	}
	end := offset + limit
	if end > len(review.Changes) {
		end = len(review.Changes)
	}
	counts := map[string]int{"created": 0, "updated": 0, "unchanged": 0}
	for _, change := range review.Changes {
		switch change.Action {
		case "create":
			counts["created"]++
		case "update":
			counts["updated"]++
		default:
			counts["unchanged"]++
		}
	}
	response := map[string]any{"review_supported": true, "revision": review.Revision, "file_sha256": fileSHA, "imported_cases": len(plan.Content.Cases), "packs_touched": len(plan.Content.Packs), "skipped": plan.Skipped, "counts": counts, "total_items": len(review.Changes), "offset": offset, "limit": limit, "has_more": end < len(review.Changes), "changes": review.Changes[offset:end]}
	encoded, err := json.Marshal(response)
	if err != nil {
		writeProbeImportReviewError(w, err, false)
		return
	}
	if len(encoded) > probeImportReviewResponseMaxBytes {
		writeProbeImportReviewError(w, store.ErrRedTeamProbeReviewLimit, false)
		return
	}
	w.Header().Set("ETag", "\""+review.Revision+"\"")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(encoded)
}
