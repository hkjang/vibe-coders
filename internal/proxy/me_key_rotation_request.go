package proxy

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

type keyRotationRequest struct {
	Reason           string
	ExpectedRevision string
	GraceSeconds     int
}

var errKeyRotationRequest = errors.New("invalid key rotation request")

// An absent body or {} preserves the legacy immediate-rotation contract. New
// reviewed operations bind reason and grace to one exact browser snapshot.
func readKeyRotationRequest(w http.ResponseWriter, r *http.Request) (keyRotationRequest, error) {
	return readKeyReviewRequest(w, r, true)
}

func readKeyReviewRequest(w http.ResponseWriter, r *http.Request, allowGrace bool) (keyRotationRequest, error) {
	var input keyRotationRequest
	if r.Body == nil {
		return input, nil
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
	if err != nil || !utf8.Valid(raw) {
		return input, errKeyRotationRequest
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return input, nil
	}
	// Legacy administrator revocation clients also encode an absent payload as
	// JSON null. Preserve that no-review contract without relaxing rotation or
	// the validation of fields in a reviewed revocation object.
	if !allowGrace && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return input, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return input, errKeyRotationRequest
	}
	seen := make(map[string]bool)
	for decoder.More() {
		token, err := decoder.Token()
		name, ok := token.(string)
		if err != nil || !ok || seen[name] {
			return input, errKeyRotationRequest
		}
		seen[name] = true
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return input, errKeyRotationRequest
		}
		switch name {
		case "reason":
			if json.Unmarshal(value, &input.Reason) != nil {
				return input, errKeyRotationRequest
			}
			input.Reason = strings.TrimSpace(input.Reason)
			if input.Reason == "" || utf8.RuneCountInString(input.Reason) > 1024 {
				return input, errKeyRotationRequest
			}
		case "expected_revision":
			if json.Unmarshal(value, &input.ExpectedRevision) != nil || len(input.ExpectedRevision) != 64 || strings.ToLower(input.ExpectedRevision) != input.ExpectedRevision {
				return input, errKeyRotationRequest
			}
			if _, err := hex.DecodeString(input.ExpectedRevision); err != nil {
				return input, errKeyRotationRequest
			}
		case "grace_seconds":
			if !allowGrace || json.Unmarshal(value, &input.GraceSeconds) != nil || input.GraceSeconds < 0 || input.GraceSeconds > 86400 {
				return input, errKeyRotationRequest
			}
		default:
			return input, errKeyRotationRequest
		}
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') || decoder.Decode(new(any)) != io.EOF {
		return input, errKeyRotationRequest
	}
	if (seen["grace_seconds"] || seen["expected_revision"] || !allowGrace && len(seen) > 0) && (input.ExpectedRevision == "" || input.Reason == "") {
		return input, errKeyRotationRequest
	}
	return input, nil
}
