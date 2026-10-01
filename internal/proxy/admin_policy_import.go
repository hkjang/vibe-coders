package proxy

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"unicode/utf8"

	"vibe-coders/internal/store"
)

const policyImportMaxBody = 4 << 20
const policyImportMaxDepth = 64

func (s *Server) exportPolicyDocument(w http.ResponseWriter, r *http.Request) {
	policies, err := s.db.ExportPolicies(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "policy export failed", "server_error", "policies_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": 1, "count": len(policies), "policies": policies})
}

func (s *Server) importPolicyDocument(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, policyImportMaxBody))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeOpenAIError(w, http.StatusRequestEntityTooLarge, "policy document exceeds the byte limit", "invalid_request_error", "policy_import_too_large")
		} else {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		}
		return
	}
	if !utf8.Valid(data) || validatePolicyImportJSON(data) != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	var payload struct {
		Policies []store.Policy `json:"policies"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	result, err := s.db.ImportPolicies(r.Context(), payload.Policies, r.URL.Query().Get("dry_run") == "1")
	if err != nil {
		var validation *store.PolicyImportValidationError
		if errors.As(err, &validation) {
			writeOpenAIError(w, http.StatusBadRequest, "invalid policy import document", "invalid_request_error", validation.Code)
		} else {
			writeOpenAIError(w, http.StatusInternalServerError, "policy import failed", "server_error", "policy_import_failed")
		}
		return
	}
	if !result.DryRun {
		s.auditAdmin(r, "governance.policy.import", "", auditJSON(map[string]any{"created": result.Created, "updated": result.Updated}))
	}
	writeJSON(w, http.StatusOK, result)
}

// Token validation is bounded by body bytes and container depth. It rejects
// duplicate object keys before typed decoding can silently replace a value.
// Unknown fields retain the existing typed-import behavior; opaque rule maps
// are still decoded with UseNumber, not normalized as the single-policy API.
func validatePolicyImportJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value func(int) error
	value = func(depth int) error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delim, container := token.(json.Delim)
		if !container {
			return nil
		}
		if depth >= policyImportMaxDepth {
			return errors.New("JSON depth exceeded")
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for decoder.More() {
				key, err := decoder.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return errors.New("duplicate or invalid object key")
				}
				seen[name] = true
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		case '[':
			for decoder.More() {
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		default:
			return errors.New("invalid container")
		}
		_, err = decoder.Token()
		return err
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("expected a single JSON document")
	}
	return nil
}
