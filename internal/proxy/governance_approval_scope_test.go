package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// approvalGateFixture is a gateway where every gpt-4.1 request needs an approval, plus two
// keys belonging to different users and teams. An approval id is a credential: presenting
// somebody else's must not get a request through.
type approvalGateFixture struct {
	proxy    *httptest.Server
	db       *store.SQLStore
	upstream *atomic.Int32
}

func newApprovalGateFixture(t *testing.T) *approvalGateFixture {
	t.Helper()
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"unexpected"}}]}`))
	}))
	t.Cleanup(upstream.Close)

	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })

	ctx := context.Background()
	for _, team := range []store.AuthTeam{
		{ID: "t_alpha", Name: "alpha"}, {ID: "t_beta", Name: "beta"},
	} {
		team.CreatedAt, team.UpdatedAt = time.Now().UTC(), time.Now().UTC()
		if err := db.UpsertAuthTeam(ctx, team); err != nil {
			t.Fatal(err)
		}
	}
	for _, k := range []struct{ id, secret, user, team string }{
		{"key_a", "vc_sk_scope_a_1234567890abcdef", "user_a", "t_alpha"},
		{"key_b", "vc_sk_scope_b_1234567890abcdef", "user_b", "t_beta"},
	} {
		if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{
			ID: k.id, Name: k.id, KeyHash: hashProxyKey(k.secret), Status: "active",
			UserID: k.user, Team: k.team, Scopes: []string{"chat:completion"},
			CreatedAt: time.Now().UTC(),
		}); err != nil {
			t.Fatal(err)
		}
	}

	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	t.Cleanup(proxy.Close)

	resp := postJSON(t, proxy.URL+"/admin/policies", "", map[string]any{
		"name": "approval for all gpt-4.1",
		"rules": []any{
			map[string]any{"name": "model approval", "model": "gpt-4.1", "require_approval": true},
		},
	})
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("policy create status %d: %s", resp.StatusCode, body)
	}
	resp.Body.Close()
	return &approvalGateFixture{proxy: proxy, db: db, upstream: &calls}
}

func (f *approvalGateFixture) callWithBody(t *testing.T, secret, approvalID string) (int, string) {
	t.Helper()
	encoded, _ := json.Marshal(map[string]any{
		"model":    "gpt-4.1",
		"messages": []any{map[string]any{"role": "user", "content": "hello"}},
	})
	req, err := http.NewRequest(http.MethodPost, f.proxy.URL+"/v1/chat/completions", bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+secret)
	if approvalID != "" {
		req.Header.Set("X-Governance-Approval-ID", approvalID)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(raw)
}

func (f *approvalGateFixture) callWith(t *testing.T, secret, approvalID string) int {
	t.Helper()
	status, _ := f.callWithBody(t, secret, approvalID)
	return status
}

// An approval issued to one user is not a credential for another. The API key binding is
// already covered; the user binding was not, and a request authenticated as a different
// user carries a different UserID with the same key only in principle — but the check is
// there precisely so an approval can be scoped to a person.
func TestApprovalBoundToAUserRejectsAnotherUser(t *testing.T) {
	f := newApprovalGateFixture(t)
	ctx := context.Background()

	if err := f.db.InsertApproval(ctx, store.Approval{
		ID: "appr_user_a", UserID: "user_a", SubjectType: "openai_request",
		Status: "approved", Reason: "for user a", ExpiresAt: time.Now().UTC().Add(time.Hour),
		CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	if got := f.callWith(t, "vc_sk_scope_b_1234567890abcdef", "appr_user_a"); got != http.StatusLocked {
		t.Errorf("another user's approval got %d, want %d — an approval id is a credential", got, http.StatusLocked)
	}
	if f.upstream.Load() != 0 {
		t.Error("the upstream was called with another user's approval")
	}
	// And it still works for the user it was issued to, or the check is simply rejecting
	// everything.
	if got := f.callWith(t, "vc_sk_scope_a_1234567890abcdef", "appr_user_a"); got != http.StatusOK {
		t.Errorf("the approval's own user got %d, want 200", got)
	}
}

// The same for a team-scoped approval.
func TestApprovalBoundToATeamRejectsAnotherTeam(t *testing.T) {
	f := newApprovalGateFixture(t)
	ctx := context.Background()

	if err := f.db.InsertApproval(ctx, store.Approval{
		ID: "appr_team_alpha", TeamID: "t_alpha", SubjectType: "openai_request",
		Status: "approved", Reason: "for team alpha", ExpiresAt: time.Now().UTC().Add(time.Hour),
		CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	if got := f.callWith(t, "vc_sk_scope_b_1234567890abcdef", "appr_team_alpha"); got != http.StatusLocked {
		t.Errorf("another team's approval got %d, want %d", got, http.StatusLocked)
	}
	if f.upstream.Load() != 0 {
		t.Error("the upstream was called with another team's approval")
	}
	if got := f.callWith(t, "vc_sk_scope_a_1234567890abcdef", "appr_team_alpha"); got != http.StatusOK {
		t.Errorf("the approval's own team got %d, want 200", got)
	}
}

// A client that has been told to wait retries with the id it was given, which is still
// pending. That retry must be refused for being pending — and must leave the approval
// pending, because marking it expired would destroy an approval an operator is about to
// grant, and the requester would be doing it to themselves by retrying.
func TestRetryingWithAPendingApprovalDoesNotExpireIt(t *testing.T) {
	f := newApprovalGateFixture(t)
	ctx := context.Background()

	if err := f.db.InsertApproval(ctx, store.Approval{
		ID: "appr_pending", APIKeyID: "key_a", SubjectType: "openai_request",
		Status: "pending", Reason: "awaiting an operator", ExpiresAt: time.Now().UTC().Add(time.Hour),
		CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	if got := f.callWith(t, "vc_sk_scope_a_1234567890abcdef", "appr_pending"); got != http.StatusLocked {
		t.Fatalf("a pending approval got %d, want %d", got, http.StatusLocked)
	}
	after, found, err := f.db.GetApproval(ctx, "appr_pending")
	if err != nil || !found {
		t.Fatalf("approval gone after the retry: %v %v", found, err)
	}
	if after.Status != "pending" {
		t.Fatalf("retrying with a pending approval left it %q; an operator's decision was "+
			"destroyed by the requester retrying", after.Status)
	}
}

// An approval id that does not exist has to say so. Every later check refuses it too — a
// zero-valued approval has no status — so the request is turned away either way, and the
// difference is entirely in what the caller is told. "approval status is " sends somebody
// looking for a status that was never the problem.
func TestAnUnknownApprovalIDSaysItIsUnknown(t *testing.T) {
	f := newApprovalGateFixture(t)

	status, body := f.callWithBody(t, "vc_sk_scope_a_1234567890abcdef", "appr_never_existed")
	if status != http.StatusLocked {
		t.Fatalf("an unknown approval id got %d, want %d", status, http.StatusLocked)
	}
	if !strings.Contains(body, "invalid or not found") {
		t.Fatalf("the refusal does not say the id is unknown: %s", body)
	}
}
