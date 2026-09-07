import type { OnboardingCheck } from "@/shared/api/domains/agents.schemas";

const checkLabels: Record<string, string> = {
  title: "앱 제목",
  owner: "책임자(owner)",
  components: "구성 요소",
  description: "설명",
  access_scope: "허용 팀/역할",
};

interface OnboardingChecklistProps {
  checks: readonly OnboardingCheck[];
  label: string;
}

/** Publish-readiness checklist returned by `/admin/apps/onboarding-check` and the publish gate. */
export function OnboardingChecklist({ checks, label }: OnboardingChecklistProps): React.JSX.Element {
  return (
    <ul className="agents-checklist" aria-label={label}>
      {checks.map((check) => (
        <li key={check.key ?? check.detail} data-ok={String(check.ok !== false)}>
          <span className="agents-checklist-copy">
            <strong>
              {checkLabels[check.key ?? ""] ?? check.key ?? "점검"}
              {check.severity === "required" ? " (필수)" : " (권장)"}
            </strong>
            <small>
              {check.ok === false ? "미충족 · " : "충족 · "}
              {check.detail ?? ""}
            </small>
          </span>
        </li>
      ))}
    </ul>
  );
}
