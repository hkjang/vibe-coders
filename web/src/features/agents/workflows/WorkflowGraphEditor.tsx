import { useId, useState } from "react";
import type { GraphInput, GraphStep } from "@/shared/api/domains/workflow-graph.schemas";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import { WorkflowGraphDiagram } from "./WorkflowGraphDiagram";
import {
  addGraphStep,
  changeGraphType,
  graphEnd,
  graphTypes,
  graphTypeLabels,
  graphWhenLabels,
  removeGraphStep,
} from "./workflow-graph-model";

export function WorkflowGraphEditor({
  draft,
  onChange,
  disabled,
}: {
  draft: GraphInput;
  onChange: (value: GraphInput) => void;
  disabled: boolean;
}) {
  const prefix = useId();
  const [selected, setSelected] = useState(draft.flow.entry);
  const step = draft.steps.find((item) => item.id === selected) ?? draft.steps[0];
  const options = draft.steps.map((item) => ({
    value: item.id,
    label: `${item.name || "이름 없음"} (${item.id})`,
  }));
  const update = (change: Partial<GraphStep>) => {
    if (!step || disabled) return;
    onChange({
      ...draft,
      steps: draft.steps.map((item) => (item.id === step.id ? { ...item, ...change } : item)),
    });
  };
  const add = () => {
    if (disabled) return;
    const next = addGraphStep(draft);
    onChange(next);
    setSelected(next.steps.at(-1)?.id ?? "");
  };
  return (
    <div className="workflow-graph-editor">
      <p>
        시작 단계에서 연결을 따라 한 경로씩 실행합니다. 조건의 참·거짓 경로와 마지막 종료를 지정하세요. 아래
        선택 상자로도 모든 연결을 편집할 수 있습니다.
      </p>
      <WorkflowGraphDiagram draft={draft} selected={step?.id} onSelect={disabled ? undefined : setSelected} />
      <fieldset disabled={disabled} className="workflow-graph-editor">
        <div className="workflow-graph-toolbar">
          <label htmlFor={`${prefix}-entry`}>시작 단계</label>
          <Select
            id={`${prefix}-entry`}
            value={draft.flow.entry}
            placeholder="시작 단계 선택"
            options={options}
            onChange={(event) => onChange({ ...draft, flow: { ...draft.flow, entry: event.target.value } })}
          />
          <Button onClick={add} disabled={draft.steps.length >= 128}>
            단계 추가
          </Button>
        </div>
        {step ? (
          <>
            <label htmlFor={`${prefix}-selected`}>편집할 단계</label>
            <Select
              id={`${prefix}-selected`}
              value={step.id}
              options={options}
              onChange={(event) => setSelected(event.target.value)}
            />
            <div className="workflow-graph-fields">
              <label htmlFor={`${prefix}-name`}>
                단계 이름
                <Input
                  id={`${prefix}-name`}
                  value={step.name}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </label>
              <label htmlFor={`${prefix}-type`}>
                단계 종류
                <Select
                  id={`${prefix}-type`}
                  value={step.type}
                  options={graphTypes.map((type) => ({ value: type, label: graphTypeLabels[type] }))}
                  onChange={(event) =>
                    onChange(changeGraphType(draft, step.id, event.target.value as GraphStep["type"]))
                  }
                />
              </label>
              {["chat", "skill", "mcp_tool"].includes(step.type) ? (
                <label htmlFor={`${prefix}-ref`}>
                  {step.type === "chat"
                    ? "모델 이름"
                    : step.type === "skill"
                      ? "스킬 이름"
                      : "MCP 도구 전체 이름"}
                  <Input
                    id={`${prefix}-ref`}
                    value={step.ref ?? ""}
                    onChange={(event) => update({ ref: event.target.value })}
                  />
                </label>
              ) : null}
              {["chat", "skill", "text2sql", "mcp_tool"].includes(step.type) ? (
                <label htmlFor={`${prefix}-timeout`}>
                  시간 제한 (밀리초, 0은 추가 제한 없음)
                  <Input
                    id={`${prefix}-timeout`}
                    type="number"
                    min={0}
                    max={300000}
                    value={step.timeout_ms ?? ""}
                    onChange={(event) =>
                      update({
                        timeout_ms: event.target.value === "" ? undefined : Number(event.target.value),
                      })
                    }
                  />
                </label>
              ) : null}
              {["chat", "skill"].includes(step.type) ? (
                <label htmlFor={`${prefix}-tokens`}>
                  최대 출력 토큰 (0은 추가 제한 없음)
                  <Input
                    id={`${prefix}-tokens`}
                    type="number"
                    min={0}
                    max={1000000}
                    value={step.max_tokens ?? ""}
                    onChange={(event) =>
                      update({
                        max_tokens: event.target.value === "" ? undefined : Number(event.target.value),
                      })
                    }
                  />
                </label>
              ) : null}
              {step.type === "mcp_tool" ? (
                <label htmlFor={`${prefix}-tools`}>
                  허용 도구 전체 이름 (쉼표로 구분)
                  <Input
                    id={`${prefix}-tools`}
                    value={step.allowed_tools?.join(", ") ?? ""}
                    onChange={(event) =>
                      update({
                        allowed_tools: event.target.value
                          .split(",")
                          .map((value) => value.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
              ) : null}
              {step.type === "condition" ? (
                <>
                  <label htmlFor={`${prefix}-condition`}>
                    비교 방식
                    <Select
                      id={`${prefix}-condition`}
                      value={step.condition?.operator ?? "non_empty"}
                      options={[
                        { value: "non_empty", label: "입력이 비어 있지 않음" },
                        { value: "equals", label: "입력이 정확히 일치함" },
                        { value: "contains", label: "입력에 문구가 포함됨" },
                      ]}
                      onChange={(event) =>
                        update({
                          condition: {
                            operator: event.target.value as "non_empty" | "equals" | "contains",
                            ...(event.target.value === "non_empty"
                              ? {}
                              : { value: step.condition?.value ?? "" }),
                          },
                        })
                      }
                    />
                  </label>
                  {step.condition?.operator !== "non_empty" ? (
                    <label htmlFor={`${prefix}-value`}>
                      비교할 문구
                      <Input
                        id={`${prefix}-value`}
                        value={step.condition?.value ?? ""}
                        onChange={(event) =>
                          update({
                            condition: {
                              operator: step.condition?.operator ?? "equals",
                              value: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                  ) : null}
                </>
              ) : null}
              {draft.flow.edges
                .filter((edge) => edge.from === step.id)
                .map((edge) => (
                  <label key={edge.when} htmlFor={`${prefix}-${edge.when}`}>
                    {graphWhenLabels[edge.when]} 연결
                    <Select
                      id={`${prefix}-${edge.when}`}
                      value={edge.to}
                      placeholder="대상을 다시 선택하세요"
                      options={[{ value: graphEnd, label: "종료" }, ...options]}
                      onChange={(event) =>
                        onChange({
                          ...draft,
                          flow: {
                            ...draft.flow,
                            edges: draft.flow.edges.map((item) =>
                              item === edge ? { ...item, to: event.target.value } : item,
                            ),
                          },
                        })
                      }
                    />
                  </label>
                ))}
            </div>
            <label htmlFor={`${prefix}-note`}>단계 설명</label>
            <Textarea
              id={`${prefix}-note`}
              rows={2}
              value={step.note ?? ""}
              onChange={(event) => update({ note: event.target.value })}
            />
            <p>
              종류를 바꾸면 해당 단계의 참조·조건·한도·나가는 연결을 초기화합니다. 저장 전 변경 내용을
              확인하세요.
            </p>
            {step.type === "mcp_tool" ? (
              <p>
                MCP 단계는 실제 도구를 호출합니다. 이전 출력이 JSON 객체여야 하며, 텍스트 응답을 다음 단계로
                전달합니다. 기존 인증·권한·도구 정책을 적용합니다.
              </p>
            ) : null}
            {step.type === "approval" ? (
              <p>
                승인 대기에서 실행을 멈춥니다. 현재 자동 재개는 지원하지 않으므로 다음 연결은 종료를
                선택하세요.
              </p>
            ) : null}
            {step.type === "transform" ? <p>입력을 바꾸지 않고 다음 단계로 전달합니다.</p> : null}
            <Button
              variant="danger"
              disabled={draft.steps.length <= 1}
              onClick={() => onChange(removeGraphStep(draft, step.id))}
            >
              선택한 단계 삭제
            </Button>
          </>
        ) : null}
      </fieldset>
    </div>
  );
}
