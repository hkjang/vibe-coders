package proxy

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"vibe-coders/internal/store"
)

type adminKeyPatchRequest struct {
	Status *string            `json:"status"`
	Name   *string            `json:"name"`
	Owner  *string            `json:"owner"`
	Team   *string            `json:"team"`
	Role   *string            `json:"role"`
	Scopes []string           `json:"scopes"`
	Review keyRotationRequest `json:"-"`
}

var errAdminKeyEditReview = errors.New("invalid key edit review")

// Preserve legacy field/first-value semantics, with an 8 KiB decoding bound for
// all PATCH calls. The review marker may occur last, so even legacy decoding
// must be bounded before allocating the first JSON value. Reviewed calls also
// reject ambiguous fields and require the entire bounded body to be consumed.
func readAdminKeyPatchRequest(w http.ResponseWriter, r *http.Request) (adminKeyPatchRequest, error) {
	var input adminKeyPatchRequest
	body := http.MaxBytesReader(w, r.Body, 8192)
	decoder := json.NewDecoder(body)
	var raw json.RawMessage
	if err := decoder.Decode(&raw); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return input, errAdminKeyEditReview
		}
		return input, err
	}
	if err := json.Unmarshal(raw, &input); err != nil {
		return input, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return input, err
	}
	reviewed := false
	for name := range fields {
		reviewed = reviewed || strings.EqualFold(name, "review")
	}
	if !reviewed {
		return input, nil
	}
	if decoder.InputOffset() > 8192 || !utf8.Valid(raw) {
		return input, errAdminKeyEditReview
	}
	tail, err := io.ReadAll(io.LimitReader(io.MultiReader(decoder.Buffered(), body), 8193-decoder.InputOffset()))
	if err != nil || decoder.InputOffset()+int64(len(tail)) > 8192 || len(bytes.TrimSpace(tail)) != 0 {
		return input, errAdminKeyEditReview
	}
	object := json.NewDecoder(bytes.NewReader(raw))
	if token, err := object.Token(); err != nil || token != json.Delim('{') {
		return input, errAdminKeyEditReview
	}
	seen := make(map[string]bool)
	for object.More() {
		token, err := object.Token()
		name, ok := token.(string)
		if err != nil || !ok || seen[name] {
			return input, errAdminKeyEditReview
		}
		seen[name] = true
		switch name {
		case "status", "name", "owner", "team", "role", "scopes", "review":
		default:
			return input, errAdminKeyEditReview
		}
		if object.Decode(new(json.RawMessage)) != nil {
			return input, errAdminKeyEditReview
		}
	}
	if !seen["review"] {
		return input, errAdminKeyEditReview
	}
	input.Review, err = readKeyReviewRequest(w, &http.Request{Body: io.NopCloser(bytes.NewReader(fields["review"]))}, false)
	if err != nil || input.Review.Reason == "" || input.Review.ExpectedRevision == "" {
		return input, errAdminKeyEditReview
	}
	return input, nil
}

func (s *Server) verifyAdminKeyEditReview(w http.ResponseWriter, r *http.Request, before, after store.APIKeyRecord, review keyRotationRequest) bool {
	if review.ExpectedRevision == "" {
		return true
	}
	revision, err := s.db.APIKeyRevision(r.Context(), before)
	if err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "could not verify key review", "server_error", "key_update_authority_unavailable")
		return false
	}
	if subtle.ConstantTimeCompare([]byte(review.ExpectedRevision), []byte(revision)) != 1 {
		writeOpenAIError(w, http.StatusConflict, "key changed since review", "invalid_request_error", "key_update_conflict")
		return false
	}
	if before.Name == after.Name && before.Owner == after.Owner && before.Team == after.Team && before.Role == after.Role && before.Status == after.Status && slices.Equal(before.Scopes, after.Scopes) {
		writeOpenAIError(w, http.StatusBadRequest, "review contains no changes", "invalid_request_error", "invalid_key_update")
		return false
	}
	return true
}
