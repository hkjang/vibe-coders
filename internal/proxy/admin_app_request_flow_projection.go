package proxy

import (
	"encoding/json"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"vibe-coders/internal/secret"
	"vibe-coders/internal/store"
)

func appFlowSpanRef(cipher *secret.Cipher, root, kind, id string) string {
	value, _ := json.Marshal([]string{root, kind, id})
	return "span_" + cipher.OpaqueReference("app-request-flow-span", string(value))
}

func appFlowChildIDValid(id string) bool {
	return len(id) > 0 && len(id) <= appRequestIDMaxBytes && utf8.ValidString(id) &&
		strings.IndexFunc(id, unicode.IsControl) < 0
}

func appFlowRecordedTime(value string, root time.Time) (*string, *int64) {
	if len(value) > 35 {
		return nil, nil
	}
	at, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || at.Year() < 0 || at.Year() > 9999 {
		return nil, nil
	}
	canonical := at.UTC().Format(appRequestTimestampLayout)
	if len(canonical) != len(appRequestTimestampLayout) {
		return nil, nil
	}
	// Unix seconds for RFC3339's four-digit years fit int64. Avoid time.Sub's
	// duration saturation for records separated by more than about 290 years.
	seconds := at.Unix() - root.Unix()
	nanos := int64(at.Nanosecond() - root.Nanosecond())
	if seconds > 0 && nanos < 0 {
		seconds--
		nanos += int64(time.Second)
	} else if seconds < 0 && nanos > 0 {
		seconds++
		nanos -= int64(time.Second)
	}
	ms := seconds*1000 + nanos/int64(time.Millisecond)
	if ms < -appRequestMaxSafeInteger || ms > appRequestMaxSafeInteger {
		return &canonical, nil
	}
	return &canonical, &ms
}

func appFlowDuration(value *int64) *int64 {
	if value == nil || *value < 0 || *value > appRequestMaxSafeInteger {
		return nil
	}
	result := *value
	return &result
}

func appFlowRootStatus(code *int64) string {
	if code == nil || *code < 100 || *code > 599 {
		return "unknown"
	}
	if *code >= 400 {
		return "error"
	}
	return "ok"
}

func appFlowStatus(value string) string {
	switch value {
	case "ok", "error", "skipped":
		return value
	default:
		return "unknown"
	}
}

func appFlowStage(value string) string {
	switch value {
	case "classify":
		return "질문 분류"
	case "schema_resolve":
		return "스키마 확인"
	case "glossary_apply":
		return "용어 사전 적용"
	case "sql_generate":
		return "SQL 생성"
	case "sql_validate":
		return "SQL 검증"
	case "explain_guard":
		return "실행 계획 검사"
	case "execute":
		return "쿼리 실행"
	case "mask_result":
		return "결과 표시 보호"
	case "summarize":
		return "결과 요약"
	case "evaluate":
		return "결과 평가"
	default:
		return "Text2SQL 단계 미확인"
	}
}

func (s *Server) projectAppRequestFlow(ref string, at time.Time, root store.AppRequestFlowRoot, tools []store.AppRequestFlowTool, toolsTruncated bool, sqlSpans []store.AppRequestFlowText2SQL, sqlTruncated bool, cipher *secret.Cipher) appRequestFlowResponse {
	rootRef := appFlowSpanRef(cipher, root.RequestID, "request", root.RequestID)
	recorded, offset := appFlowRecordedTime(root.CreatedAt, at)
	result := appRequestFlowResponse{
		FlowVersion: 1, RequestRef: ref, CreatedAt: at.UTC().Format(appRequestTimestampLayout),
		GeneratedAt: time.Now().UTC().Format(appRequestTimestampLayout),
		Spans: []appRequestFlowSpan{{SpanRef: rootRef, Kind: "request", Name: "요청 기록",
			Status: appFlowRootStatus(root.StatusCode), RecordedAt: recorded, OffsetMS: offset, DurationMS: appFlowDuration(root.LatencyMS)}},
	}
	result.Coverage.Tools = appRequestFlowCoverage{Limit: store.AppRequestFlowChildLimit, Truncated: toolsTruncated}
	result.Coverage.Text2SQL = appRequestFlowCoverage{Limit: store.AppRequestFlowChildLimit, Truncated: sqlTruncated}
	if len(tools) > store.AppRequestFlowChildLimit {
		tools = tools[:store.AppRequestFlowChildLimit]
		result.Coverage.Tools.Truncated = true
	}
	if len(sqlSpans) > store.AppRequestFlowChildLimit {
		sqlSpans = sqlSpans[:store.AppRequestFlowChildLimit]
		result.Coverage.Text2SQL.Truncated = true
	}
	seen := map[string]bool{rootRef: true}
	for _, item := range tools {
		kind := "tool"
		if item.IsMCP != nil && *item.IsMCP == 1 {
			kind = "mcp_tool"
		}
		childRef := appFlowSpanRef(cipher, root.RequestID, kind, item.ID)
		if item.Source != "call" || !appFlowChildIDValid(item.ID) || seen[childRef] {
			result.Coverage.Tools.Omitted++
			continue
		}
		seen[childRef] = true
		status := "unknown"
		if item.IsError != nil && *item.IsError == 0 {
			status = "ok"
		} else if item.IsError != nil && *item.IsError == 1 {
			status = "error"
		}
		name := item.ToolName
		if item.ServerLabel != "" {
			name = item.ServerLabel + "." + name
		}
		name = s.projectAppRequestText(name, appRequestModelMaxBytes)
		if strings.TrimSpace(name) == "" {
			name = "도구 호출"
		}
		recorded, offset := appFlowRecordedTime(item.CreatedAt, at)
		result.Spans = append(result.Spans, appRequestFlowSpan{SpanRef: childRef, ParentRef: &rootRef,
			Kind: kind, Name: name, Status: status, RecordedAt: recorded, OffsetMS: offset})
	}
	for _, item := range sqlSpans {
		childRef := appFlowSpanRef(cipher, root.RequestID, "text2sql", item.ID)
		if !appFlowChildIDValid(item.ID) || seen[childRef] {
			result.Coverage.Text2SQL.Omitted++
			continue
		}
		seen[childRef] = true
		recorded, offset := appFlowRecordedTime(item.CreatedAt, at)
		result.Spans = append(result.Spans, appRequestFlowSpan{SpanRef: childRef, ParentRef: &rootRef,
			Kind: "text2sql", Name: appFlowStage(item.Stage), Status: appFlowStatus(item.Status),
			RecordedAt: recorded, OffsetMS: offset, DurationMS: appFlowDuration(item.LatencyMS)})
	}
	sort.Slice(result.Spans[1:], func(i, j int) bool {
		a, b := result.Spans[i+1], result.Spans[j+1]
		if a.RecordedAt == nil && b.RecordedAt != nil {
			return false
		}
		if a.RecordedAt != nil && b.RecordedAt == nil {
			return true
		}
		if a.RecordedAt != nil && b.RecordedAt != nil && *a.RecordedAt != *b.RecordedAt {
			return *a.RecordedAt < *b.RecordedAt
		}
		return a.SpanRef < b.SpanRef
	})
	return result
}
