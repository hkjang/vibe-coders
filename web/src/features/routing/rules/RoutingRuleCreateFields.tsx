import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";
import { containsPotentialSecret } from "@/shared/security/secrets";
import {
  createFields,
  protectedCreateText,
  type CreateDraft,
  type CreateField,
  type RuleCreateProblem,
} from "./routing-rule-create-state";

export function RoutingRuleCreateFields({
  draft,
  prefixes,
  pending,
  error,
  update,
}: {
  draft: CreateDraft;
  prefixes: readonly string[];
  pending: boolean;
  error?: RuleCreateProblem;
  update: (field: CreateField, value: string) => void;
}) {
  return createFields.map(([field, label]) => {
    const numeric = field === "priority" || field === "min_complexity" || field === "max_complexity";
    const protectedValue = !numeric && containsPotentialSecret(draft[field], prefixes);
    return (
      <div key={field} data-create-field={field}>
        <FormField
          label={label}
          required={numeric || field === "target_model"}
          description={
            field === "match_pattern"
              ? "비우면 전체 모델(*)에 적용합니다."
              : field === "target_provider"
                ? "비우면 공급자를 자동으로 선택합니다."
                : field === "priority"
                  ? "숫자가 작을수록 먼저 평가합니다."
                  : undefined
          }
          error={error?.field === field ? error.message : undefined}
        >
          {(control) =>
            protectedValue ? (
              <div>
                <p>{protectedCreateText} 입력을 지우고 다시 작성하세요.</p>
                <Button
                  {...control}
                  disabled={pending}
                  onClick={() => update(field, "")}
                  aria-label={`${label} 입력 지우기`}
                >
                  입력 지우기
                </Button>
              </div>
            ) : field === "note" ? (
              <Textarea
                {...control}
                rows={3}
                value={draft[field]}
                readOnly={pending}
                onChange={(event) => update(field, event.target.value)}
              />
            ) : (
              <Input
                {...control}
                type={numeric ? "number" : "text"}
                value={draft[field]}
                readOnly={pending}
                min={numeric ? (field === "priority" ? 1 : 0) : undefined}
                max={numeric ? (field === "priority" ? 10_000 : 100) : undefined}
                onChange={(event) => update(field, event.target.value)}
              />
            )
          }
        </FormField>
      </div>
    );
  });
}
