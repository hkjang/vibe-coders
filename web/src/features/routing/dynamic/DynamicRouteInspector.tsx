import { Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";

import type {
  DynamicRouteElement,
  DynamicRouteElementType,
  DynamicRouteField,
  DynamicRouteGraph,
  DynamicRouteIssue,
} from "@/shared/api/domains/routing-dynamic";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";

import {
  buildConditions,
  conditionOperators,
  emptyRule,
  isListOperator,
  isNumericOperator,
  parseSimpleConditions,
  ruleError,
  type ConditionOperator,
  type ConditionRule,
  type ConditionValueType,
  type SimpleConditions,
} from "./dynamic-route-conditions";
import {
  addElement,
  addableTypes,
  elementIdPattern,
  elementTitle,
  elementTypeHints,
  elementTypeLabels,
  isRequiredOutput,
  outputLabel,
  outputNames,
  percentKeys,
  percentValue,
  removeElement,
  renameElement,
  setOutput,
  setPercentages,
  updateElement,
} from "./dynamic-route-model";

interface InspectorProps {
  graph: DynamicRouteGraph;
  element: DynamicRouteElement;
  fields: readonly DynamicRouteField[];
  errors: readonly DynamicRouteIssue[];
  warnings: readonly DynamicRouteIssue[];
  readOnly: boolean;
  onChange: (graph: DynamicRouteGraph, select?: string) => void;
}

const newPrefix = "__new:";

const windowPresets = [
  { value: "60", label: "1분" },
  { value: "600", label: "10분" },
  { value: "3600", label: "1시간" },
  { value: "86400", label: "1일" },
  { value: "604800", label: "7일" },
  { value: "2592000", label: "30일" },
];

function numberOrUndefined(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Edits the selected element. Every change produces a new graph; nothing is saved until the editor saves. */
export function DynamicRouteInspector({
  graph,
  element,
  fields,
  errors,
  warnings,
  readOnly,
  onChange,
}: InspectorProps): React.JSX.Element {
  const idFieldId = useId();
  // The editor keys this component by element id, so a different element starts fresh.
  const [idDraft, setIdDraft] = useState(element.id);
  const idError = !elementIdPattern.test(idDraft)
    ? "영문·숫자로 시작하고 영문·숫자·_ . - 만 쓸 수 있습니다."
    : idDraft !== element.id && graph.elements.some((item) => item.id === idDraft)
      ? "이미 쓰는 ID입니다."
      : undefined;
  const update = (next: (current: DynamicRouteElement) => DynamicRouteElement): void =>
    onChange(updateElement(graph, element.id, next));
  const setProp = (patch: Partial<DynamicRouteElement["properties"]>): void =>
    update((current) => ({ ...current, properties: { ...current.properties, ...patch } }));
  const targets = graph.elements.filter((item) => item.id !== element.id && item.type !== "start");
  const targetOptions = [
    ...targets.map((item) => ({
      value: item.id,
      label: `${elementTypeLabels[item.type]} · ${elementTitle(item)}`,
    })),
    ...addableTypes.map((type) => ({
      value: `${newPrefix}${type}`,
      label: `+ 새 ${elementTypeLabels[type]} 추가`,
    })),
  ];
  const connect = (output: string, value: string): void => {
    if (value.startsWith(newPrefix)) {
      const type = value.slice(newPrefix.length) as DynamicRouteElementType;
      const added = addElement(graph, type, { id: element.id, output });
      onChange(added.graph, added.id);
      return;
    }
    onChange(setOutput(graph, element.id, output, value || undefined));
  };
  const props = element.properties;
  const fieldListId = `${idFieldId}-fields`;

  return (
    <div
      className="dr-inspector"
      aria-label={`${elementTypeLabels[element.type]} ${elementTitle(element)} 설정`}
    >
      <div className="dr-inspector-head">
        <h3>
          {elementTypeLabels[element.type]} <span className="dr-inspector-id">{element.id}</span>
        </h3>
        <p>{elementTypeHints[element.type]}</p>
      </div>
      {errors.length + warnings.length > 0 ? (
        <ul className="dr-issue-list" aria-label="이 요소의 검증 결과">
          {errors.map((issue) => (
            <li key={`e:${issue.code}:${issue.message}`} className="dr-issue dr-issue-error">
              <strong>오류</strong> {issue.message}
            </li>
          ))}
          {warnings.map((issue) => (
            <li key={`w:${issue.code}:${issue.message}`} className="dr-issue dr-issue-warning">
              <strong>경고</strong> {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      <datalist id={fieldListId}>
        {fields
          .filter((field) => !field.field.includes("<"))
          .map((field) => (
            <option key={field.field} value={field.field}>
              {field.description}
            </option>
          ))}
        <option value="metadata.user_id">요청 메타데이터 user_id</option>
        <option value="metadata.plan">요청 메타데이터 plan</option>
      </datalist>

      <fieldset className="dr-fieldset" disabled={readOnly}>
        <legend className="sr-only">기본 정보</legend>
        <div className="dr-form-grid">
          <FormField
            label="요소 ID"
            id={idFieldId}
            error={idError}
            description="경로 기록과 응답 헤더에 그대로 나옵니다."
          >
            {(control) => (
              <Input
                {...control}
                value={idDraft}
                onChange={(event) => setIdDraft(event.target.value)}
                onBlur={() => {
                  if (!idError && idDraft !== element.id)
                    onChange(renameElement(graph, element.id, idDraft), idDraft);
                  else setIdDraft(element.id);
                }}
              />
            )}
          </FormField>
          <FormField label="표시 이름" description="비우면 요소 ID를 보여 줍니다.">
            {(control) => (
              <Input
                {...control}
                value={element.label ?? ""}
                maxLength={80}
                onChange={(event) => update((current) => ({ ...current, label: event.target.value }))}
              />
            )}
          </FormField>
        </div>

        {element.type === "model" ? (
          <div className="dr-form-grid">
            <FormField label="모델" required description="공급자에게 보낼 실제 모델 이름입니다.">
              {(control) => (
                <Input
                  {...control}
                  value={props.model ?? ""}
                  placeholder="gpt-4.1-mini"
                  onChange={(event) => setProp({ model: event.target.value })}
                />
              )}
            </FormField>
            <FormField
              label="공급자"
              description="비우면 모델 패턴으로 고르고, 같은 모델을 제공하는 다른 공급자로도 장애 전환합니다."
            >
              {(control) => (
                <Input
                  {...control}
                  value={props.provider ?? ""}
                  placeholder="자동"
                  onChange={(event) => setProp({ provider: event.target.value })}
                />
              )}
            </FormField>
            <FormField
              label="응답 대기 시간 (초)"
              description="첫 응답 헤더를 기다리는 시간입니다. 비우면 공급자 설정을 따릅니다."
            >
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  min={0}
                  max={600}
                  step={0.5}
                  value={props.timeout ? String(props.timeout / 1000) : ""}
                  onChange={(event) => {
                    const seconds = numberOrUndefined(event.target.value);
                    setProp({ timeout: seconds === undefined ? undefined : Math.round(seconds * 1000) });
                  }}
                />
              )}
            </FormField>
            <FormField
              label="재시도"
              description="같은 공급자에 다시 보내는 횟수입니다. 모두 실패하면 fallback으로 넘어갑니다."
            >
              {(control) => (
                <Select
                  {...control}
                  value={String(props.retries ?? 0)}
                  options={[0, 1, 2, 3, 4, 5].map((value) => ({
                    value: String(value),
                    label: value === 0 ? "하지 않음" : `${value}회`,
                  }))}
                  onChange={(event) => setProp({ retries: Number(event.target.value) || undefined })}
                />
              )}
            </FormField>
            <FormField label="재시도 간격 (ms)">
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  min={0}
                  max={60000}
                  value={props.retryDelay ?? ""}
                  onChange={(event) => setProp({ retryDelay: numberOrUndefined(event.target.value) })}
                />
              )}
            </FormField>
            <FormField label="백오프">
              {(control) => (
                <Select
                  {...control}
                  value={props.backoff ?? ""}
                  options={[
                    { value: "", label: "일정 (기본)" },
                    { value: "linear", label: "선형 증가" },
                    { value: "exponential", label: "지수 증가" },
                  ]}
                  onChange={(event) =>
                    setProp({
                      backoff: (event.target.value ||
                        undefined) as DynamicRouteElement["properties"]["backoff"],
                    })
                  }
                />
              )}
            </FormField>
          </div>
        ) : null}

        {element.type === "conditional" ? (
          <ConditionEditor
            value={props.conditions}
            fieldListId={fieldListId}
            onChange={(conditions) => setProp({ conditions })}
          />
        ) : null}

        {element.type === "percentage" ? (
          <PercentageEditor
            graph={graph}
            element={element}
            targetOptions={targetOptions}
            onChange={onChange}
            fieldListId={fieldListId}
          />
        ) : null}

        {element.type === "rate" ? (
          <div className="dr-form-grid">
            <FormField label="한도 종류">
              {(control) => (
                <Select
                  {...control}
                  value={props.limitType ?? "count"}
                  options={[
                    { value: "count", label: "요청 수" },
                    { value: "cost", label: "비용 (원)" },
                  ]}
                  onChange={(event) => setProp({ limitType: event.target.value as "count" | "cost" })}
                />
              )}
            </FormField>
            <FormField
              label={props.limitType === "cost" ? "기간당 비용 한도 (원)" : "기간당 요청 한도"}
              required
            >
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  min={0}
                  step={props.limitType === "cost" ? "any" : 1}
                  value={props.limit ?? ""}
                  onChange={(event) => setProp({ limit: numberOrUndefined(event.target.value) })}
                />
              )}
            </FormField>
            <FormField label="집계 기간">
              {(control) => (
                <Select
                  {...control}
                  value={
                    windowPresets.some((preset) => preset.value === String(props.window))
                      ? String(props.window)
                      : "custom"
                  }
                  options={[
                    ...windowPresets,
                    { value: "custom", label: `직접 입력 (${props.window ?? 0}초)` },
                  ]}
                  onChange={(event) => {
                    if (event.target.value !== "custom") setProp({ window: Number(event.target.value) });
                  }}
                />
              )}
            </FormField>
            <FormField label="기간 (초)" description="10초에서 31일 사이입니다.">
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  min={10}
                  max={2678400}
                  value={props.window ?? ""}
                  onChange={(event) => setProp({ window: numberOrUndefined(event.target.value) })}
                />
              )}
            </FormField>
            <FormField
              label="한도 키"
              description="값마다 한도를 따로 셉니다. 비우면 모든 요청이 한도 하나를 함께 씁니다. 저장 시 값은 해시로만 남습니다."
            >
              {(control) => (
                <Input
                  {...control}
                  list={fieldListId}
                  value={props.key ?? ""}
                  placeholder="metadata.user_id"
                  onChange={(event) => setProp({ key: event.target.value })}
                />
              )}
            </FormField>
          </div>
        ) : null}

        {element.type !== "percentage" && outputNames(element).length > 0 ? (
          <div className="dr-outputs">
            <h4>출력 연결</h4>
            {outputNames(element).map((output) => (
              <FormField
                key={output}
                label={`${outputLabel(element.type, output)} (${output})`}
                required={isRequiredOutput(element.type, output)}
                description={
                  output === "fallback" && element.type === "model"
                    ? "시간 초과, 연결 오류, 429·5xx, 401·403·404일 때 이동합니다. 비우면 그 오류를 그대로 돌려줍니다."
                    : output === "fallback" && element.type === "rate"
                      ? "비우면 한도를 넘은 요청은 429로 거절됩니다."
                      : output === "success" && element.type === "model"
                        ? "성공한 응답은 종료 요소로만 이어집니다."
                        : undefined
                }
              >
                {(control) => (
                  <Select
                    {...control}
                    value={element.outputs?.[output]?.elementId ?? ""}
                    placeholder="연결 없음"
                    options={
                      output === "success" && element.type === "model"
                        ? targetOptions.filter(
                            (option) =>
                              option.value === `${newPrefix}end` ||
                              targets.some((item) => item.id === option.value && item.type === "end"),
                          )
                        : targetOptions
                    }
                    onChange={(event) => connect(output, event.target.value)}
                  />
                )}
              </FormField>
            ))}
          </div>
        ) : null}

        {element.type !== "start" ? (
          <div className="dr-inspector-actions">
            <Button
              variant="danger"
              size="small"
              onClick={() => onChange(removeElement(graph, element.id), "")}
            >
              <Trash2 aria-hidden="true" /> 이 요소 삭제
            </Button>
          </div>
        ) : null}
      </fieldset>
    </div>
  );
}

function PercentageEditor({
  graph,
  element,
  targetOptions,
  onChange,
  fieldListId,
}: {
  graph: DynamicRouteGraph;
  element: DynamicRouteElement;
  targetOptions: ReadonlyArray<{ value: string; label: string }>;
  onChange: (graph: DynamicRouteGraph, select?: string) => void;
  fieldListId: string;
}): React.JSX.Element {
  const branches = percentKeys(element).map((key) => ({
    percent: percentValue(key),
    target: element.outputs?.[key]?.elementId ?? "",
  }));
  const total = branches.reduce((sum, branch) => sum + branch.percent, 0);
  const write = (next: ReadonlyArray<{ percent: number; target: string }>): void =>
    onChange(updateElement(graph, element.id, (current) => setPercentages(current, next)));
  const choose = (index: number, value: string): void => {
    if (value.startsWith(newPrefix)) {
      const type = value.slice(newPrefix.length) as DynamicRouteElementType;
      const added = addElement(graph, type);
      const next = branches.map((branch, i) => (i === index ? { ...branch, target: added.id } : branch));
      onChange(
        updateElement(added.graph, element.id, (current) => setPercentages(current, next)),
        added.id,
      );
      return;
    }
    write(branches.map((branch, i) => (i === index ? { ...branch, target: value } : branch)));
  };
  const firstTarget = targetOptions.find((option) => !option.value.startsWith(newPrefix))?.value ?? "";
  return (
    <div className="dr-outputs">
      <h4>분배 비율</h4>
      <p className={Math.abs(total - 100) < 0.0001 ? "dr-hint" : "dr-hint dr-hint-error"} role="status">
        합계 {total.toLocaleString("ko-KR")}%{" "}
        {Math.abs(total - 100) < 0.0001 ? "" : "· 100%가 되어야 저장할 수 있습니다."}
      </p>
      {branches.length === 0 ? <p className="dr-hint">아직 갈래가 없습니다. 아래에서 추가하세요.</p> : null}
      {branches.map((branch, index) => (
        <div className="dr-branch-row" key={`${index}:${branch.percent}`}>
          <FormField label={`갈래 ${index + 1} 비율 (%)`}>
            {(control) => (
              <Input
                {...control}
                type="number"
                min={0.01}
                max={100}
                step="any"
                defaultValue={branch.percent}
                onBlur={(event) => {
                  const percent = numberOrUndefined(event.target.value) ?? 0;
                  write(branches.map((item, i) => (i === index ? { ...item, percent } : item)));
                }}
              />
            )}
          </FormField>
          <FormField label={`갈래 ${index + 1} 연결`}>
            {(control) => (
              <Select
                {...control}
                value={branch.target}
                options={[...targetOptions]}
                onChange={(event) => choose(index, event.target.value)}
              />
            )}
          </FormField>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`갈래 ${index + 1} 삭제`}
            onClick={() => write(branches.filter((_, i) => i !== index))}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      <div className="dr-inspector-actions">
        <Button
          size="small"
          disabled={branches.length >= 5 || !firstTarget}
          onClick={() => {
            const remaining = Math.max(1, Math.round((100 - total) * 100) / 100);
            const used = new Set(branches.map((branch) => branch.percent));
            let percent = remaining;
            while (used.has(percent)) percent += 1;
            write([...branches, { percent, target: firstTarget }]);
          }}
        >
          <Plus aria-hidden="true" /> 갈래 추가
        </Button>
      </div>
      <FormField
        label="고정 분배 키"
        description="이 값이 같은 요청은 늘 같은 갈래로 갑니다(예: 사용자별 A/B). 비우면 요청마다 무작위입니다."
      >
        {(control) => (
          <Input
            {...control}
            list={fieldListId}
            value={element.properties.stickyKey ?? ""}
            placeholder="metadata.user_id"
            onChange={(event) =>
              onChange(
                updateElement(graph, element.id, (current) => ({
                  ...current,
                  properties: { ...current.properties, stickyKey: event.target.value },
                })),
              )
            }
          />
        )}
      </FormField>
    </div>
  );
}

function ConditionEditor({
  value,
  fieldListId,
  onChange,
}: {
  value: Record<string, unknown> | undefined;
  fieldListId: string;
  onChange: (conditions: Record<string, unknown>) => void;
}): React.JSX.Element {
  const parsed = parseSimpleConditions(value);
  const [advanced, setAdvanced] = useState(parsed === undefined);
  const [draft, setDraft] = useState<SimpleConditions>(parsed ?? { mode: "all", rules: [emptyRule()] });
  const [jsonText, setJsonText] = useState(JSON.stringify(value ?? {}, null, 2));
  const [jsonError, setJsonError] = useState<string>();
  const valueKey = JSON.stringify(value ?? {});
  // Follow changes made outside this editor (undo, loading a version). Rows the
  // builder is still filling in produce the same document and are kept.
  const [syncedKey, setSyncedKey] = useState(valueKey);
  if (syncedKey !== valueKey) {
    setSyncedKey(valueKey);
    const next = parseSimpleConditions(value);
    if (next && JSON.stringify(buildConditions(draft)) !== valueKey) setDraft(next);
    if (!advanced || jsonError === undefined) setJsonText(JSON.stringify(value ?? {}, null, 2));
  }
  const commit = (next: SimpleConditions): void => {
    setDraft(next);
    onChange(buildConditions(next));
  };
  const setRule = (index: number, patch: Partial<ConditionRule>): void =>
    commit({ ...draft, rules: draft.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)) });

  return (
    <div className="dr-outputs">
      <div className="dr-condition-head">
        <h4>조건</h4>
        <Button
          size="small"
          variant="ghost"
          onClick={() => {
            if (advanced && parseSimpleConditions(value) === undefined) return;
            setAdvanced(!advanced);
          }}
          disabled={advanced && parseSimpleConditions(value) === undefined}
        >
          {advanced ? "간단히 편집" : "JSON으로 편집"}
        </Button>
      </div>
      {advanced ? (
        <FormField
          label="조건 JSON"
          error={jsonError}
          description='예: {"$or": [{"metadata.plan": "free"}, {"identity.team": {"$in": ["ml", "data"]}}]}'
        >
          {(control) => (
            <Textarea
              {...control}
              className="dr-code"
              rows={8}
              spellCheck={false}
              value={jsonText}
              onChange={(event) => {
                setJsonText(event.target.value);
                try {
                  const next: unknown = JSON.parse(event.target.value);
                  if (typeof next !== "object" || next === null || Array.isArray(next))
                    throw new Error("object");
                  setJsonError(undefined);
                  onChange(next as Record<string, unknown>);
                } catch {
                  setJsonError("JSON 객체 형식이어야 합니다.");
                }
              }}
            />
          )}
        </FormField>
      ) : (
        <>
          <FormField label="결합 방식">
            {(control) => (
              <Select
                {...control}
                value={draft.mode}
                options={[
                  { value: "all", label: "모두 만족하면 참" },
                  { value: "any", label: "하나라도 만족하면 참" },
                ]}
                onChange={(event) => commit({ ...draft, mode: event.target.value as "all" | "any" })}
              />
            )}
          </FormField>
          {draft.rules.map((rule, index) => {
            const error = ruleError(rule);
            return (
              <div className="dr-rule-row" key={index}>
                <FormField label={`조건 ${index + 1} 필드`} error={error}>
                  {(control) => (
                    <Input
                      {...control}
                      list={fieldListId}
                      value={rule.field}
                      onChange={(event) => setRule(index, { field: event.target.value })}
                    />
                  )}
                </FormField>
                <FormField label="비교">
                  {(control) => (
                    <Select
                      {...control}
                      value={rule.op}
                      options={[...conditionOperators]}
                      onChange={(event) => {
                        const op = event.target.value as ConditionOperator;
                        setRule(index, {
                          op,
                          ...(isNumericOperator(op) ? { valueType: "number" as ConditionValueType } : {}),
                          ...(op === "$exists"
                            ? { value: "true", valueType: "boolean" as ConditionValueType }
                            : {}),
                        });
                      }}
                    />
                  )}
                </FormField>
                {rule.op === "$exists" ? (
                  <FormField label="값">
                    {(control) => (
                      <Select
                        {...control}
                        value={rule.value === "false" ? "false" : "true"}
                        options={[
                          { value: "true", label: "있음" },
                          { value: "false", label: "없음" },
                        ]}
                        onChange={(event) => setRule(index, { value: event.target.value })}
                      />
                    )}
                  </FormField>
                ) : (
                  <>
                    <FormField label={isListOperator(rule.op) ? "값 (쉼표로 구분)" : "값"}>
                      {(control) => (
                        <Input
                          {...control}
                          value={rule.value}
                          onChange={(event) => setRule(index, { value: event.target.value })}
                        />
                      )}
                    </FormField>
                    <FormField label="값 형식">
                      {(control) => (
                        <Select
                          {...control}
                          value={rule.valueType}
                          disabled={isNumericOperator(rule.op)}
                          options={[
                            { value: "string", label: "문자열" },
                            { value: "number", label: "숫자" },
                            { value: "boolean", label: "참/거짓" },
                          ]}
                          onChange={(event) =>
                            setRule(index, { valueType: event.target.value as ConditionValueType })
                          }
                        />
                      )}
                    </FormField>
                  </>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`조건 ${index + 1} 삭제`}
                  disabled={draft.rules.length <= 1}
                  onClick={() => commit({ ...draft, rules: draft.rules.filter((_, i) => i !== index) })}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            );
          })}
          <div className="dr-inspector-actions">
            <Button size="small" onClick={() => commit({ ...draft, rules: [...draft.rules, emptyRule()] })}>
              <Plus aria-hidden="true" /> 조건 추가
            </Button>
          </div>
          <InlineNotice tone="info">
            메타데이터에 없는 키는 &quot;같음&quot;·&quot;목록 중 하나&quot;에서 거짓,
            &quot;다름&quot;·&quot;목록에 없음&quot;에서 참입니다. 숫자와 문자열은 따로
            비교합니다(&quot;3&quot;과 3은 다릅니다).
          </InlineNotice>
        </>
      )}
    </div>
  );
}
