import type { RoutingRule } from "@/shared/api/domains/routing";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";
import { containsPotentialSecret } from "@/shared/security/secrets";
import {
  editFields,
  protectedRuleText,
  type RuleEdit,
  type RuleEditProblem,
} from "./routing-rule-edit-state";

export function RoutingRuleEditFields({
  baseline,
  edit,
  prefixes,
  error,
  update,
}: {
  baseline: RoutingRule;
  edit: RuleEdit;
  prefixes: readonly string[];
  error?: RuleEditProblem;
  update: (edit: RuleEdit) => void;
}) {
  return editFields.map(([field, label]) => {
    const numeric = field === "priority" || field === "min_complexity" || field === "max_complexity";
    const value = edit[field] ?? String(baseline[field]);
    const protectedValue = !numeric && containsPotentialSecret(value, prefixes);
    const changed = edit[field] !== undefined;
    const replace = (replacement: string | undefined) => update({ ...edit, [field]: replacement });
    const description =
      field === "target_provider"
        ? "비우면 공급자를 자동으로 선택합니다."
        : field === "match_pattern"
          ? "비우면 전체 모델(*)에 적용합니다."
          : field === "priority"
            ? "숫자가 작을수록 먼저 평가합니다."
            : undefined;
    return (
      <div key={field} data-edit-field={field}>
        <FormField
          label={label}
          required={field === "target_model" || numeric}
          description={description}
          error={error?.field === field ? error.message : undefined}
        >
          {(control) =>
            protectedValue ? (
              <div>
                <p>
                  {protectedRuleText} {changed ? "새 입력을 지우고 다시 작성하세요." : "기존 값 유지"}
                </p>
                <Button {...control} onClick={() => replace("")} aria-label={`${label} 새 값으로 교체`}>
                  새 값으로 교체
                </Button>
              </div>
            ) : field === "note" ? (
              <Textarea
                {...control}
                rows={3}
                value={value}
                onChange={(event) => replace(event.target.value)}
              />
            ) : (
              <Input
                {...control}
                type={numeric ? "number" : "text"}
                value={value}
                min={numeric ? (field === "priority" ? 1 : 0) : undefined}
                max={numeric ? (field === "priority" ? 10_000 : 100) : undefined}
                onChange={(event) => replace(event.target.value)}
              />
            )
          }
        </FormField>
        {changed ? (
          <Button
            variant="ghost"
            size="small"
            aria-label={`${label} 기존 값 유지`}
            onClick={() => replace(undefined)}
          >
            기존 값 유지
          </Button>
        ) : null}
      </div>
    );
  });
}
