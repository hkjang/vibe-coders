package proxy

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func appFlowInt(value int64) *int64 { return &value }

func TestAppRequestFlowProjectionUnknownAndBounded(t *testing.T) {
	f := newAppFlowHTTPFixture(t)
	root := store.AppRequestFlowRoot{RequestID: "projection-root", CreatedAt: f.at.Format(time.RFC3339Nano), StatusCode: appFlowInt(999), LatencyMS: appFlowInt(-1)}
	tools := []store.AppRequestFlowTool{
		{ID: "tool-unknown", ToolName: "공개 도구", Source: "call", CreatedAt: "not-a-time"},
		{ID: "tool-unknown", ToolName: "duplicate-must-omit", Source: "call"},
		{ID: "", Source: "call"}, {ID: "bad\x00id", Source: "call"}, {ID: strings.Repeat("a", 513), Source: "call"},
		{ID: "source-unknown", ToolName: "unknown-source-omit", Source: "private-source"},
		{ID: "long-display", ToolName: strings.Repeat("가", 257), Source: "call", CreatedAt: f.at.Add(time.Millisecond).Format(time.RFC3339Nano)},
	}
	sqlRows := []store.AppRequestFlowText2SQL{
		{ID: "sql-unknown", Stage: "private-stage", Status: "private-status", LatencyMS: appFlowInt(appRequestMaxSafeInteger + 1)},
		{ID: "sql-unknown", Stage: "duplicate"}, {ID: "", Stage: "invalid"},
	}
	result := f.server.projectAppRequestFlow("ref", f.at, root, tools, false, sqlRows, false, f.server.secrets.Load())
	if len(result.Spans) != 4 || result.Coverage.Tools.Omitted != 5 || result.Coverage.Text2SQL.Omitted != 2 {
		t.Fatalf("result=%+v", result)
	}
	if result.Spans[0].Status != "unknown" || result.Spans[0].DurationMS != nil {
		t.Fatal("unknown root fabricated")
	}
	for _, span := range result.Spans[1:] {
		if span.DurationMS != nil || span.Status != "unknown" || len(span.Name) > 256 {
			t.Fatalf("span=%+v", span)
		}
		if span.RecordedAt == nil && span.OffsetMS != nil {
			t.Fatal("unknown time has offset")
		}
	}
	if result.Spans[1].RecordedAt == nil {
		t.Fatal("known recorded time should sort before missing times")
	}
	body, _ := json.Marshal(result)
	assertLLMExternalBody(t, body, "private-stage", "private-status", "private-source", "duplicate-must-omit", "unknown-source-omit", strings.Repeat("가", 257))
}

func TestAppRequestFlowRecordedOffsetsAndLatency(t *testing.T) {
	root := time.Date(2026, 1, 1, 0, 0, 1, 500000000, time.UTC)
	at, offset := appFlowRecordedTime("2026-01-01T09:00:01.500000000+09:00", root)
	if at == nil || *at != "2026-01-01T00:00:01.500000000Z" || offset == nil || *offset != 0 {
		t.Fatal("valid imported offset must canonicalize without losing nanoseconds")
	}
	for _, tc := range []struct {
		delta time.Duration
		want  int64
	}{{-1500 * time.Millisecond, -1500}, {-999 * time.Microsecond, 0}, {999 * time.Microsecond, 0}, {1500 * time.Millisecond, 1500}} {
		recorded, offset := appFlowRecordedTime(root.Add(tc.delta).Format(time.RFC3339Nano), root)
		if recorded == nil || offset == nil || *offset != tc.want {
			t.Fatalf("delta=%v recorded=%v offset=%v", tc.delta, recorded, offset)
		}
	}
	far, offset := appFlowRecordedTime("9999-01-01T00:00:00Z", root)
	want := (time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC).Unix()-root.Unix())*1000 - 500
	if far == nil || offset == nil || *offset != want {
		t.Fatal("time.Sub saturation or timestamp precision loss")
	}
	for _, bad := range []string{"", "invalid", "2026-02-30T00:00:00Z"} {
		if at, offset := appFlowRecordedTime(bad, root); at != nil || offset != nil {
			t.Fatal("invalid time invented")
		}
	}
	for _, value := range []*int64{nil, appFlowInt(-1), appFlowInt(appRequestMaxSafeInteger + 1)} {
		if appFlowDuration(value) != nil {
			t.Fatal("invalid duration invented")
		}
	}
	for _, value := range []int64{0, 1, appRequestMaxSafeInteger} {
		if got := appFlowDuration(&value); got == nil || *got != value {
			t.Fatal("valid stored latency lost")
		}
	}
}

func TestAppRequestFlowOpenAPIContract(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	assertJSONOperationSchema(t, paths, "/admin/app/request-flow", "get", "200", "AppRequestFlowResponse")
	op := paths["/admin/app/request-flow"].(map[string]any)["get"].(map[string]any)
	if op["operationId"] != "get__admin_app_request_flow" {
		t.Fatalf("operation=%v", op["operationId"])
	}
	params := op["parameters"].([]any)
	if len(params) != 2 {
		t.Fatalf("parameters=%v", params)
	}
	for _, parameter := range params {
		if parameter.(map[string]any)["required"] != true {
			t.Fatal("optional lookup identity")
		}
	}
	responses := op["responses"].(map[string]any)
	for _, code := range []string{"400", "401", "404", "500"} {
		if responses[code] == nil {
			t.Fatalf("missing response %s", code)
		}
	}
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	response := schemas["AppRequestFlowResponse"].(map[string]any)
	span := schemas["AppRequestFlowSpan"].(map[string]any)
	if response["additionalProperties"] != false || span["additionalProperties"] != false || len(response["required"].([]string)) != 6 || len(span["required"].([]string)) != 8 {
		t.Fatal("loose/missing DTO properties")
	}
	props := response["properties"].(map[string]any)
	spans := props["spans"].(map[string]any)
	if spans["minItems"] != 1 || spans["maxItems"] != 201 {
		t.Fatal("span limits")
	}
	spanProps := span["properties"].(map[string]any)
	for _, field := range []string{"parent_ref", "recorded_at", "offset_ms", "duration_ms"} {
		if spanProps[field].(map[string]any)["nullable"] != true {
			t.Fatalf("%s must retain unknown", field)
		}
	}
	if spanProps["offset_ms"].(map[string]any)["minimum"] != -appRequestMaxSafeInteger {
		t.Fatal("negative offsets omitted")
	}
	for _, forbidden := range []string{"request_id", "error", "detail", "arguments", "prompt"} {
		if spanProps[forbidden] != nil {
			t.Fatalf("raw field %s", forbidden)
		}
	}
}
