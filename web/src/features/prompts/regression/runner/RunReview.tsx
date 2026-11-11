import { useEffect, useRef } from "react";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { formatNumber, formatPercent } from "@/shared/utils/format";
import { RegressionText } from "../RegressionText";
import type { RunPlan } from "./run-model";

export function RunReview({ plan }: { plan: RunPlan }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section className="page-stack" aria-label="실행 내용 검토">
      <h3 ref={heading} tabIndex={-1}>
        실행 내용 검토
      </h3>
      <dl className="regression-run-summary">
        <div>
          <dt>실행 대상</dt>
          <dd>
            {plan.targets.length}개 정의 · {plan.targets.reduce((sum, row) => sum + row.units, 0)}개 검사
          </dd>
        </div>
        <div>
          <dt>비교 모델</dt>
          <dd>{plan.values.models.join(", ")}</dd>
        </div>
        <div>
          <dt>예상 호출 / 지정 한도</dt>
          <dd>
            {plan.calls}회 / {plan.values.maxCalls}회
          </dd>
        </div>
        <div>
          <dt>호출당 출력 토큰 요청 상한</dt>
          <dd>{formatNumber(plan.values.outputTokens)} 토큰</dd>
        </div>
        <div>
          <dt>전체 검사 통과 기준</dt>
          <dd>{formatPercent(plan.values.passRate)}</dd>
        </div>
        <div>
          <dt>등록 입력 크기</dt>
          <dd>
            {formatNumber(plan.targets.reduce((sum, row) => sum + row.inputCharacters, 0))}자 · 모델별 반복
          </dd>
        </div>
      </dl>
      <InlineNotice tone="warning" title="실제 모델 호출 비용이 발생합니다">
        서버가 검토한 정의와 호출 수를 확인한 뒤 최대 120초 동안 순차 실행합니다. 출력 토큰은 공급자에
        요청하는 상한이며 금액 한도가 아닙니다. 공용 지식 확장으로 실제 입력이 늘어날 수 있습니다. 빈 기대
        내용은 일치 점수 0으로도 통과할 수 있으며 통과 기준은 문자열 검사 결과입니다.
      </InlineNotice>
      {plan.kind === "workflow" ? (
        <p className="muted">
          각 모델로 모든 단계를 독립 검사합니다. 등록된 단계의 모델·기준 점수로 실행 모델을 바꾸거나 앞 단계의
          출력을 전달하지 않습니다.
        </p>
      ) : null}
      {plan.targets.map((target) => (
        <details key={target.id}>
          <summary>
            {target.name || "이름 없음"} · {target.units}개 검사 입력 확인
          </summary>
          {target.checks.map((check, index) => (
            <section key={index} className="page-stack">
              <h4>
                {index + 1}. {check.name || "이름 없는 검사"}
              </h4>
              <RegressionText label="검사 입력" value={check.prompt} />
              <RegressionText label="기대 내용" value={check.expected} />
            </section>
          ))}
        </details>
      ))}
    </section>
  );
}
