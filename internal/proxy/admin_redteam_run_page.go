package proxy

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"vibe-coders/internal/store"
)

type redTeamRunPageResponse struct {
	Runs        []store.RedTeamRun `json:"runs"`
	Total       int                `json:"total"`
	Limit       int                `json:"limit"`
	Offset      int                `json:"offset"`
	GeneratedAt time.Time          `json:"generated_at"`
}

// Extends the existing authenticated GET /admin/redteam/runs with view=page.
// No result/evidence text is selected, and query values never enter audit logs.
func (s *Server) writeRedTeamRunPage(w http.ResponseWriter, r *http.Request, values url.Values) {
	w.Header().Set("Cache-Control", "no-store")
	query := store.RedTeamRunQuery{Limit: 25}
	valid := values.Get("view") == "page"
	for key, items := range values {
		if len(items) != 1 {
			valid = false
			continue
		}
		value := items[0]
		switch key {
		case "view":
		case "limit", "offset":
			n, err := strconv.Atoi(value)
			if err != nil || strconv.Itoa(n) != value {
				valid = false
				continue
			}
			if key == "limit" {
				query.Limit = n
			} else {
				query.Offset = n
			}
		case "status":
			query.Status = value
		case "mode":
			query.Mode = value
		case "kind":
			query.Kind = value
		case "sort":
			query.Sort = value
		case "run_id":
			query.RunID = value
		case "campaign_id":
			query.CampaignID = value
		case "source_result_id":
			query.SourceResultID = value
		case "review_id":
			query.ReviewID = value
		case "from", "to":
			stamp, err := time.Parse(time.RFC3339Nano, value)
			if err != nil || stamp.IsZero() {
				valid = false
				continue
			}
			if key == "from" {
				query.From = stamp.UTC()
			} else {
				query.To = stamp.UTC()
			}
		default:
			valid = false
		}
	}
	for _, id := range []string{query.RunID, query.CampaignID, query.SourceResultID, query.ReviewID} {
		if id != "" && (!store.ValidRedTeamRunRef(id) || !s.safeResourceSearchText(id)) {
			valid = false
		}
	}
	if !valid {
		writeOpenAIError(w, 400, "실행 이력 조회 조건을 확인하세요.", "invalid_request_error", "redteam_run_page_invalid")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	rows, total, err := s.db.RedTeamRunPage(ctx, query)
	if errors.Is(err, store.ErrRedTeamRunPage) {
		writeOpenAIError(w, 400, "실행 이력 조회 조건을 확인하세요.", "invalid_request_error", "redteam_run_page_invalid")
		return
	}
	if err != nil {
		writeOpenAIError(w, 503, "실행 이력을 확인하지 못했습니다.", "server_error", "redteam_run_page_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, redTeamRunPageResponse{rows, total, query.Limit, query.Offset, time.Now().UTC()})
}
