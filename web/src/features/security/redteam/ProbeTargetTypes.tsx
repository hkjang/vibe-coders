import { useId } from "react";
import { FormField } from "@/shared/components/form/FormField";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Input } from "@/shared/components/ui/Input";
import { probeTargetTypes } from "./redteam-labels";

export function ProbeTargetTypes({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const hintId = useId();
  const selected = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const unknown = selected.filter((item) => !probeTargetTypes.some((option) => option.value === item));
  return (
    <fieldset className="rt-fieldset rt-stack" aria-describedby={hintId}>
      <legend>적용 대상 유형</legend>
      <p id={hintId} className="rt-note" aria-live="polite">
        {selected.length === 0
          ? "선택 없음 — 모든 대상 유형에 적용합니다."
          : `선택한 ${selected.length}개 유형에만 적용합니다.`}
      </p>
      <div className="rt-checklist">
        {probeTargetTypes.map((option) => (
          <Checkbox
            key={option.value}
            label={option.label}
            checked={selected.includes(option.value)}
            onChange={(event) =>
              onChange(
                (event.target.checked
                  ? [...selected, option.value]
                  : selected.filter((item) => item !== option.value)
                ).join(","),
              )
            }
          />
        ))}
      </div>
      {unknown.length ? (
        <p className="rt-note">기존 사용자 정의 유형을 유지합니다: {unknown.join(", ")}</p>
      ) : null}
      <details>
        <summary>고급: 유형 식별자 직접 입력</summary>
        <FormField
          label="대상 유형 식별자"
          description="사용자 정의 유형은 쉼표로 구분합니다. 비우면 모든 대상에 적용됩니다."
        >
          {(control) => (
            <Input {...control} value={value} onChange={(event) => onChange(event.target.value)} />
          )}
        </FormField>
      </details>
    </fieldset>
  );
}
