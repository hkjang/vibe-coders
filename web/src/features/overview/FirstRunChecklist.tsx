import { Check, CircleDashed } from "lucide-react";
import { Link } from "react-router";

import { setupSteps } from "@/features/overview/setup-steps";
import type { AdminStats, OpsStatus } from "@/shared/api/schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { SectionCard } from "@/shared/components/ui/SectionCard";

interface FirstRunChecklistProps {
  stats: AdminStats | undefined;
  status: OpsStatus | undefined;
}

/**
 * A gateway with no traffic yet shows zeros everywhere, which says nothing about what to
 * do next. This turns that first screen into the setup it is: what is already done, what
 * is left, and one link per step. It disappears on its own once traffic arrives.
 */
export function FirstRunChecklist({ stats, status }: FirstRunChecklistProps): React.JSX.Element | null {
  // Only while the gateway has never served a request: after that the zeros are real data.
  if (stats === undefined || stats.total_requests > 0) return null;

  const steps = setupSteps(stats, status);
  const remaining = steps.filter((step) => !step.done).length;

  return (
    <SectionCard
      title="게이트웨이 시작하기"
      description="아직 처리한 요청이 없습니다. 아래를 마치면 이 화면의 지표와 추적이 채워집니다."
      actions={<Badge tone={remaining === 0 ? "success" : "info"}>남은 단계 {remaining}</Badge>}
    >
      <ol className="setup-steps" aria-label="게이트웨이 설정 단계">
        {steps.map((step) => (
          <li key={step.id} className={step.done ? "setup-step setup-step-done" : "setup-step"}>
            <span className="setup-step-mark" aria-hidden="true">
              {step.done ? <Check /> : <CircleDashed />}
            </span>
            <span className="setup-step-body">
              <strong>{step.title}</strong>
              <small>{step.why}</small>
            </span>
            {step.done ? (
              <Badge tone="success">완료</Badge>
            ) : (
              <Link className="button button-secondary button-small" to={step.to}>
                {step.action}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}
