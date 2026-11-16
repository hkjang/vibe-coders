package proxy

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/store"
	"vibe-coders/internal/text2sql"
)

const text2SQLProfileReviewBodyLimit = 16 << 10

type text2SQLProfileReviewInput struct {
	VirtualModel     string `json:"virtual_model"`
	Mode             string `json:"mode"`
	UpstreamModel    string `json:"upstream_model"`
	SummaryModel     string `json:"summary_model"`
	SchemaName       string `json:"schema_name"`
	ExecConnectionID string `json:"exec_connection_id"`
	Enabled          bool   `json:"enabled"`
	ExpectedRevision string `json:"expected_revision"`
	Reason           string `json:"reason"`
}

func writeText2SQLProfileReviewError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrText2SQLProfileConflict):
		writeOpenAIError(w, 409, "검토한 프로필이 변경되었습니다. 입력 내용은 유지하고 최신 프로필을 다시 확인하세요.", "invalid_request_error", "text2sql_profile_conflict")
	case errors.Is(err, store.ErrText2SQLProfileUnchanged):
		writeOpenAIError(w, 400, "변경된 설정이 없습니다.", "invalid_request_error", "text2sql_profile_unchanged")
	default:
		writeOpenAIError(w, 503, "프로필 작업 결과를 확인하지 못했습니다. 현재 설정을 다시 조회하세요.", "server_error", "text2sql_profile_review_unavailable")
	}
}

func invalidText2SQLProfileReview(w http.ResponseWriter) {
	writeOpenAIError(w, 400, "프로필 설정, 검토 기준과 500자 이내 변경 사유를 확인하세요.", "invalid_request_error", "invalid_text2sql_profile_review")
}

func validText2SQLProfileName(name string) bool {
	return text2sql.IsModel(name) && len(name) <= 512 && strings.TrimSpace(name) == name
}

func (s *Server) handleText2SQLProfileReviewSnapshot(w http.ResponseWriter, r *http.Request) {
	q, err := url.ParseQuery(r.URL.RawQuery)
	name := strings.ToLower(strings.TrimSpace(q.Get("virtual_model")))
	if err != nil || len(q) != 2 || len(q["view"]) != 1 || q.Get("view") != "review" || len(q["virtual_model"]) != 1 || !validText2SQLProfileName(name) {
		invalidText2SQLProfileReview(w)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	profile, found, err := s.db.GetText2SQLProfile(ctx, name)
	if err != nil {
		writeText2SQLProfileReviewError(w, err)
		return
	}
	revision := store.Text2SQLProfileAbsentRevision
	var value *store.Text2SQLProfile
	if found {
		revision = profile.Revision
		value = &profile
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{"review_supported": true, "profile": value, "revision": revision})
}

// This new PUT never falls back to legacy POST. Older servers reject the method,
// rather than silently accepting a write without the expected-revision guard.
func (s *Server) handleText2SQLProfileReviewedSave(w http.ResponseWriter, r *http.Request) {
	read := r.Clone(r.Context())
	read.Method = http.MethodGet
	if !s.authorizeAdmin(read) {
		writeOpenAIError(w, 403, "프로필 조회 권한도 필요합니다.", "permission_error", "text2sql_profile_read_required")
		return
	}
	if !s.allowText2SQLSensitiveRead(w, read) {
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, text2SQLProfileReviewBodyLimit))
	var input text2SQLProfileReviewInput
	if err != nil || r.URL.RawQuery != "" || r.URL.Path != "/admin/text2sql/profiles" || !decodeText2SQLProfileReview(raw, &input) {
		invalidText2SQLProfileReview(w)
		return
	}
	input.VirtualModel = strings.ToLower(strings.TrimSpace(input.VirtualModel))
	input.Mode = strings.ToLower(strings.TrimSpace(input.Mode))
	input.Reason = strings.TrimSpace(input.Reason)
	digest, revisionErr := hex.DecodeString(input.ExpectedRevision)
	if !validText2SQLProfileName(input.VirtualModel) || (input.Mode != "preview" && input.Mode != "execute") || input.Reason == "" || utf8.RuneCountInString(input.Reason) > 500 ||
		(input.ExpectedRevision != store.Text2SQLProfileAbsentRevision && (revisionErr != nil || len(digest) != 32 || input.ExpectedRevision != strings.ToLower(input.ExpectedRevision))) {
		invalidText2SQLProfileReview(w)
		return
	}
	p := store.Text2SQLProfile{VirtualModel: input.VirtualModel, Mode: input.Mode, UpstreamModel: strings.TrimSpace(input.UpstreamModel), SummaryModel: strings.TrimSpace(input.SummaryModel), SchemaName: strings.TrimSpace(input.SchemaName), ExecConnectionID: strings.TrimSpace(input.ExecConnectionID), Enabled: input.Enabled}
	for _, field := range []string{p.UpstreamModel, p.SummaryModel, p.SchemaName, p.ExecConnectionID} {
		if len(field) > 512 {
			invalidText2SQLProfileReview(w)
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	before, found, err := s.db.GetText2SQLProfile(ctx, p.VirtualModel)
	if err != nil {
		writeText2SQLProfileReviewError(w, err)
		return
	}
	revision := store.Text2SQLProfileAbsentRevision
	var beforeValue *store.Text2SQLProfile
	if found {
		revision = before.Revision
		beforeValue = &before
	}
	if revision != input.ExpectedRevision {
		writeText2SQLProfileReviewError(w, store.ErrText2SQLProfileConflict)
		return
	}
	audit := store.AdminAuditLog{ID: newID("audit"), AdminID: adminID(r), Action: "text2sql.profile.reviewed_upsert", BeforeValue: auditJSON(beforeValue), AfterValue: auditJSON(map[string]any{"profile": p, "reason": input.Reason, "expected_revision": input.ExpectedRevision})}
	saved, err := s.db.SaveText2SQLProfileReviewed(ctx, p, input.ExpectedRevision, audit)
	if err != nil {
		writeText2SQLProfileReviewError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{"profile": saved})
}

func decodeText2SQLProfileReview(raw []byte, input *text2SQLProfileReviewInput) bool {
	return decodeText2SQLProfileFields(raw, input, []string{"virtual_model", "mode", "upstream_model", "summary_model", "schema_name", "exec_connection_id", "enabled", "expected_revision", "reason"})
}

func decodeText2SQLProfileFields(raw []byte, input any, fields []string) bool {
	if !utf8.Valid(raw) {
		return false
	}
	allowed := make(map[string]bool, len(fields))
	for _, name := range fields {
		allowed[name] = true
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return false
	}
	for decoder.More() {
		token, err := decoder.Token()
		name, ok := token.(string)
		if err != nil || !ok || !allowed[name] {
			return false
		}
		delete(allowed, name)
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return false
		}
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') || len(allowed) != 0 {
		return false
	}
	return decoder.Decode(new(any)) == io.EOF && json.Unmarshal(raw, input) == nil
}
