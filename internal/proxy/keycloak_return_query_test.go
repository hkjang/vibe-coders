package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestKeycloakReturnToPreservesEncodedQuerySeparators(t *testing.T) {
	id := "SSO 정책 +%2F?&#/exact"
	target := "/app/governance/policies/detail?" + url.Values{"tab": {"safety"}, "policy": {id}}.Encode()
	got, ok := safeAuthReturnTo(target)
	if !ok || got != target {
		t.Fatal("a query identifier containing encoded separators must preserve the internal return path")
	}
	parsed, err := url.Parse(got)
	if err != nil || parsed.Path != "/app/governance/policies/detail" || parsed.Query().Get("policy") != id || parsed.Host != "" || parsed.Fragment != "" {
		t.Fatal("encoded query value changed the redirect destination or identifier")
	}
	s, _ := newSilentSsoTestServer(t, true)
	for _, silent := range []bool{false, true} {
		query := url.Values{"return_to": {target}}
		if silent {
			query.Set("prompt", "none")
		}
		_, state := startKeycloakLogin(t, s, query.Encode())
		flow, found := s.takeOIDCFlow(t.Context(), state)
		if !found || flow.returnTo != target || flow.silent != silent {
			t.Fatal("OIDC state did not preserve the original encoded query")
		}
		if silent {
			response := runSilentCallback(t, s, "encoded-query-declined", target, true, "login_required")
			location, err := url.Parse(response.Header().Get("Location"))
			if err != nil || location.Path != "/app/login" || location.Query().Get("return_to") != target || location.Query().Get("sso") != "none" {
				t.Fatal("declined silent login lost the encoded selection")
			}
		}
	}
}

func TestKeycloakReturnToStillRejectsEncodedPathEscapes(t *testing.T) {
	s, _ := newSilentSsoTestServer(t, true)
	for _, target := range []string{
		"https://outside.invalid/app/", "//outside.invalid/app/", "/app%2Fpolicies?policy=a%2Fb", "/app/%2foutside.invalid?policy=a%2Fb",
		"/app/%2F..%2Fadmin?policy=a%2Fb", "/app/%2e%2e/admin?policy=a%2Fb", "/app/../admin?policy=a%2Fb",
		"/app/%5coutside.invalid?policy=a%2Fb", "/app/policies?policy=a%5Cb", "/app/policies?policy=a%00b",
		"/app/policies?policy=a\\b", "/app/policies?policy=a%2Fb#outside", "/admin?policy=a%2Fb",
	} {
		t.Run(target, func(t *testing.T) {
			if _, ok := safeAuthReturnTo(target); ok {
				t.Fatal("unsafe return destination was accepted")
			}
			request := httptest.NewRequest(http.MethodGet, "/auth/keycloak/login?"+url.Values{"return_to": {target}}.Encode(), nil)
			response := httptest.NewRecorder()
			s.handleKeycloakLogin(response, request)
			if response.Code != http.StatusBadRequest || response.Header().Get("Location") != "" {
				t.Fatal("unsafe destination started an OIDC redirect")
			}
		})
	}
}
