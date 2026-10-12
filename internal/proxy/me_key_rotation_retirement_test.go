package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestSelfServiceRotationRetiredCredentialCannotPassthrough(t *testing.T) {
	for _, mode := range []string{"revoked", "deleted", "hash-edited", "id-recreated"} {
		t.Run(mode, func(t *testing.T) {
			ts, db := meKeysServer(t, true)
			key := store.APIKeyRecord{ID: "retired-target", Name: "회전 검사", KeyHash: hashProxyKey("vc_sk_synthetic_retired"), UserID: "u1", Team: "t1", Role: "developer", Status: "active", Scopes: []string{"models:read", "chat:completion"}}
			if err := db.UpsertAPIKey(t.Context(), key); err != nil {
				t.Fatal("seed failed")
			}
			resp := postJSON(t, ts.URL+"/me/keys/"+key.ID+"/rotate", "usersecret", map[string]any{})
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatal("rotation failed")
			}
			if mode == "deleted" || mode == "id-recreated" {
				if err := db.DeleteAPIKey(t.Context(), key.ID); err != nil {
					t.Fatal("delete fixture failed")
				}
			}
			if mode == "hash-edited" || mode == "id-recreated" {
				if mode == "hash-edited" {
					key.KeyHash = "changed-synthetic-hash"
				} else {
					key.ID = "recreated-target"
				}
				if err := db.UpsertAPIKey(t.Context(), key); err != nil {
					t.Fatal("recreation fixture failed")
				}
			}
			// Auth is disabled in this fixture: unknown upstream tokens normally
			// pass through. A known retired credential must still be rejected.
			response := postJSON(t, ts.URL+"/v1/chat/completions", "vc_sk_synthetic_retired", map[string]any{"model": "fixture", "messages": []map[string]string{{"role": "user", "content": "synthetic"}}})
			response.Body.Close()
			if response.StatusCode != http.StatusUnauthorized {
				t.Fatalf("retired credential reached passthrough: status %d", response.StatusCode)
			}
		})
	}
}

func TestSelfServiceRotationChatInjectionHonorsDeadline(t *testing.T) {
	_, db := meKeysServer(t, true)
	key := store.APIKeyRecord{ID: "chat-retired", Name: "대화 검사", KeyHash: "chat-synthetic-hash", UserID: "u1", Team: "t1", Role: "developer", Status: "active", Scopes: []string{"chat:completion"}}
	if err := db.UpsertAPIKey(t.Context(), key); err != nil {
		t.Fatal("seed failed")
	}
	key, _, _ = db.GetAPIKey(t.Context(), key.ID)
	created := store.AuthEvent{ID: "chat-created", EventType: "api_key_created", APIKeyID: "chat-replacement", ActorUserID: key.UserID}
	rotated := store.AuthEvent{ID: "chat-rotated", EventType: "api_key_rotated", APIKeyID: key.ID, ActorUserID: key.UserID}
	if _, err := db.RotateAPIKey(t.Context(), key, created.APIKeyID, "new-chat-hash", 0, created, rotated); err != nil {
		t.Fatal("rotation failed")
	}
	key.ExpiresAt = time.Now().Add(time.Hour)
	if err := db.UpsertAPIKey(t.Context(), key); err != nil {
		t.Fatal("stale metadata fixture failed")
	}
	server := &Server{db: db}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/admin/chat-test", nil)
	if _, _, ok := server.chatTestInjectedAuthContext(w, r, key.ID); ok || w.Code != http.StatusForbidden {
		t.Fatal("injected chat context bypassed retirement")
	}
}
