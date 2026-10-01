package proxy

import (
	"encoding/json"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"
)

type providerConnectionRequest struct {
	Name, ProviderRef, BaseURL, CredentialMode, APIKey string
	TimeoutMS                                          int
	seen                                               map[string]bool
}

// The probe receives credentials: reject aliases, duplicate/unknown keys, null
// primitives, extra JSON and non-integer timeouts, rather than last-key wins.
func decodeProviderConnectionRequest(decoder *json.Decoder) (providerConnectionRequest, bool) {
	input := providerConnectionRequest{seen: make(map[string]bool, 6)}
	decoder.UseNumber()
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return input, false
	}
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || input.seen[key] {
			return input, false
		}
		input.seen[key] = true
		value, err := decoder.Token()
		if err != nil {
			return input, false
		}
		if key == "timeout_ms" {
			number, ok := value.(json.Number)
			if !ok {
				return input, false
			}
			input.TimeoutMS, err = strconv.Atoi(string(number))
			if err != nil || input.TimeoutMS < 0 || input.TimeoutMS > 600000 {
				return input, false
			}
			continue
		}
		text, ok := value.(string)
		if !ok {
			return input, false
		}
		switch key {
		case "name":
			input.Name = text
		case "provider_ref":
			input.ProviderRef = text
		case "base_url":
			input.BaseURL = text
		case "credential_mode":
			input.CredentialMode = text
		case "api_key":
			input.APIKey = text
		default:
			return input, false
		}
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return input, false
	}
	return input, decoder.Decode(new(any)) == io.EOF
}

func (s *Server) validateProviderConnectionRequest(input providerConnectionRequest) string {
	if input.seen["name"] == input.seen["provider_ref"] {
		return "invalid_body"
	}
	if input.seen["provider_ref"] && !providerImpactRefPattern.MatchString(input.ProviderRef) {
		return "invalid_provider_ref"
	}
	name := strings.TrimSpace(input.Name)
	if input.seen["name"] && (name == "" || !utf8.ValidString(name) || modelsProviderNameReserved(name) || !s.modelsProviderLabelSafeForConfig(name)) {
		return "invalid_provider_name"
	}
	if input.BaseURL == "" || len(input.BaseURL) > 8192 || !utf8.ValidString(input.BaseURL) || s.validateProviderBaseURLForApp(input.BaseURL) != nil {
		return "invalid_base_url"
	}
	switch input.CredentialMode {
	case "draft":
		if !validProviderConnectionKey(strings.TrimSpace(input.APIKey)) || len(input.APIKey) > 8192 {
			return "invalid_credential_input"
		}
	case "stored":
		if input.ProviderRef == "" || input.seen["api_key"] {
			return "invalid_credential_input"
		}
	case "none":
		if input.seen["api_key"] {
			return "invalid_credential_input"
		}
	default:
		return "invalid_credential_input"
	}
	return ""
}

func validProviderConnectionKey(value string) bool {
	if value == "" || len(value) > 8192 || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if character <= 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}
