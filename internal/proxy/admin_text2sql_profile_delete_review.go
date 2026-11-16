package proxy

import (
	"context"
	"encoding/hex"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/store"
)

const text2SQLProfileDeleteReviewPath = "/admin/text2sql/profiles/reviewed-delete"

type text2SQLProfileDeleteReviewInput struct {
	VirtualModel     string `json:"virtual_model"`
	Confirmation     string `json:"confirmation"`
	ExpectedRevision string `json:"expected_revision"`
	Reason           string `json:"reason"`
}

// A separate action is intentional: old servers must never interpret a reviewed
// delete request as an unguarded legacy DELETE.
func (s *Server) handleText2SQLProfileReviewedDelete(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.URL.Path != text2SQLProfileDeleteReviewPath {
		writeOpenAIError(w, 404, "삭제 검토 경로를 확인하세요.", "invalid_request_error", "not_found")
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeOpenAIError(w, 405, "POST 요청이 필요합니다.", "invalid_request_error", "method_not_allowed")
		return
	}
	read := r.Clone(r.Context())
	read.Method = http.MethodGet
	if !s.authorizeAdmin(read) {
		writeOpenAIError(w, 403, "프로필 조회 권한도 필요합니다.", "permission_error", "text2sql_profile_read_required")
		return
	}
	if !s.allowText2SQLSensitiveRead(w, read) {
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<10))
	var input text2SQLProfileDeleteReviewInput
	if err != nil || r.URL.RawQuery != "" || !decodeText2SQLProfileFields(raw, &input, []string{"virtual_model", "confirmation", "expected_revision", "reason"}) {
		invalidText2SQLProfileReview(w)
		return
	}
	input.Reason = strings.TrimSpace(input.Reason)
	digest, err := hex.DecodeString(input.ExpectedRevision)
	if !validText2SQLProfileName(input.VirtualModel) || strings.ToLower(input.VirtualModel) != input.VirtualModel || input.Confirmation != input.VirtualModel ||
		input.Reason == "" || utf8.RuneCountInString(input.Reason) > 500 || err != nil || len(digest) != 32 || input.ExpectedRevision != strings.ToLower(input.ExpectedRevision) {
		invalidText2SQLProfileReview(w)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	before, found, err := s.db.GetText2SQLProfile(ctx, input.VirtualModel)
	if err != nil {
		writeText2SQLProfileReviewError(w, err)
		return
	}
	if !found || before.Revision != input.ExpectedRevision {
		writeText2SQLProfileReviewError(w, store.ErrText2SQLProfileConflict)
		return
	}
	audit := store.AdminAuditLog{
		ID: newID("audit"), AdminID: adminID(r), Action: "text2sql.profile.reviewed_delete",
		BeforeValue: auditJSON(before),
		AfterValue:  auditJSON(map[string]any{"virtual_model": input.VirtualModel, "status": "deleted", "reason": input.Reason, "expected_revision": input.ExpectedRevision}),
	}
	if err := s.db.DeleteText2SQLProfileReviewed(ctx, input.VirtualModel, input.ExpectedRevision, audit); err != nil {
		writeText2SQLProfileReviewError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{"virtual_model": input.VirtualModel, "status": "deleted", "reviewed_revision": input.ExpectedRevision})
}
