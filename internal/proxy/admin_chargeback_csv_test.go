package proxy

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestChargebackCSVNeutralizesFormulas(t *testing.T) {
	for _, value := range []string{"=1+1", "+1", "-1", "@SUM(A1)", " \t=1", "\u00a0=1", "\ufeff=1", "\x00=1", "\x7f=1", "\tplain", "\rplain", "\nplain"} {
		t.Run(fmt.Sprintf("case_%x", []byte(value)), func(t *testing.T) {
			var output bytes.Buffer
			if err := writeChargebackCSV(&output, "2026-10", []chargebackDimension{{Dimension: "project", Rows: []chargebackRow{{Key: value, Requests: 2, Tokens: 3, CostKRW: 1.5, Errors: 1}}}}); err != nil {
				t.Fatal(err)
			}
			rows, err := csv.NewReader(&output).ReadAll()
			if err != nil || len(rows) != 2 || len(rows[1]) != 7 {
				t.Fatal("CSV shape mismatch")
			}
			if rows[1][2] != "'"+value || rows[1][5] != "1.5" || rows[1][6] != "1" {
				t.Fatal("CSV neutralization or numeric contract mismatch")
			}
		})
	}
}

func TestChargebackCSVPreservesPlainKeys(t *testing.T) {
	for _, value := range []string{"", "한글 프로젝트", "a,b", "a\"b", "a\rb", "a\nb", "'already safe"} {
		var output bytes.Buffer
		if err := writeChargebackCSV(&output, "2026-10", []chargebackDimension{{Dimension: "team", Rows: []chargebackRow{{Key: value}}}}); err != nil {
			t.Fatal(err)
		}
		rows, err := csv.NewReader(&output).ReadAll()
		if err != nil || len(rows) != 2 || rows[1][2] != value {
			t.Fatal("plain key changed or invalid CSV")
		}
	}
}

func TestChargebackCSVServerContract(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "chargeback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)
	if err := db.InsertLogRecord(context.Background(), store.LogRecord{
		Request: store.RequestLog{ID: "chargeback_fixture", TraceID: "chargeback_fixture", Project: "=1+1", StatusCode: 500, CreatedAt: now},
		Usage:   &store.TokenUsage{ID: "chargeback_usage", RequestID: "chargeback_fixture", TotalTokens: 7, EstimatedCost: 12.3, Currency: "KRW", CreatedAt: now},
	}); err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"json", "csv"} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/admin/cost/chargeback-pack?month=2026-10&dimensions=project&format="+format, nil)
		server.Routes().ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("response status %d", recorder.Code)
		}
		if format == "json" {
			var result struct {
				Dimensions []chargebackDimension `json:"dimensions"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if len(result.Dimensions) != 1 || len(result.Dimensions[0].Rows) != 1 || result.Dimensions[0].Rows[0].Key != "=1+1" || result.Dimensions[0].Rows[0].Errors != 1 {
				t.Fatal("JSON source contract changed")
			}
		} else {
			if !strings.HasPrefix(recorder.Header().Get("Content-Type"), "text/csv") {
				t.Fatal("not CSV")
			}
			rows, err := csv.NewReader(recorder.Body).ReadAll()
			if err != nil || len(rows) != 2 || rows[1][2] != "'=1+1" || rows[1][6] != "1" {
				t.Fatal("server CSV contract mismatch")
			}
		}
	}
}
