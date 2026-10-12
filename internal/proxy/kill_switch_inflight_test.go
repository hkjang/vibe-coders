package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// This establishes the existing entry-gate semantics, not cancellation of work
// already admitted, cross-pod convergence, or transactional audit durability.
func TestKillSwitchDoesNotCancelAdmittedRequests(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		name := "response"
		if streaming {
			name = "stream"
		}
		t.Run(name, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			var enterOnce, releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				enterOnce.Do(func() { close(entered) })
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
				if streaming {
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"public response\"}}]}\n\ndata: [DONE]\n\n")
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"public response"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
			}))
			defer upstream.Close()
			db := openTestStore(t)
			defer db.Close()
			logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
			logger.Start()
			defer logger.Stop(context.Background())
			cfg := testConfig(upstream.URL, "public-upstream-token")
			cfg.Auth.AdminToken = "public-admin-token"
			cfg.Auth.AdminReadonlyToken = "public-read-token"
			server, err := NewServer(cfg, db, logger, nil)
			if err != nil {
				t.Fatal(err)
			}
			proxy := httptest.NewServer(server.Routes())
			defer proxy.Close()
			defer unblock() // Release any waiting request before closing either server.
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			observe := func(want int64) {
				t.Helper()
				for {
					read, err := http.NewRequestWithContext(ctx, http.MethodGet, proxy.URL+"/admin/kill-switch", nil)
					if err != nil {
						t.Fatal(err)
					}
					read.Header.Set("Authorization", "Bearer public-read-token")
					resp, err := http.DefaultClient.Do(read)
					if err != nil {
						t.Fatal("traffic observation failed")
					}
					var payload struct {
						Traffic *struct {
							Scope      string    `json:"scope"`
							Instance   string    `json:"instance_ref"`
							ObservedAt time.Time `json:"observed_at"`
							Inflight   int64     `json:"proxy_inflight"`
						} `json:"traffic"`
					}
					err = json.NewDecoder(resp.Body).Decode(&payload)
					resp.Body.Close()
					if err != nil || resp.StatusCode != http.StatusOK || payload.Traffic == nil || resp.Header.Get("Cache-Control") != "no-store" {
						t.Fatal("missing current traffic observation")
					}
					if payload.Traffic.Scope != "responding_process" || payload.Traffic.Instance == "" || payload.Traffic.ObservedAt.IsZero() {
						t.Fatal("missing observation scope, instance or timestamp")
					}
					if payload.Traffic.Inflight == want {
						return
					}
					select {
					case <-ctx.Done():
						t.Fatalf("inflight count did not become %d", want)
					case <-time.After(5 * time.Millisecond):
					}
				}
			}
			observe(0)
			body, err := json.Marshal(chatBody("test-model", streaming))
			if err != nil {
				t.Fatal(err)
			}
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, proxy.URL+"/v1/chat/completions", bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json")
			type outcome struct {
				status int
				err    error
			}
			finished := make(chan outcome, 1)
			go func() {
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					finished <- outcome{err: err}
					return
				}
				_, err = io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				finished <- outcome{status: resp.StatusCode, err: err}
			}()
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal("public upstream did not receive the admitted request")
			}
			observe(1)
			flip := func(disabled bool, reason string) {
				t.Helper()
				resp := postJSON(t, proxy.URL+"/admin/kill-switch", "public-admin-token", map[string]any{"disabled": disabled, "reason": reason})
				defer resp.Body.Close()
				if resp.StatusCode != http.StatusOK {
					t.Fatalf("change status: %d", resp.StatusCode)
				}
				var ack struct {
					Disabled bool   `json:"disabled"`
					Reason   string `json:"reason"`
				}
				if err := json.NewDecoder(resp.Body).Decode(&ack); err != nil {
					t.Fatal(err)
				}
				if ack.Disabled != disabled || ack.Reason != reason {
					t.Fatal("acknowledgment does not match submitted state and reason")
				}
			}
			flip(true, "공개 검증: 새 요청 차단")
			blocked := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", streaming))
			blocked.Body.Close()
			if blocked.StatusCode != http.StatusServiceUnavailable || blocked.Header.Get("X-Kill-Switch") != "global" || blocked.Header.Get("Retry-After") != "60" {
				t.Fatal("new request did not receive the documented entry-gate response")
			}
			observe(1)
			select {
			case <-finished:
				t.Fatal("admitted request ended before the upstream was released")
			default:
			}
			unblock()
			select {
			case result := <-finished:
				if result.err != nil || result.status != http.StatusOK {
					t.Fatal("admitted request did not finish normally after stop")
				}
			case <-ctx.Done():
				t.Fatal("admitted request did not finish")
			}
			observe(0)
			flip(false, "공개 검증: 운영 재개")
			resumed := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", streaming))
			io.Copy(io.Discard, resumed.Body)
			resumed.Body.Close()
			if resumed.StatusCode != http.StatusOK {
				t.Fatal("new request was not admitted after resume")
			}
			audits, err := db.ListAdminAudit(ctx, 10)
			if err != nil {
				t.Fatal(err)
			}
			seen := map[bool]bool{}
			for _, audit := range audits {
				if audit.Action != "kill_switch.set" {
					continue
				}
				var change struct {
					Disabled bool   `json:"disabled"`
					Reason   string `json:"reason"`
				}
				if err := json.Unmarshal([]byte(audit.AfterValue), &change); err != nil {
					t.Fatal(err)
				}
				want := "공개 검증: 운영 재개"
				if change.Disabled {
					want = "공개 검증: 새 요청 차단"
				}
				if change.Reason != want || audit.AdminID == "" || audit.AdminID == "anonymous" || audit.CreatedAt == "" {
					t.Fatal("missing audited actor, reason or time")
				}
				seen[change.Disabled] = true
			}
			if len(seen) != 2 {
				t.Fatal("stop and resume must both have an audit record")
			}
		})
	}
}
