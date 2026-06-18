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
	"time"

	"vibe-coders/internal/store"
)

func TestText2SQLPreviewFlow(t *testing.T) {
	var upstreamModels []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(body, &req)
		upstreamModels = append(upstreamModels, req.Model)
		w.Header().Set("Content-Type", "application/json")
		// Upstream returns the SQL in a fenced block.
		_, _ = w.Write([]byte("{\"choices\":[{\"message\":{\"content\":\"```sql\\nSELECT dept, count(*) FROM itsm_requests GROUP BY dept\\n```\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}"))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig(upstream.URL, "secret")
	cfg.Text2SQL.Enabled = true
	cfg.Text2SQL.PreviewModel = "test-model"
	cfg.Text2SQL.DefaultLimit = 100
	cfg.Text2SQL.Dialect = "PostgreSQL"
	cfg.Text2SQL.Schema = "table itsm_requests(dept text, created_at timestamp)"

	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", map[string]any{
		"model":    "vibe/text2sql-preview",
		"messages": []map[string]string{{"role": "user", "content": "지난달 부서별 ITSM 요청 건수를 알려줘"}},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, b)
	}
	if resp.Header.Get("X-Task-Type") != "text2sql" {
		t.Errorf("expected X-Task-Type=text2sql, got %q", resp.Header.Get("X-Task-Type"))
	}

	var out struct {
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	// User sees the virtual model, not the upstream model.
	if out.Model != "vibe/text2sql-preview" {
		t.Errorf("response model = %q, want vibe/text2sql-preview", out.Model)
	}
	content := out.Choices[0].Message.Content
	if !strings.Contains(content, "SELECT dept") {
		t.Errorf("expected generated SQL in content, got: %s", content)
	}
	if !strings.Contains(content, "LIMIT 100") {
		t.Errorf("expected injected LIMIT, got: %s", content)
	}
	// The upstream was called with the REAL model, never the virtual one.
	for _, m := range upstreamModels {
		if strings.HasPrefix(m, "vibe/text2sql") {
			t.Errorf("virtual model leaked to upstream: %q", m)
		}
	}
	if len(upstreamModels) == 0 || upstreamModels[0] != "test-model" {
		t.Errorf("expected upstream model test-model, got %v", upstreamModels)
	}

	// A Text2SQL audit log row should be written.
	var log store.Text2SQLQueryLog
	waitFor(t, 2*time.Second, func() bool {
		logs, _ := db.ListText2SQLLogs(context.Background(), 10)
		if len(logs) == 1 && logs[0].Valid && logs[0].UpstreamModel == "test-model" && logs[0].VirtualModel == "vibe/text2sql-preview" {
			log = logs[0]
			return true
		}
		return false
	})
	spans, err := db.Text2SQLSpansForRequest(context.Background(), log.RequestID)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	statusByStage := map[string]string{}
	for _, sp := range spans {
		seen[sp.Stage] = true
		statusByStage[sp.Stage] = sp.Status
	}
	for _, want := range []string{"classify", "schema_resolve", "glossary_apply", "sql_generate", "sql_validate", "explain_guard", "execute", "mask_result", "summarize", "evaluate"} {
		if !seen[want] {
			t.Fatalf("expected Text2SQL span %s, got %+v", want, spans)
		}
	}
	for _, wantSkipped := range []string{"explain_guard", "execute", "mask_result", "summarize"} {
		if statusByStage[wantSkipped] != "skipped" {
			t.Fatalf("expected preview span %s to be skipped, got statuses=%+v spans=%+v", wantSkipped, statusByStage, spans)
		}
	}
	spanResp, err := http.Get(proxy.URL + "/admin/text2sql/spans?request_id=" + log.RequestID)
	if err != nil {
		t.Fatal(err)
	}
	defer spanResp.Body.Close()
	if spanResp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(spanResp.Body)
		t.Fatalf("spans API status %d: %s", spanResp.StatusCode, b)
	}
	detailResp, err := http.Get(proxy.URL + "/admin/requests/" + log.RequestID)
	if err != nil {
		t.Fatal(err)
	}
	defer detailResp.Body.Close()
	if detailResp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(detailResp.Body)
		t.Fatalf("request detail status %d: %s", detailResp.StatusCode, b)
	}
	var detail struct {
		Text2SQLSpans []store.Text2SQLSpan `json:"text2sql_spans"`
	}
	if err := json.NewDecoder(detailResp.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Text2SQLSpans) == 0 {
		t.Fatalf("expected request detail to include Text2SQL spans")
	}
	explainResp, err := http.Get(proxy.URL + "/admin/requests/" + log.RequestID + "/explain")
	if err != nil {
		t.Fatal(err)
	}
	defer explainResp.Body.Close()
	if explainResp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(explainResp.Body)
		t.Fatalf("explain status %d: %s", explainResp.StatusCode, b)
	}
	var explain struct {
		Text2SQL struct {
			SpanCount int `json:"span_count"`
		} `json:"text2sql"`
	}
	if err := json.NewDecoder(explainResp.Body).Decode(&explain); err != nil {
		t.Fatal(err)
	}
	if explain.Text2SQL.SpanCount == 0 {
		t.Fatalf("expected XView explain to include Text2SQL span count")
	}
	adminResp, err := http.Get(proxy.URL + "/admin/text2sql?window=7d")
	if err != nil {
		t.Fatal(err)
	}
	defer adminResp.Body.Close()
	var adminOut struct {
		StageMetrics []store.Text2SQLStageMetric `json:"stage_metrics"`
	}
	if err := json.NewDecoder(adminResp.Body).Decode(&adminOut); err != nil {
		t.Fatal(err)
	}
	if len(adminOut.StageMetrics) == 0 {
		t.Fatalf("expected Text2SQL stage metrics")
	}
}
