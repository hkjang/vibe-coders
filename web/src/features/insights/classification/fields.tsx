import { useState } from "react";

import type { WorkCategory } from "@/shared/api/domains/insights-classification";
import { FormField } from "@/shared/components/form/FormField";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";

import { categoryOptions, joinList, sameList, splitList } from "./classification-model";

interface ListFieldProps {
  label: string;
  description?: string;
  error?: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** One row renders a single-line input; more render a textarea. */
  rows?: number;
  /** "lines" keeps commas inside an item (example sentences). */
  separators?: "any" | "lines";
  placeholder?: string;
}

/**
 * A list edited as text. The text the operator typed is kept as typed (a trailing
 * comma must not vanish mid-word); it is replaced only when the list changes from
 * outside, e.g. after a save or a discard.
 */
export function ListField({
  label,
  description,
  error,
  value,
  onChange,
  disabled,
  rows = 2,
  separators = "any",
  placeholder,
}: ListFieldProps): React.JSX.Element {
  const [state, setState] = useState(() => ({ text: joinList(value, separators), parsed: [...value] }));
  if (!sameList(state.parsed, value)) setState({ text: joinList(value, separators), parsed: [...value] });
  const edit = (text: string): void => {
    const parsed = splitList(text, separators);
    setState({ text, parsed });
    if (!sameList(parsed, value)) onChange(parsed);
  };
  const hint =
    description ?? (separators === "lines" ? "한 줄에 하나씩 입력합니다." : "쉼표나 줄바꿈으로 구분합니다.");
  return (
    <FormField label={`${label} (${value.length})`} description={hint} error={error}>
      {(control) =>
        rows > 1 ? (
          <Textarea
            {...control}
            rows={rows}
            value={state.text}
            disabled={disabled}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(event) => edit(event.target.value)}
          />
        ) : (
          <Input
            {...control}
            value={state.text}
            disabled={disabled}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => edit(event.target.value)}
          />
        )
      }
    </FormField>
  );
}

interface NumberFieldProps {
  label: string;
  description?: string;
  error?: string;
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
}

/** A number edited as text, so "0." or an emptied field is not rewritten while typing. */
export function NumberField({
  label,
  description,
  error,
  value,
  onChange,
  disabled,
  min,
  max,
  step,
}: NumberFieldProps): React.JSX.Element {
  const [state, setState] = useState(() => ({ text: String(value), parsed: value }));
  if (!Object.is(state.parsed, value)) setState({ text: String(value), parsed: value });
  const edit = (text: string): void => {
    const parsed = text.trim() === "" ? 0 : Number(text);
    if (!Number.isFinite(parsed)) return;
    setState({ text, parsed });
    if (!Object.is(parsed, value)) onChange(parsed);
  };
  return (
    <FormField label={label} description={description} error={error}>
      {(control) => (
        <Input
          {...control}
          type="number"
          inputMode="decimal"
          value={state.text}
          disabled={disabled}
          min={min}
          max={max}
          step={step}
          onChange={(event) => edit(event.target.value)}
        />
      )}
    </FormField>
  );
}

interface CategorySelectProps {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-label"?: string;
  categories: readonly WorkCategory[];
  value: string;
  onChange: (id: string) => void;
  /** Label of the empty choice, e.g. "전체". */
  emptyLabel: string;
  disabled?: boolean;
  /** Ids that cannot be chosen (already used, for instance). */
  exclude?: ReadonlySet<string>;
}

/** Every category by its path, in tree order. An unknown current value stays selectable. */
export function CategorySelect({
  categories,
  value,
  onChange,
  emptyLabel,
  disabled,
  exclude,
  ...control
}: CategorySelectProps): React.JSX.Element {
  const options = categoryOptions(categories);
  const known = value === "" || options.some((option) => option.id === value);
  return (
    <Select {...control} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">{emptyLabel}</option>
      {known ? null : <option value={value}>{value} (정책에 없음)</option>}
      {options
        .filter((option) => option.id === value || !exclude?.has(option.id))
        .map((option) => (
          <option key={option.id} value={option.id}>
            {option.path}
            {option.merged ? " (병합됨)" : option.enabled ? "" : " (꺼짐)"}
          </option>
        ))}
    </Select>
  );
}
