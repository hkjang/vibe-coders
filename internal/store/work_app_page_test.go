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

func TestWorkAppPageSearchSortBoundsAndProjection(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	read := func(query WorkAppQuery) WorkAppPage {
		t.Helper()
		page, err := db.ListWorkAppPage(t.Context(), query)
		if err != nil {
			t.Fatal(err)
		}
		return page
	}
	empty := read(WorkAppQuery{Limit: 25})
	if empty.Total != 0 || empty.Summary.Total != 0 || empty.Apps == nil || len(empty.Apps) != 0 {
		t.Fatal("empty database must return an empty array and zero counts")
	}
	for index := range 37 {
		wf := WorkApp{ID: fmt.Sprintf("app-%02d", index), Title: fmt.Sprintf("업무 %02d", index),
			Description: "ÉCOLE 설명", AllowedTeams: "개발팀", AllowedRoles: "auditor", Status: []string{"active", "archived"}[index%2],
			CreatedAt: "2026-11-12T00:00:00Z", Owner: "운영자",
			Components: []AppComponent{{Label: "질문", Kind: "model", Ref: "definition-only-marker"}, {Label: "도구", Kind: "mcp_tool"}}}
		if index == 0 {
			wf.Title = "literal %_! name"
		}
		if err := db.CreateWorkApp(t.Context(), wf); err != nil {
			t.Fatal(err)
		}
	}
	first := read(WorkAppQuery{Limit: 25})
	second := read(WorkAppQuery{Limit: 25, Offset: 25})
	if first.Total != 37 || second.Total != 37 || len(first.Apps) != 25 || len(second.Apps) != 12 || first.Summary != (WorkAppSummary{Total: 37, Active: 19, Archived: 18}) {
		t.Fatal("page, filtered total or global summary differs")
	}
	for index, row := range append(first.Apps, second.Apps...) {
		if row.ID != fmt.Sprintf("app-%02d", index) || row.ComponentCount != 2 || row.Owner != "운영자" {
			t.Fatal("pagination is unstable or metadata changed")
		}
	}
	encoded, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "definition-only-marker") || strings.Contains(string(encoded), `"components"`) {
		t.Fatal("list must not expose step definitions")
	}
	out := read(WorkAppQuery{Limit: 25, Offset: 100})
	if out.Total != 37 || out.Summary != first.Summary || len(out.Apps) != 0 || out.Apps == nil {
		t.Fatal("out-of-range page lost counts")
	}
	for _, tc := range []struct {
		query WorkAppQuery
		total int64
	}{
		{WorkAppQuery{Search: "%_!"}, 1}, {WorkAppQuery{Search: "APP-03"}, 1},
		{WorkAppQuery{Search: "école"}, 37}, {WorkAppQuery{Search: "개발팀"}, 37},
		{WorkAppQuery{Search: "운영자"}, 37}, {WorkAppQuery{Search: "AUDITOR"}, 37},
		{WorkAppQuery{Status: "active"}, 19}, {WorkAppQuery{Status: "archived"}, 18},
		{WorkAppQuery{Search: "app-03", Status: "active"}, 0},
	} {
		tc.query.Limit = 100
		page := read(tc.query)
		if page.Total != tc.total || int64(len(page.Apps)) != tc.total || page.Summary != first.Summary {
			t.Fatal("literal/unicode search or status filter changed global summary")
		}
	}
	ordered := read(WorkAppQuery{Limit: 100, Sort: []WorkAppSort{{Field: "status"}, {Field: "id", Desc: true}}})
	if ordered.Apps[0].ID != "app-36" || ordered.Apps[18].ID != "app-00" || ordered.Apps[19].ID != "app-35" {
		t.Fatal("multi-column order not applied before paging")
	}
	legacy, err := db.ListWorkApps(t.Context())
	if err != nil || len(legacy) != 37 {
		t.Fatal("legacy list changed")
	}
	for _, original := range legacy {
		detail, found, err := db.GetWorkApp(t.Context(), original.ID)
		if err != nil || !found || !reflect.DeepEqual(detail, original) {
			t.Fatal("detail differs from legacy definition")
		}
	}
}

func TestWorkAppPageRejectsInvalidQueryAndCancellation(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	for _, query := range []WorkAppQuery{
		{Limit: 25, Status: "unknown"},
		{Limit: 0}, {Limit: 101}, {Limit: 25, Offset: -1}, {Limit: 25, Offset: 1_000_001},
		{Limit: 25, Search: strings.Repeat("한", 201)}, {Limit: 25, Search: "\xff"}, {Limit: 25, Search: "a\nb"},
		{Limit: 25, Sort: []WorkAppSort{{Field: "title; DROP TABLE work_apps"}}},
		{Limit: 25, Sort: []WorkAppSort{{Field: "title"}, {Field: "title"}}},
		{Limit: 25, Sort: []WorkAppSort{{Field: "title"}, {Field: "id"}, {Field: "created_at"}, {Field: "updated_at"}}},
	} {
		if _, err := db.ListWorkAppPage(t.Context(), query); !errors.Is(err, ErrInvalidWorkAppQuery) {
			t.Fatal("invalid query accepted")
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := db.ListWorkAppPage(ctx, WorkAppQuery{Limit: 25}); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled query did not stop")
	}
	for _, id := range []string{"", "\xff", "a\nb", strings.Repeat("x", 4097)} {
		if ValidWorkAppDetailID(id) {
			t.Fatal("invalid detail identifier accepted")
		}
	}
	for _, id := range []string{" wf / & ? # ", "워크플로", strings.Repeat("x", 4096)} {
		if !ValidWorkAppDetailID(id) {
			t.Fatal("valid exact detail identifier rejected")
		}
	}
}

func TestWorkAppPageTimestampPrecisionAndLegacyComponents(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	for index, stamp := range []string{"2026-11-12T00:00:00Z", "2026-11-12T00:00:00.000000001Z", "2026-11-12T00:00:00.1Z"} {
		id := fmt.Sprintf("app-%d", index)
		if err := db.CreateWorkApp(t.Context(), WorkApp{ID: id, Title: "same", Status: "active"}); err != nil {
			t.Fatal(err)
		}
		if _, err := db.db.ExecContext(t.Context(), db.bind(`UPDATE work_apps SET created_at = ?, updated_at = ? WHERE id = ?`), stamp, stamp, id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.db.ExecContext(t.Context(), `UPDATE work_apps SET status = 'legacy', components = 'invalid legacy JSON' WHERE id = 'app-1'`); err != nil {
		t.Fatal(err)
	}
	page, err := db.ListWorkAppPage(t.Context(), WorkAppQuery{Limit: 10, Sort: []WorkAppSort{{Field: "created_at", Desc: true}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Apps) != 3 || page.Apps[0].ID != "app-2" || page.Apps[1].ID != "app-1" || page.Apps[2].ID != "app-0" || page.Summary != (WorkAppSummary{Total: 3, Active: 2, Unscoped: 3}) || page.Apps[1].Status != "legacy" || page.Apps[1].ComponentCount != 0 {
		t.Fatal("timestamp precision, unknown legacy status or component semantics changed")
	}
	first, err := db.ListWorkAppPage(t.Context(), WorkAppQuery{Limit: 1})
	if err != nil || len(first.Apps) != 1 || first.Apps[0].ID != "app-0" {
		t.Fatal("equal titles must have deterministic ID ordering")
	}
}

func TestWorkAppPageUnscopedSummaryAndOwnRunTitles(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	for _, app := range []WorkApp{
		{ID: "mine", Title: "페이지 밖 업무", AllowedTeams: "other-team"},
		{ID: "unscoped", Title: "공개 범위 미지정"},
		{ID: "spaces", Title: "기존 공백 범위", AllowedRoles: " "},
	} {
		if err := db.CreateWorkApp(t.Context(), app); err != nil {
			t.Fatal(err)
		}
	}
	page, err := db.ListWorkAppPage(t.Context(), WorkAppQuery{Search: "공개", Limit: 1})
	if err != nil || page.Total != 1 || page.Summary.Total != 3 || page.Summary.Unscoped != 1 {
		t.Fatal("unscoped summary must match exact legacy empty team and role values independently of filters")
	}
	for _, run := range []AIAppRun{
		{ID: "alice-app", AppID: "mine", UserID: "alice"},
		{ID: "alice-missing", AppID: "missing", UserID: "alice"},
		{ID: "bob-app", AppID: "mine", UserID: "bob"},
	} {
		if err := db.RecordAIAppRun(t.Context(), run); err != nil {
			t.Fatal(err)
		}
	}
	runs, err := db.ListAIAppRuns(t.Context(), "alice", "mine", 50)
	if err != nil || len(runs) != 1 || runs[0].ID != "alice-app" || runs[0].AppTitle != "페이지 밖 업무" {
		t.Fatal("current title or own-user/app filter changed")
	}
	if _, err := db.db.ExecContext(t.Context(), `DELETE FROM work_apps WHERE id = 'mine'`); err != nil {
		t.Fatal(err)
	}
	runs, err = db.ListAIAppRuns(t.Context(), "alice", "", 50)
	if err != nil || len(runs) != 2 {
		t.Fatal("deleted definitions must preserve run history")
	}
	for _, run := range runs {
		if run.UserID != "alice" || run.AppTitle != "" {
			t.Fatal("run ownership or missing-title fallback changed")
		}
	}
}
