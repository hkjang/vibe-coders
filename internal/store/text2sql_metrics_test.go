package store

import (
	"context"
	"testing"
	"time"
)

func TestText2SQLModelMetricsAndGolden(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	mk := func(model string, valid, executed bool, errStr string, cost float64) {
		_ = db.InsertText2SQLLog(ctx, Text2SQLQueryLog{
			ID: newTestID(), VirtualModel: "vibe/text2sql-preview", UpstreamModel: model,
			Mode: "preview", Question: "q", GeneratedSQL: "SELECT 1", Valid: valid, Executed: executed,
			Error: errStr, CostKRW: cost, CreatedAt: now,
		})
	}
	mk("gpt-4.1-mini", true, false, "", 10)
	mk("gpt-4.1-mini", true, false, "", 20)
	mk("gpt-4.1-mini", false, false, "bad", 5)
	mk("claude-sonnet-4", true, true, "", 40)

	metrics, err := db.Text2SQLModelMetricsSince(ctx, now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	byModel := map[string]Text2SQLModelMetric{}
	for _, m := range metrics {
		byModel[m.UpstreamModel] = m
	}
	mini := byModel["gpt-4.1-mini"]
	if mini.Total != 3 || mini.Valid != 2 || mini.Errors != 1 {
		t.Errorf("gpt-4.1-mini metrics = %+v, want total3/valid2/err1", mini)
	}
	if mini.ValidRate < 0.66 || mini.ValidRate > 0.67 {
		t.Errorf("valid_rate = %f, want ~0.667", mini.ValidRate)
	}
	if byModel["claude-sonnet-4"].Executed != 1 {
		t.Errorf("claude executed = %d, want 1", byModel["claude-sonnet-4"].Executed)
	}

	// Golden query CRUD.
	g := Text2SQLGoldenQuery{ID: "g1", Name: "dept counts", Question: "부서별 건수", ExpectedSQL: "SELECT dept, count(*) FROM t GROUP BY dept", Tags: []string{"itsm"}, Enabled: true}
	if err := db.UpsertText2SQLGoldenQuery(ctx, g); err != nil {
		t.Fatal(err)
	}
	list, err := db.ListText2SQLGoldenQueries(ctx, true)
	if err != nil || len(list) != 1 || list[0].Name != "dept counts" {
		t.Fatalf("golden list failed: %v %+v", err, list)
	}
	if err := db.DeleteText2SQLGoldenQuery(ctx, "g1"); err != nil {
		t.Fatal(err)
	}
	if list, _ := db.ListText2SQLGoldenQueries(ctx, false); len(list) != 0 {
		t.Errorf("expected golden query deleted, got %d", len(list))
	}
}

var testIDCounter int

func newTestID() string {
	testIDCounter++
	return "t2s_" + time.Now().Format("150405.000000") + "_" + itoaTest(testIDCounter)
}

func itoaTest(n int) string {
	if n == 0 {
		return "0"
	}
	var b [12]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
