package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestText2SQLProfileConnectionHTTPPersistence(t *testing.T) {
	_, db, server := newAdminModelsTestServer(t, "")
	for _, id := range []string{"selected-source", "default", ""} {
		body, _ := json.Marshal(map[string]any{"virtual_model": "vibe/text2sql-selected", "mode": "execute", "exec_connection_id": " " + id + " "})
		response, result := req(t, http.MethodPost, server.URL+"/admin/text2sql/profiles", string(body))
		if response.StatusCode != http.StatusCreated {
			t.Fatal("profile save failed")
		}
		profile, found, err := db.GetText2SQLProfile(t.Context(), "vibe/text2sql-selected")
		if err != nil || !found || profile.ExecConnectionID != id || result["profile"].(map[string]any)["exec_connection_id"] != id {
			t.Fatal("profile API did not persist and return the selected connection")
		}
		response, result = req(t, http.MethodGet, server.URL+"/admin/text2sql/profiles", "")
		if response.StatusCode != http.StatusOK || len(result["profiles"].([]any)) != 1 || result["profiles"].([]any)[0].(map[string]any)["exec_connection_id"] != id {
			t.Fatal("profile list did not return the persisted connection")
		}
	}
}

func TestText2SQLProfileConnectionLookupFailureStopsExecution(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	meta := store.LogRecord{}
	meta.Request.Model = "vibe/text2sql-execute"
	w := httptest.NewRecorder()
	s.handleText2SQL(w, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil), meta, []byte(`{"messages":[{"role":"user","content":"대상 조회"}]}`), nil)
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "text2sql_profile_unavailable") || strings.Contains(w.Body.String(), "database is closed") {
		t.Fatal("profile lookup failure must stop before generation or fallback execution without storage errors")
	}
}

func TestText2SQLProfileConnectionExecutionFlow(t *testing.T) {
	for _, defaultConfigured := range []bool{false, true} {
		for _, saveViaAPI := range []bool{false, true} {
			name := "named-only"
			if defaultConfigured {
				name = "different-default"
			}
			if saveViaAPI {
				name += "-api-profile"
			}
			t.Run(name, func(t *testing.T) {
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					writeJSON(w, http.StatusOK, map[string]any{"choices": []map[string]any{{"message": map[string]string{"content": "SELECT marker FROM target"}, "finish_reason": "stop"}}, "usage": map[string]int{"total_tokens": 1}})
				}))
				defer upstream.Close()
				db := openTestStore(t)
				defer db.Close()
				logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
				logger.Start()
				defer logger.Stop(context.Background())
				cfg := testConfig(upstream.URL, "fixture-unused")
				cfg.Text2SQL.Enabled = true
				cfg.Text2SQL.ExecuteModel = "fixture-model"
				cfg.Text2SQL.DefaultLimit = 10
				cfg.Text2SQL.Dialect = "sqlite"
				cfg.Text2SQL.Schema = "table target(marker text)"
				cfg.Text2SQL.ExecDriver = "sqlite"
				if defaultConfigured {
					cfg.Text2SQL.ExecDSN = sqliteExecutionSource(t, "wrong-default-source")
				}
				s, err := NewServer(cfg, db, logger, nil)
				if err != nil {
					t.Fatal(err)
				}
				httpServer := httptest.NewServer(s.Routes())
				defer httpServer.Close()
				saveExecutionTarget(t, s, "selected", "sqlite", sqliteExecutionSource(t, "correct-selected-source"), true)
				profile := store.Text2SQLProfile{VirtualModel: "vibe/text2sql-selected", Mode: "execute", UpstreamModel: "fixture-model", ExecConnectionID: "selected", Enabled: true}
				if saveViaAPI {
					body, _ := json.Marshal(profile)
					response, _ := req(t, http.MethodPost, httpServer.URL+"/admin/text2sql/profiles", string(body))
					if response.StatusCode != http.StatusCreated {
						t.Fatal("API profile save failed")
					}
				} else if err = db.UpsertText2SQLProfile(t.Context(), profile); err != nil {
					t.Fatal(err)
				}
				call := func() string {
					t.Helper()
					response := postJSON(t, httpServer.URL+"/v1/chat/completions", "", map[string]any{"model": profile.VirtualModel, "messages": []map[string]string{{"role": "user", "content": "대상 표의 값을 보여줘"}}})
					defer response.Body.Close()
					body, err := io.ReadAll(response.Body)
					if err != nil || response.StatusCode != http.StatusOK {
						t.Fatal("Text2SQL request failed")
					}
					return string(body)
				}
				result := call()
				if !strings.Contains(result, "correct-selected-source") || strings.Contains(result, "wrong-default-source") {
					t.Fatal("profile did not execute the selected source independently of default configuration")
				}
				logs, err := db.ListText2SQLLogs(t.Context(), 10)
				if err != nil || len(logs) != 1 || !logs[0].Executed || logs[0].RowCount != 1 {
					t.Fatal("selected profile execution was not recorded")
				}
				if err := db.DeleteText2SQLExecConnection(t.Context(), "selected"); err != nil {
					t.Fatal(err)
				}
				result = call()
				if !strings.Contains(result, "SQL 실행 실패") || strings.Contains(result, "correct-selected-source") || strings.Contains(result, "wrong-default-source") {
					t.Fatal("missing selected connection must fail without falling back to another source")
				}
			})
		}
	}
}
