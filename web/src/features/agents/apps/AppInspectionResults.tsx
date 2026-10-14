import { appComponentKindLabels } from "./app-form";
import type { AppRunPlan, AppValidation } from "@/shared/api/domains/agents.schemas";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import type { ReactNode } from "react";

function ResultCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section-card">
      <header className="section-card-header">
        <h4>{title}</h4>
      </header>
      <div className="section-card-body">{children}</div>
    </section>
  );
}

const actions: Record<string, string> = {
  chat: "채팅 호출",
  text2sql_report: "SQL 리포트",
  mcp: "MCP 도구",
  model: "추천 모델",
  unknown: "알 수 없는 작업",
};
const kindLabel = (kind: string) =>
  appComponentKindLabels[kind as keyof typeof appComponentKindLabels] ?? kind;

export function AppInspectionResults({
  validation,
  plan,
}: {
  validation: AppValidation | undefined;
  plan: AppRunPlan | undefined;
}) {
  return (
    <>
      {validation ? (
        <ResultCard title="검증 결과">
          <InlineNotice tone={validation.ok && validation.checks.length > 0 ? "success" : "warning"}>
            {validation.checks.length === 0
              ? "검증할 구성 요소가 없습니다."
              : validation.ok
                ? "모든 구성 요소의 참조를 확인했습니다. 실제 실행 성공을 보장하지 않습니다."
                : "확인되지 않은 구성 요소가 있습니다."}
          </InlineNotice>
          <ul className="agents-checklist">
            {validation.checks.map((check, index) => (
              <li key={index} data-ok={String(check.resolved)}>
                <span className="agents-checklist-copy">
                  <strong>
                    {check.label || check.ref || kindLabel(check.kind)} ·{" "}
                    {check.resolved ? "참조 확인" : "참조 미확인"}
                  </strong>
                  <small>
                    {kindLabel(check.kind)} · {check.detail}
                  </small>
                </span>
              </li>
            ))}
          </ul>
          {validation.warnings.length > 0 ? (
            <InlineNotice tone="warning" title="경고">
              {validation.warnings.join(" · ")}
            </InlineNotice>
          ) : null}
          {validation.allowed_models.length > 0 ? (
            <p>허용 모델: {validation.allowed_models.join(", ")}</p>
          ) : null}
        </ResultCard>
      ) : null}
      {plan ? (
        <ResultCard title="실행 계획">
          <KeyValueList
            items={[
              { label: "계획 이력 ID", value: plan.run_id, mono: true },
              { label: "상태", value: "계획 생성 · 실제 실행 안 함" },
              { label: "대상 앱", value: plan.app_id, mono: true },
            ]}
          />
          {plan.plan.some((step) => !step.resolved) ? (
            <InlineNotice tone="warning">
              참조가 확인되지 않은 단계가 있습니다. 이 계획을 실행 가능한 상태로 간주하지 마세요.
            </InlineNotice>
          ) : null}
          <ol className="agents-checklist">
            {plan.plan.map((step, index) => (
              <li key={index} data-ok={String(step.resolved)}>
                <span className="agents-checklist-copy">
                  <strong>
                    {index + 1}. {step.label || step.ref || kindLabel(step.kind)} ·{" "}
                    {step.resolved ? "참조 확인" : "참조 미확인"}
                  </strong>
                  <small>
                    {actions[step.action] ?? "알 수 없는 작업"}
                    {step.endpoint ? ` · ${step.endpoint}` : ""}
                    {step.hint ? ` · ${step.hint}` : ""} · {step.detail}
                  </small>
                </span>
              </li>
            ))}
          </ol>
        </ResultCard>
      ) : null}
    </>
  );
}
