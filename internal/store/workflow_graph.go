package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// WorkflowFlow opts a definition into explicit graph execution. A nil flow keeps
// the historical sequence semantics. Version 1 is a bounded, single-path DAG:
// conditions choose one edge and merges do not run parallel branches.
type WorkflowFlow struct {
	Version int            `json:"version"`
	Entry   string         `json:"entry"`
	Edges   []WorkflowEdge `json:"edges"`
}

type WorkflowEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
	When string `json:"when"` // next | true | false
}

// Conditions compare the current text input. They never evaluate expressions,
// scripts, templates or SQL. Exact comparison is case-sensitive; non_empty
// ignores surrounding whitespace.
type WorkflowCondition struct {
	Operator string `json:"operator"` // non_empty | equals | contains
	Value    string `json:"value,omitempty"`
}

const WorkflowGraphEnd = "$end"
const WorkflowGraphMaxSteps = 128

var ErrInvalidWorkflowGraph = errors.New("invalid workflow graph")
var ErrWorkflowGraphEditRequired = errors.New("workflow graph must be edited with its complete flow")
var workflowStepIDPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)

// ValidateWorkflowGraph performs bounded structural validation before any
// runtime side effect. It is also used by persistence so non-HTTP callers cannot
// store a malformed graph. Legacy definitions remain sequence definitions.
func ValidateWorkflowGraph(wf Workflow) error {
	bad := func(message string) error { return fmt.Errorf("%w: %s", ErrInvalidWorkflowGraph, message) }
	if wf.Flow == nil {
		for _, step := range wf.Steps {
			if step.ID != "" || step.Condition != nil {
				return bad("분기 단계에는 실행 흐름 정의가 필요합니다")
			}
		}
		return nil
	}
	flow := wf.Flow
	if flow.Version != 1 || len(wf.Steps) < 1 || len(wf.Steps) > WorkflowGraphMaxSteps || len(flow.Edges) > 2*WorkflowGraphMaxSteps {
		return bad("지원하는 흐름 버전은 1이며 단계는 1~128개여야 합니다")
	}
	steps := make(map[string]WorkflowStep, len(wf.Steps))
	for _, step := range wf.Steps {
		if !workflowStepIDPattern.MatchString(step.ID) {
			return bad("단계 식별자는 영문자로 시작하는 64자 이내의 영문·숫자·밑줄·하이픈이어야 합니다")
		}
		if _, found := steps[step.ID]; found {
			return bad("단계 식별자가 중복되었습니다")
		}
		steps[step.ID] = step
		switch step.Type {
		case "chat", "skill", "text2sql", "mcp_tool", "approval", "transform":
			if step.Condition != nil {
				return bad("조건식은 조건 단계에만 지정할 수 있습니다")
			}
		case "condition":
			if step.Condition == nil {
				return bad("조건 단계에 비교 방식을 지정하세요")
			}
			c := step.Condition
			if !utf8.ValidString(c.Value) || len(c.Value) > 4096 {
				return bad("비교할 값은 UTF-8 기준 4096바이트 이하여야 합니다")
			}
			switch c.Operator {
			case "non_empty":
				if c.Value != "" {
					return bad("입력 유무 조건에는 비교 값을 지정하지 않습니다")
				}
			case "equals":
			case "contains":
				if c.Value == "" {
					return bad("포함 조건에는 비교할 값을 입력하세요")
				}
			default:
				return bad("지원하지 않는 조건 비교 방식입니다")
			}
		default:
			return bad("지원하지 않는 단계 종류입니다")
		}
		if (step.Type == "skill" || step.Type == "mcp_tool") && strings.TrimSpace(step.Ref) == "" {
			return bad("스킬과 MCP 도구 단계에는 참조 이름이 필요합니다")
		}
		// These legacy metadata fields are not enforcement mechanisms. Graph mode
		// rejects them rather than suggesting that an unenforced bound is active.
		if step.MaxCostKRW != 0 || len(step.AllowedTables) != 0 || (len(step.AllowedTools) != 0 && step.Type != "mcp_tool") {
			return bad("이 흐름에서는 단계별 비용·테이블 제한과 채팅 도구 제한을 지원하지 않습니다")
		}
		if step.TimeoutMS < 0 || step.TimeoutMS > 300000 || step.MaxTokens < 0 || step.MaxTokens > 1000000 {
			return bad("시간 제한은 0~300000밀리초, 토큰 제한은 0~1000000이어야 합니다")
		}
		if step.MaxTokens != 0 && step.Type != "chat" && step.Type != "skill" {
			return bad("토큰 제한은 채팅·스킬 단계에만 지정할 수 있습니다")
		}
	}
	if _, found := steps[flow.Entry]; !found {
		return bad("시작 단계가 존재하지 않습니다")
	}
	edges := make(map[string]map[string]string, len(steps))
	for _, edge := range flow.Edges {
		step, found := steps[edge.From]
		if !found {
			return bad("연결의 출발 단계가 존재하지 않습니다")
		}
		if _, found := steps[edge.To]; !found && edge.To != WorkflowGraphEnd {
			return bad("연결의 도착 단계가 존재하지 않습니다")
		}
		if (step.Type == "condition" && edge.When != "true" && edge.When != "false") || (step.Type != "condition" && edge.When != "next") {
			return bad("조건 단계는 참·거짓 연결을, 다른 단계는 다음 연결을 사용합니다")
		}
		if step.Type == "approval" && edge.To != WorkflowGraphEnd {
			return bad("승인 대기는 재개를 지원하지 않으므로 마지막 단계로 연결하세요")
		}
		if edges[edge.From] == nil {
			edges[edge.From] = map[string]string{}
		}
		if _, duplicate := edges[edge.From][edge.When]; duplicate {
			return bad("같은 단계의 연결 조건이 중복되었습니다")
		}
		edges[edge.From][edge.When] = edge.To
	}
	for id, step := range steps {
		want := 1
		if step.Type == "condition" {
			want = 2
		}
		if len(edges[id]) != want {
			return bad("모든 단계에 다음 연결 또는 참·거짓 연결을 지정하세요. 마지막 연결은 종료를 선택하세요")
		}
	}
	colors := make(map[string]uint8, len(steps))
	var visit func(string) bool
	visit = func(id string) bool {
		if id == WorkflowGraphEnd || colors[id] == 2 {
			return true
		}
		if colors[id] == 1 {
			return false
		}
		colors[id] = 1
		for _, next := range edges[id] {
			if !visit(next) {
				return false
			}
		}
		colors[id] = 2
		return true
	}
	if !visit(flow.Entry) {
		return bad("단계를 반복하는 순환 연결은 허용하지 않습니다")
	}
	if len(colors) != len(steps) {
		return bad("시작 단계에서 도달할 수 없는 단계가 있습니다")
	}
	return nil
}

func (c WorkflowCondition) Matches(input string) bool {
	switch c.Operator {
	case "non_empty":
		return strings.TrimSpace(input) != ""
	case "equals":
		return input == c.Value
	case "contains":
		return strings.Contains(input, c.Value)
	default:
		return false
	}
}

func encodeWorkflowFlow(flow *WorkflowFlow) (string, error) {
	if flow == nil {
		return "", nil
	}
	data, err := json.Marshal(flow)
	return string(data), err
}

func decodeWorkflowFlow(raw string, flow **WorkflowFlow) error {
	if raw == "" {
		return nil
	}
	if err := json.Unmarshal([]byte(raw), flow); err != nil || *flow == nil {
		return fmt.Errorf("%w: 저장된 실행 흐름을 읽을 수 없습니다", ErrInvalidWorkflowGraph)
	}
	return nil
}
