import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useId } from "react";

import { workflowStepTypeLabels, workflowStepTypes } from "@/features/agents/workflows/workflow-form";
import {
  addStep,
  fieldText,
  hasAllowedTables,
  hasAllowedTools,
  hasLimits,
  moveStep,
  parseSteps,
  refLabelFor,
  removeStep,
  serializeSteps,
  unmodelledFields,
  updateStep,
  type StepDraft,
  type WorkflowStepType,
} from "@/features/agents/workflows/workflow-steps";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";

interface WorkflowStepsEditorProps {
  /** The JSON the form field holds; the editor is a view over it. */
  value: string;
  onChange: (json: string) => void;
}

/**
 * Builds a workflow step by step instead of asking for hand-written JSON.
 *
 * The form still carries the same JSON string, so validation and the request body are
 * unchanged and the JSON view stays an exact alternative rather than a second source of
 * truth. Fields this build does not model travel with their step untouched.
 */
export function WorkflowStepsEditor({ onChange, value }: WorkflowStepsEditorProps): React.JSX.Element {
  const steps = parseSteps(value);
  const baseId = useId();
  const apply = (next: StepDraft[]): void => onChange(serializeSteps(next));

  return (
    <div className="workflow-steps">
      {steps.length === 0 ? (
        <EmptyState
          title="아직 단계가 없습니다."
          description="아래에서 단계를 추가하면 위에서 아래 순서로 실행됩니다."
        />
      ) : (
        <ol className="workflow-step-list" aria-label="워크플로 단계">
          {steps.map((step, index) => {
            const stepId = `${baseId}-${index}`;
            const refLabel = refLabelFor(step.type);
            const extras = unmodelledFields(step);
            return (
              <li key={stepId} className="workflow-step">
                <div className="workflow-step-head">
                  <span className="workflow-step-index" aria-hidden="true">
                    {index + 1}
                  </span>
                  <label htmlFor={`${stepId}-name`} className="sr-only">
                    {index + 1}번째 단계 이름
                  </label>
                  <Input
                    id={`${stepId}-name`}
                    value={fieldText(step, "name")}
                    placeholder="단계 이름"
                    onChange={(event) => apply(updateStep(steps, index, "name", event.target.value))}
                  />
                  <label htmlFor={`${stepId}-type`} className="sr-only">
                    {index + 1}번째 단계 종류
                  </label>
                  <Select
                    id={`${stepId}-type`}
                    value={step.type}
                    onChange={(event) => apply(updateStep(steps, index, "type", event.target.value))}
                    options={workflowStepTypes.map((type) => ({
                      value: type,
                      label: workflowStepTypeLabels[type],
                    }))}
                  />
                  <span className="workflow-step-actions">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`${index + 1}번째 단계 위로`}
                      disabled={index === 0}
                      onClick={() => apply(moveStep(steps, index, -1))}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`${index + 1}번째 단계 아래로`}
                      disabled={index === steps.length - 1}
                      onClick={() => apply(moveStep(steps, index, 1))}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`${index + 1}번째 단계 삭제`}
                      onClick={() => apply(removeStep(steps, index))}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </span>
                </div>

                <div className="workflow-step-fields">
                  {refLabel ? (
                    <label htmlFor={`${stepId}-ref`}>
                      <span>{refLabel}</span>
                      <Input
                        id={`${stepId}-ref`}
                        value={fieldText(step, "ref")}
                        onChange={(event) => apply(updateStep(steps, index, "ref", event.target.value))}
                      />
                    </label>
                  ) : null}
                  {hasAllowedTools(step.type) ? (
                    <label htmlFor={`${stepId}-tools`}>
                      <span>허용 도구</span>
                      <Input
                        id={`${stepId}-tools`}
                        placeholder="쉼표로 구분"
                        value={fieldText(step, "allowed_tools")}
                        onChange={(event) =>
                          apply(updateStep(steps, index, "allowed_tools", event.target.value))
                        }
                      />
                    </label>
                  ) : null}
                  {hasAllowedTables(step.type) ? (
                    <label htmlFor={`${stepId}-tables`}>
                      <span>허용 테이블</span>
                      <Input
                        id={`${stepId}-tables`}
                        placeholder="쉼표로 구분"
                        value={fieldText(step, "allowed_tables")}
                        onChange={(event) =>
                          apply(updateStep(steps, index, "allowed_tables", event.target.value))
                        }
                      />
                    </label>
                  ) : null}
                  {hasLimits(step.type) ? (
                    <>
                      <label htmlFor={`${stepId}-timeout`}>
                        <span>제한 시간 (ms)</span>
                        <Input
                          id={`${stepId}-timeout`}
                          inputMode="numeric"
                          value={fieldText(step, "timeout_ms")}
                          onChange={(event) =>
                            apply(updateStep(steps, index, "timeout_ms", event.target.value))
                          }
                        />
                      </label>
                      <label htmlFor={`${stepId}-tokens`}>
                        <span>최대 토큰</span>
                        <Input
                          id={`${stepId}-tokens`}
                          inputMode="numeric"
                          value={fieldText(step, "max_tokens")}
                          onChange={(event) =>
                            apply(updateStep(steps, index, "max_tokens", event.target.value))
                          }
                        />
                      </label>
                      <label htmlFor={`${stepId}-cost`}>
                        <span>최대 비용 (₩)</span>
                        <Input
                          id={`${stepId}-cost`}
                          inputMode="numeric"
                          value={fieldText(step, "max_cost_krw")}
                          onChange={(event) =>
                            apply(updateStep(steps, index, "max_cost_krw", event.target.value))
                          }
                        />
                      </label>
                    </>
                  ) : null}
                  <label htmlFor={`${stepId}-note`} className="workflow-step-note">
                    <span>메모</span>
                    <Input
                      id={`${stepId}-note`}
                      value={fieldText(step, "note")}
                      onChange={(event) => apply(updateStep(steps, index, "note", event.target.value))}
                    />
                  </label>
                </div>

                {extras.length ? (
                  <p className="workflow-step-extras">
                    이 화면에서 다루지 않는 항목은 그대로 유지됩니다: {extras.join(", ")}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      <div className="workflow-step-add">
        <label htmlFor={`${baseId}-add`}>
          <span className="sr-only">추가할 단계 종류</span>
          <Select
            id={`${baseId}-add`}
            defaultValue=""
            onChange={(event) => {
              const type = event.target.value as WorkflowStepType;
              if (!type) return;
              apply(addStep(steps, type));
              event.target.value = "";
            }}
            options={[
              { value: "", label: "단계 추가…" },
              ...workflowStepTypes.map((type) => ({
                value: type,
                label: workflowStepTypeLabels[type],
              })),
            ]}
          />
        </label>
        <span className="workflow-step-hint">
          <Plus aria-hidden="true" /> 단계는 위에서 아래 순서로 실행됩니다.
        </span>
      </div>
    </div>
  );
}
