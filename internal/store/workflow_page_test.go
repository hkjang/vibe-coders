package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestWorkflowPageSearchSortBoundsAndProjection(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	read := func(query WorkflowQuery) WorkflowPage {
		t.Helper()
		page, err := db.ListWorkflowPage(t.Context(), query)
		if err != nil {
			t.Fatal(err)
		}
		return page
	}
	empty := read(WorkflowQuery{Limit: 25})
	if empty.Total != 0 || empty.Summary.Total != 0 || empty.Workflows == nil || len(empty.Workflows) != 0 {
		t.Fatal("empty database must return an empty array and zero counts")
	}
	for index := range 37 {
		wf := Workflow{ID: fmt.Sprintf("wf-%02d", index), Name: fmt.Sprintf("업무 %02d", index),
			Description: "ÉCOLE 설명", AllowedTeams: "개발팀", Enabled: index%2 == 0,
			CreatedAt: "2026-11-12T00:00:00Z", CreatedBy: "운영자",
			Steps: []WorkflowStep{{Name: "질문", Type: "chat", Note: "definition-only-marker"}, {Name: "승인", Type: "approval"}}}
		if index == 0 {
			wf.Name = "literal %_! name"
		}
		if err := db.UpsertWorkflow(t.Context(), wf); err != nil {
			t.Fatal(err)
		}
	}
	first := read(WorkflowQuery{Limit: 25})
	second := read(WorkflowQuery{Limit: 25, Offset: 25})
	if first.Total != 37 || second.Total != 37 || len(first.Workflows) != 25 || len(second.Workflows) != 12 || first.Summary != (WorkflowSummary{Total: 37, Enabled: 19}) {
		t.Fatal("page, filtered total or global summary differs")
	}
	for index, row := range append(first.Workflows, second.Workflows...) {
		if row.ID != fmt.Sprintf("wf-%02d", index) || row.StepCount != 2 || row.CreatedBy != "운영자" {
			t.Fatal("equal timestamp pagination is unstable or metadata changed")
		}
	}
	encoded, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "definition-only-marker") || strings.Contains(string(encoded), `"steps"`) {
		t.Fatal("list must not expose step definitions")
	}
	out := read(WorkflowQuery{Limit: 25, Offset: 100})
	if out.Total != 37 || out.Summary != first.Summary || len(out.Workflows) != 0 || out.Workflows == nil {
		t.Fatal("out-of-range page lost counts")
	}
	yes, no := true, false
	for _, tc := range []struct {
		query WorkflowQuery
		total int64
	}{
		{WorkflowQuery{Search: "%_!"}, 1}, {WorkflowQuery{Search: "WF-03"}, 1},
		{WorkflowQuery{Search: "école"}, 37}, {WorkflowQuery{Search: "개발팀"}, 37},
		{WorkflowQuery{Enabled: &yes}, 19}, {WorkflowQuery{Enabled: &no}, 18},
		{WorkflowQuery{Search: "wf-03", Enabled: &yes}, 0},
	} {
		tc.query.Limit = 100
		page := read(tc.query)
		if page.Total != tc.total || int64(len(page.Workflows)) != tc.total || page.Summary != first.Summary {
			t.Fatal("literal/unicode search or status filter changed global summary")
		}
	}
	ordered := read(WorkflowQuery{Limit: 100, Sort: []WorkflowSort{{Field: "enabled", Desc: true}, {Field: "id", Desc: true}}})
	if ordered.Workflows[0].ID != "wf-36" || ordered.Workflows[18].ID != "wf-00" || ordered.Workflows[19].ID != "wf-35" {
		t.Fatal("multi-column order not applied before paging")
	}
	legacy, err := db.ListWorkflows(t.Context())
	if err != nil || len(legacy) != 37 {
		t.Fatal("legacy list changed")
	}
	for _, original := range legacy {
		detail, found, err := db.GetWorkflow(t.Context(), original.ID)
		if err != nil || !found || !reflect.DeepEqual(detail, original) {
			t.Fatal("detail differs from legacy definition")
		}
	}
}

func TestWorkflowPageTimestampPrecisionAndLegacyDefinition(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	for index, stamp := range []string{"2026-11-12T00:00:00Z", "2026-11-12T00:00:00.000000001Z", "2026-11-12T00:00:00.1Z"} {
		if err := db.UpsertWorkflow(t.Context(), Workflow{ID: fmt.Sprintf("wf-%d", index), Name: "timestamp", CreatedAt: stamp}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.db.ExecContext(t.Context(), `UPDATE workflows SET enabled = 2, steps = 'invalid legacy JSON' WHERE id = 'wf-1'`); err != nil {
		t.Fatal(err)
	}
	page, err := db.ListWorkflowPage(t.Context(), WorkflowQuery{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if page.Workflows[0].ID != "wf-2" || page.Workflows[1].ID != "wf-1" || page.Workflows[2].ID != "wf-0" || page.Summary.Enabled != 1 || !page.Workflows[1].Enabled || page.Workflows[1].StepCount != 0 {
		t.Fatal("timestamp precision or legacy bool/definition semantics changed")
	}
}

func TestWorkflowPageRejectsInvalidQueryAndCancellation(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	for _, query := range []WorkflowQuery{
		{Limit: 0}, {Limit: 101}, {Limit: 25, Offset: -1}, {Limit: 25, Offset: 1_000_001},
		{Limit: 25, Search: strings.Repeat("한", 201)}, {Limit: 25, Search: "\xff"}, {Limit: 25, Search: "a\nb"},
		{Limit: 25, Sort: []WorkflowSort{{Field: "name; DROP TABLE workflows"}}},
		{Limit: 25, Sort: []WorkflowSort{{Field: "name"}, {Field: "name"}}},
		{Limit: 25, Sort: []WorkflowSort{{Field: "name"}, {Field: "id"}, {Field: "created_at"}, {Field: "updated_at"}}},
	} {
		if _, err := db.ListWorkflowPage(t.Context(), query); !errors.Is(err, ErrInvalidWorkflowQuery) {
			t.Fatal("invalid query accepted")
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := db.ListWorkflowPage(ctx, WorkflowQuery{Limit: 25}); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled query did not stop")
	}
	for _, id := range []string{"", "\xff", "a\nb", strings.Repeat("x", 4097)} {
		if ValidWorkflowDetailID(id) {
			t.Fatal("invalid detail identifier accepted")
		}
	}
	for _, id := range []string{" wf / & ? # ", "워크플로", strings.Repeat("x", 4096)} {
		if !ValidWorkflowDetailID(id) {
			t.Fatal("valid exact detail identifier rejected")
		}
	}
}

func TestWorkflowPagePersonalHistoryNamesPreserveOwnership(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	for _, id := range []string{"first", "outside-page"} {
		if err := db.UpsertWorkflow(t.Context(), Workflow{ID: id, Name: "업무 " + id, Steps: []WorkflowStep{{Type: "chat", Note: "definition-only-marker"}}}); err != nil {
			t.Fatal(err)
		}
	}
	for _, run := range []WorkflowRun{{ID: "mine", WorkflowID: "outside-page", UserID: "alice"}, {ID: "other", WorkflowID: "first", UserID: "bob"}, {ID: "deleted", WorkflowID: "gone", UserID: "alice"}} {
		if err := db.RecordWorkflowRun(t.Context(), run); err != nil {
			t.Fatal(err)
		}
	}
	runs, err := db.ListWorkflowRuns(t.Context(), "alice", "outside-page", 10)
	if err != nil || len(runs) != 1 || runs[0].ID != "mine" || runs[0].WorkflowName != "업무 outside-page" {
		t.Fatal("history name/filter/ownership mismatch")
	}
	body, err := json.Marshal(runs)
	if err != nil || strings.Contains(string(body), "definition-only-marker") {
		t.Fatal("history exposed a definition")
	}
	if err := db.DeleteWorkflow(t.Context(), "outside-page"); err != nil {
		t.Fatal(err)
	}
	runs, err = db.ListWorkflowRuns(t.Context(), "alice", "", 10)
	if err != nil || len(runs) != 2 {
		t.Fatal("deleted definition removed its owner's history")
	}
	for _, run := range runs {
		if run.UserID != "alice" || run.WorkflowName != "" {
			t.Fatal("history join broadened ownership or fabricated name")
		}
	}
}
