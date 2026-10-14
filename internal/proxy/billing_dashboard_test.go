package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

type billingReadFixture struct {
	fail  string
	calls int
	since time.Time
}

func (f *billingReadFixture) UsageSince(_ context.Context, filter store.UsageFilter) (int64, float64, int64, error) {
	if filter.Scope != "global" || !filter.Since.Equal(f.since) {
		panic("incorrect aggregate filter")
	}
	if f.fail == "totals" {
		return 0, 0, 0, errors.New("private storage detail")
	}
	return 80, 1234, 0, nil
}
func (f *billingReadFixture) CostAllocation(_ context.Context, dimension string, since time.Time, limit int) ([]store.CostAllocationRow, error) {
	f.calls++
	if limit != 20 || !since.Equal(f.since) {
		panic("allocation scope changed")
	}
	rows := []store.CostAllocationRow{{Key: "fixture", CostKRW: 10, Requests: 1}}
	if f.fail == "by_"+dimension || f.fail == "all" {
		return rows, errors.New("private storage detail")
	}
	return rows, nil
}
func (f *billingReadFixture) BudgetStatuses(context.Context, time.Time) ([]store.BudgetStatus, error) {
	f.calls++
	rows := []store.BudgetStatus{{SpentKRW: 20}}
	if f.fail == "budgets" || f.fail == "all" {
		return rows, errors.New("private storage detail")
	}
	return rows, nil
}
func (f *billingReadFixture) ModelMigrationAdvice(_ context.Context, since time.Time, limit, minimum int) ([]store.ModelMigrationAdvice, error) {
	f.calls++
	if limit != 10 || minimum != 20 || !since.Equal(f.since) {
		panic("migration scope changed")
	}
	rows := []store.ModelMigrationAdvice{{EstimatedSavingsKRW: 30}}
	if f.fail == "migration_candidates" || f.fail == "all" {
		return rows, errors.New("private storage detail")
	}
	return rows, nil
}

func TestBillingDashboardPartialReads(t *testing.T) {
	for _, section := range []string{"", "totals", "by_cost_center", "by_model", "budgets", "migration_candidates", "all"} {
		t.Run(section, func(t *testing.T) {
			f := &billingReadFixture{fail: section, since: time.Now().UTC().Add(-time.Hour)}
			report, err := readBillingDashboard(context.Background(), f, f.since, time.Now())
			if section == "totals" {
				if err == nil || f.calls != 0 {
					t.Fatal("total failure must stop before optional reads")
				}
				return
			}
			if err != nil || report.TotalRequests != 80 || report.TotalCostKRW != 1234 || report.TotalsScope != "all_retained_requests" || f.calls != 4 {
				t.Fatal("independent aggregate lost")
			}
			want := []string{}
			if section == "all" {
				want = []string{"by_cost_center", "by_model", "budgets", "migration_candidates"}
			} else if section != "" {
				want = []string{section}
			}
			if !reflect.DeepEqual(report.UnavailableSections, want) {
				t.Fatal("incorrect failed-section metadata")
			}
			for _, name := range want {
				switch name {
				case "by_cost_center":
					if report.ByCostCenter != nil {
						t.Fatal("partial center rows leaked")
					}
				case "by_model":
					if report.ByModel != nil {
						t.Fatal("partial model rows leaked")
					}
				case "budgets":
					if report.Budgets != nil {
						t.Fatal("partial budgets leaked")
					}
				case "migration_candidates":
					if report.MigrationCandidates != nil || report.EstimatedSavingsKRW != 0 {
						t.Fatal("partial savings leaked")
					}
				}
			}
			if section != "all" && section != "migration_candidates" && report.EstimatedSavingsKRW != 30 {
				t.Fatal("healthy savings lost")
			}
			body, _ := json.Marshal(report)
			if strings.Contains(string(body), "private storage detail") {
				t.Fatal("storage detail leaked")
			}
		})
	}
}

// openTestStore also supports an isolated PostgreSQL schema with TEST_POSTGRES_DSN.
func TestBillingDashboardTotalsBeyondTopTwenty(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	now := time.Now().UTC()
	for i := 1; i <= 23; i++ {
		at := now.Add(-time.Minute)
		if i == 23 {
			at = now.Add(-2 * time.Hour)
		}
		id := fmt.Sprintf("billing-fixture-%02d", i)
		record := store.LogRecord{Request: store.RequestLog{ID: id, TraceID: id, Model: id, CostCenter: id, CreatedAt: at, StatusCode: 200}}
		if i != 22 {
			record.Usage = &store.TokenUsage{ID: id, RequestID: id, EstimatedCost: float64(i), TotalTokens: 7, Currency: "KRW", CreatedAt: at}
		}
		if err := db.InsertLogRecord(context.Background(), record); err != nil {
			t.Fatal("fixture insert failed")
		}
	}
	server := &Server{db: db}
	response := httptest.NewRecorder()
	server.handleBillingDashboard(response, httptest.NewRequest(http.MethodGet, "/billing/dashboard?window=1h", nil))
	var report billingDashboard
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &report) != nil {
		t.Fatal("dashboard read failed")
	}
	if report.TotalRequests != 22 || report.TotalCostKRW != 231 || len(report.ByModel) != 20 || len(report.ByCostCenter) != 20 || len(report.UnavailableSections) != 0 {
		t.Fatal("totals must include every retained request in the window, independent of top-20 lists")
	}
	var topCost float64
	for _, row := range report.ByModel {
		topCost += row.CostKRW
	}
	if topCost != 230 || report.TotalsScope != "all_retained_requests" {
		t.Fatal("list bound or aggregate marker changed")
	}
	if report.Budgets == nil || report.MigrationCandidates == nil {
		t.Fatal("healthy empty lists must not be failed reads")
	}
}

func TestBillingDashboardFailureAndAuthorization(t *testing.T) {
	db := openTestStore(t)
	db.Close()
	server := &Server{db: db}
	for _, scenario := range []struct {
		method string
		auth   bool
		status int
	}{
		{http.MethodPost, false, 405}, {http.MethodGet, true, 403}, {http.MethodGet, false, 503},
	} {
		server.cfg.Auth.Enabled = scenario.auth
		response := httptest.NewRecorder()
		server.handleBillingDashboard(response, httptest.NewRequest(scenario.method, "/billing/dashboard", nil))
		if response.Code != scenario.status || strings.Contains(response.Body.String(), "database") || strings.Contains(response.Body.String(), "total_cost_krw") {
			t.Fatal("unsafe failure response")
		}
	}
}

func TestBillingDashboardOpenAPI(t *testing.T) {
	paths := buildOpenAPISpec()["paths"].(map[string]any)
	assertJSONOperationSchema(t, paths, "/billing/dashboard", "get", "200", "BillingDashboardResponse")
	assertJSONOperationSchema(t, paths, "/billing/dashboard", "get", "503", "AppError")
}
