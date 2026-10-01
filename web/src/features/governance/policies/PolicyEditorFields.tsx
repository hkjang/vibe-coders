import { useState } from "react";
import type { Policy } from "@/shared/api/domains/governance";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { protectedJson } from "./policy-editor-security";
import {
  newRule,
  resolvedText,
  type EditProblem,
  type EditValue,
  type PolicyEdit,
  type RuleEdit,
} from "./policy-editor-state";

function ValueField({
  label,
  field,
  value,
  original,
  json = false,
  prefixes,
  error,
  onChange,
}: {
  label: string;
  field: string;
  value: EditValue;
  original: unknown;
  json?: boolean;
  prefixes: readonly string[];
  error?: EditProblem;
  onChange: (value: EditValue) => void;
}) {
  const originalProtected = json
    ? protectedJson(original, prefixes)
    : typeof original === "string" && containsPotentialSecret(original, prefixes);
  const rendered =
    value.replacement ?? (json ? (JSON.stringify(original, null, 2) ?? "") : resolvedText(value, original));
  let replacementProtected =
    value.replacement !== undefined && containsPotentialSecret(value.replacement, prefixes);
  if (json && value.replacement !== undefined) {
    try {
      replacementProtected = protectedJson(JSON.parse(value.replacement), prefixes);
    } catch {
      /* Incomplete JSON still uses the conservative plaintext scanner. */
    }
  }
  const hidden = value.replacement === undefined ? originalProtected : replacementProtected;
  if (hidden)
    return (
      <div className="form-field" data-editor-field={field} tabIndex={-1}>
        <strong>{label}</strong>
        <p>
          {value.replacement === undefined
            ? "보호된 원문을 표시하지 않고 그대로 유지합니다."
            : "새 입력에 민감정보가 포함될 수 있어 표시·저장하지 않습니다."}
        </p>
        <Button onClick={() => onChange({ replacement: "" })}>{label} 전체 교체</Button>
        {error?.field === field ? <p role="alert">{error.message}</p> : null}
      </div>
    );
  return (
    <div data-editor-field={field}>
      <FormField
        label={label}
        error={error?.field === field ? error.message : undefined}
        description={
          json
            ? "JSON 객체를 입력하세요. 미편집 값과 중첩 필드는 유지합니다. 최상위 키는 서버의 소문자·공백 정리 규칙을 따릅니다."
            : undefined
        }
      >
        {(control) =>
          json ? (
            <Textarea
              {...control}
              value={rendered}
              rows={5}
              onChange={(event) => onChange({ replacement: event.target.value })}
            />
          ) : (
            <Input
              {...control}
              value={rendered}
              onChange={(event) => onChange({ replacement: event.target.value })}
            />
          )
        }
      </FormField>
      {value.replacement !== undefined && original !== undefined ? (
        <Button size="small" onClick={() => onChange({})}>
          {label} 원본 유지
        </Button>
      ) : null}
    </div>
  );
}
function RuleFields({
  rule,
  index,
  prefixes,
  error,
  update,
}: {
  rule: RuleEdit;
  index: number;
  prefixes: readonly string[];
  error?: EditProblem;
  update: (rule: RuleEdit) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const field = `rule-${rule.key}`;
  return (
    <fieldset className="policy-editor-rule" data-editor-field={field} tabIndex={-1}>
      <legend>규칙 {index + 1}</legend>
      {rule.removed ? (
        <>
          <p>이 규칙은 저장 시 삭제됩니다.</p>
          <Button onClick={() => update({ ...rule, removed: false })}>규칙 삭제 취소</Button>
        </>
      ) : (
        <>
          {error?.field === field ? <p role="alert">{error.message}</p> : null}
          <ValueField
            label="규칙 이름"
            field={`${field}-name`}
            value={rule.name}
            original={rule.original?.name}
            prefixes={prefixes}
            error={error}
            onChange={(name) => update({ ...rule, name })}
          />
          <Checkbox
            label="규칙 사용"
            checked={rule.enabled === true}
            onChange={(event) => update({ ...rule, enabled: event.target.checked })}
          />
          <div data-editor-field={`${field}-priority`}>
            <FormField
              label="규칙 우선순위"
              error={error?.field === `${field}-priority` ? error.message : undefined}
            >
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  step="1"
                  value={rule.priority}
                  onChange={(event) => update({ ...rule, priority: event.target.value })}
                />
              )}
            </FormField>
          </div>
          <ValueField
            label="조건 JSON"
            field={`${field}-conditions`}
            json
            value={rule.conditions}
            original={rule.original?.conditions}
            prefixes={prefixes}
            error={error}
            onChange={(conditions) => update({ ...rule, conditions })}
          />
          <ValueField
            label="동작 JSON"
            field={`${field}-actions`}
            json
            value={rule.actions}
            original={rule.original?.actions}
            prefixes={prefixes}
            error={error}
            onChange={(actions) => update({ ...rule, actions })}
          />
          <div className="policy-editor-actions">
            {rule.original ? <Button onClick={() => update(newRule(rule.key))}>규칙 전체 교체</Button> : null}
            <Button variant="danger" onClick={() => setDeleting(true)}>
              규칙 삭제
            </Button>
          </div>
          {deleting ? (
            <div role="group" aria-label={`규칙 ${index + 1} 삭제 확인`}>
              <p>이 규칙을 목록에서 제거할까요? 실제 삭제는 검토 후 저장할 때 반영됩니다.</p>
              <Button
                variant="danger"
                onClick={() => {
                  setDeleting(false);
                  update({ ...rule, removed: true });
                }}
              >
                삭제 확인
              </Button>
              <Button onClick={() => setDeleting(false)}>삭제 취소</Button>
            </div>
          ) : null}
        </>
      )}
    </fieldset>
  );
}
export function PolicyEditorFields({
  baseline,
  edit,
  prefixes,
  error,
  update,
}: {
  baseline: Policy;
  edit: PolicyEdit;
  prefixes: readonly string[];
  error?: EditProblem;
  update: (edit: PolicyEdit) => void;
}) {
  return (
    <>
      <ValueField
        label="정책 이름"
        field="name"
        value={edit.name}
        original={baseline.name}
        prefixes={prefixes}
        error={error}
        onChange={(name) => update({ ...edit, name })}
      />
      <ValueField
        label="정책 설명"
        field="description"
        value={edit.description}
        original={baseline.description}
        prefixes={prefixes}
        error={error}
        onChange={(description) => update({ ...edit, description })}
      />
      <div data-editor-field="priority">
        <FormField label="정책 우선순위" error={error?.field === "priority" ? error.message : undefined}>
          {(control) => (
            <Input
              {...control}
              type="number"
              step="1"
              value={edit.priority}
              onChange={(event) => update({ ...edit, priority: event.target.value })}
            />
          )}
        </FormField>
      </div>
      {edit.rules.map((rule, index) => (
        <RuleFields
          key={rule.key}
          rule={rule}
          index={index}
          prefixes={prefixes}
          error={error}
          update={(next) =>
            update({
              ...edit,
              rules: edit.rules.map((item) => (item.key === next.key ? next : item)),
              emptyConfirmed: false,
            })
          }
        />
      ))}
      <Button
        onClick={() =>
          update({
            ...edit,
            rules: [...edit.rules, newRule(edit.rules.reduce((max, rule) => Math.max(max, rule.key + 1), 0))],
          })
        }
      >
        규칙 추가
      </Button>
      {!edit.rules.some((rule) => !rule.removed) ? (
        <div data-editor-field="empty">
          <p>규칙이 없는 비활성 정책으로 저장합니다. 정책 자체를 삭제하는 작업은 아닙니다.</p>
          <Checkbox
            label="모든 규칙을 비우는 변경을 확인했습니다"
            checked={edit.emptyConfirmed}
            onChange={(event) => update({ ...edit, emptyConfirmed: event.target.checked })}
          />
          {error?.field === "empty" ? <p role="alert">{error.message}</p> : null}
        </div>
      ) : null}
    </>
  );
}
