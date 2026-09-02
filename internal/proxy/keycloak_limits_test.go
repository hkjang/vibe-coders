package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vibe-coders/internal/config"
)

func TestKeycloakLogoutEnforcesMethodAndBodyLimit(t *testing.T) {
	s := &Server{}

	wrongMethod := httptest.NewRequest(http.MethodGet, "/auth/keycloak/logout", nil)
	wrongMethodRecorder := httptest.NewRecorder()
	s.handleKeycloakLogout(wrongMethodRecorder, wrongMethod)
	if wrongMethodRecorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET logout status=%d, want 405", wrongMethodRecorder.Code)
	}
	if got := wrongMethodRecorder.Header().Get("Allow"); got != http.MethodPost {
		t.Fatalf("GET logout Allow=%q, want POST", got)
	}

	oversized := `{"refresh_token":"` + strings.Repeat("x", int(maxKeycloakJSONBodyBytes)) + `"}`
	request := httptest.NewRequest(http.MethodPost, "/auth/keycloak/logout", strings.NewReader(oversized))
	recorder := httptest.NewRecorder()
	s.handleKeycloakLogout(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized logout status=%d body=%s, want 413", recorder.Code, recorder.Body.String())
	}

	multiple := httptest.NewRequest(http.MethodPost, "/auth/keycloak/logout", strings.NewReader(`{} {}`))
	multipleRecorder := httptest.NewRecorder()
	s.handleKeycloakLogout(multipleRecorder, multiple)
	if multipleRecorder.Code != http.StatusBadRequest {
		t.Fatalf("multiple logout JSON values status=%d body=%s, want 400", multipleRecorder.Code, multipleRecorder.Body.String())
	}
}

func TestKeycloakConfigSaveEnforcesMethodAndBodyLimit(t *testing.T) {
	s := &Server{cfg: config.Config{Auth: config.AuthConfig{AdminToken: "rw-secret"}}}

	wrongMethod := httptest.NewRequest(http.MethodGet, "/admin/sso/keycloak/config", nil)
	wrongMethodRecorder := httptest.NewRecorder()
	s.handleKeycloakConfigSave(wrongMethodRecorder, wrongMethod)
	if wrongMethodRecorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET config save status=%d, want 405", wrongMethodRecorder.Code)
	}
	if got := wrongMethodRecorder.Header().Get("Allow"); got != "PUT, POST" {
		t.Fatalf("GET config save Allow=%q, want PUT, POST", got)
	}

	oversized := `{"client_secret":"` + strings.Repeat("x", int(maxKeycloakJSONBodyBytes)) + `"}`
	request := httptest.NewRequest(http.MethodPut, "/admin/sso/keycloak/config", strings.NewReader(oversized))
	request.Header.Set("Authorization", "Bearer rw-secret")
	recorder := httptest.NewRecorder()
	s.handleKeycloakConfigSave(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized config save status=%d body=%s, want 413", recorder.Code, recorder.Body.String())
	}
}

func TestKeycloakTokenExchangeRejectsOversizedResponse(t *testing.T) {
	tokenEndpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id_token":"` + strings.Repeat("x", maxOIDCJSONBytes) + `"}`))
	}))
	defer tokenEndpoint.Close()

	s := &Server{cfg: config.Config{Keycloak: config.KeycloakConfig{
		ClientID: "vibe-coders", RedirectURI: "https://gateway.example/auth/keycloak/callback",
	}}}
	_, err := s.keycloakExchangeCode(t.Context(), oidcDiscovery{TokenEndpoint: tokenEndpoint.URL}, "code", "verifier")
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("oversized token response error=%v, want size rejection", err)
	}
}
