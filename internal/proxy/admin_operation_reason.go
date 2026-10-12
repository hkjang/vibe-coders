package proxy

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

var errOperationReason = errors.New("invalid operation reason")

// Empty bodies and {} remain valid for the unchanged legacy console. If a
// reason is supplied, it must be a bounded, nonempty string. Never return raw
// input or parser/database details in an operation error response.
func readOperationReason(w http.ResponseWriter, r *http.Request) (string, error) {
	if r.Body == nil {
		return "", nil
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
	if err != nil || !utf8.Valid(raw) {
		return "", errOperationReason
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return "", nil
	}
	var input *struct {
		Reason json.RawMessage `json:"reason"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || input == nil || decoder.Decode(new(any)) != io.EOF {
		return "", errOperationReason
	}
	if input.Reason == nil {
		return "", nil
	}
	var reason string
	if bytes.Equal(bytes.TrimSpace(input.Reason), []byte("null")) || json.Unmarshal(input.Reason, &reason) != nil {
		return "", errOperationReason
	}
	reason = strings.TrimSpace(reason)
	if reason == "" || utf8.RuneCountInString(reason) > 1024 {
		return "", errOperationReason
	}
	return reason, nil
}
