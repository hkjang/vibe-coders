package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vibe-coders/internal/config"
)

func TestTakeOIDCFlowDoesNotReusePersistedMirrorAfterDBMiss(t *testing.T) {
	ctx := context.Background()
	db := openTestStore(t)
	s := &Server{db: db}
	random, err := randomURLSafe(8)
	if err != nil {
		t.Fatal(err)
	}
	state := "durable-" + random

	s.saveOIDCFlow(ctx, state, "nonce", "verifier", "/app/providers")
	// Simulate another pod winning the callback and consuming the durable state. The local
	// in-memory mirror remains until this originating pod observes the healthy DB miss.
	if _, _, _, found, err := db.TakeOIDCFlowState(ctx, state); err != nil || !found {
		t.Fatalf("remote durable take: found=%v err=%v", found, err)
	}
	if _, found := s.takeOIDCFlow(ctx, state); found {
		t.Fatal("a healthy DB miss must not resurrect a persisted in-memory mirror")
	}
	if _, found := takeFlowState(state); found {
		t.Fatal("stale persisted mirror was not removed")
	}
}

func TestTakeOIDCFlowFallsBackAfterDBSaveFailure(t *testing.T) {
	ctx := context.Background()
	db := openTestStore(t)
	s := &Server{db: db}
	random, err := randomURLSafe(8)
	if err != nil {
		t.Fatal(err)
	}
	state := "save-failed-" + random

	saveCtx, cancelSave := context.WithCancel(ctx)
	cancelSave()
	s.saveOIDCFlow(saveCtx, state, "nonce", "verifier", "/app/")

	fs, found := s.takeOIDCFlow(ctx, state)
	if !found {
		t.Fatal("originating pod must retain fallback when the DB save fails")
	}
	if fs.persisted || fs.nonce != "nonce" || fs.verifier != "verifier" || fs.returnTo != "/app/" {
		t.Fatalf("unexpected fallback state: %+v", fs)
	}
}

func TestTakeOIDCFlowFailsClosedForPersistedStateAfterDBReadError(t *testing.T) {
	ctx := context.Background()
	db := openTestStore(t)
	s := &Server{db: db}
	random, err := randomURLSafe(8)
	if err != nil {
		t.Fatal(err)
	}
	state := "read-error-" + random

	s.saveOIDCFlow(ctx, state, "nonce", "verifier", "/app/routing")
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	if _, found := s.takeOIDCFlow(ctx, state); found {
		t.Fatal("a persisted state must fail closed when the DB cannot prove single-use consumption")
	}
	if _, found := takeFlowState(state); found {
		t.Fatal("persisted mirror must be discarded after a DB read error")
	}
}

func TestKeycloakCallbackConsumesBoundStateAndSanitizesProviderError(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db, cfg: config.Config{Keycloak: config.KeycloakConfig{
		Enabled: true, IssuerURL: "https://idp.example/realms/vibe",
	}}}
	const state = "browser-bound-provider-error"
	s.saveOIDCFlow(t.Context(), state, "nonce", "verifier", "/app/login")

	req := httptest.NewRequest(http.MethodGet, "/auth/keycloak/callback?state="+state+"&error=access_denied&error_description=do-not-reflect-secret", nil)
	req.AddCookie(&http.Cookie{Name: oidcStateCookieName, Value: state})
	response := httptest.NewRecorder()
	s.handleKeycloakCallback(response, req)

	if response.Code != http.StatusFound || response.Header().Get("Location") != "/app/login#kc_error=access_denied" {
		t.Fatalf("callback redirect = %d %q", response.Code, response.Header().Get("Location"))
	}
	if strings.Contains(response.Header().Get("Location"), "do-not-reflect-secret") {
		t.Fatal("provider error_description was reflected into the redirect")
	}
	cookies := response.Result().Cookies()
	cleared := false
	for _, cookie := range cookies {
		if cookie.Name == oidcStateCookieName && cookie.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Fatal("OIDC state cookie was not cleared")
	}
	if _, found := s.takeOIDCFlow(t.Context(), state); found {
		t.Fatal("provider-error callback did not consume its one-time state")
	}
}
