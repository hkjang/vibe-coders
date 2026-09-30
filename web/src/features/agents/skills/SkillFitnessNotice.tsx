import { exactFitnessSkillName } from "./skill-fitness-state";
import type { useSkillFitnessQuery } from "./use-skill-fitness-editor";
import { isAppError } from "@/shared/api/error";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export function SkillFitnessNotice({
  name,
  current,
}: {
  name: string;
  current: ReturnType<typeof useSkillFitnessQuery>;
}): React.JSX.Element | null {
  if (!exactFitnessSkillName(name))
    return (
      <InlineNotice tone="warning" title="스킬 식별자를 변경 없이 확인할 수 없습니다.">
        앞뒤 공백 등 모호한 식별자를 자동으로 고쳐 다른 스킬에 기록하지 않습니다. 스킬 정의를 확인하세요.
      </InlineNotice>
    );
  if (current.confirmed) return null;
  return (
    <InlineNotice tone="warning" title="현재 스킬의 적합성 근거를 확인하기 전에는 기록할 수 없습니다.">
      {current.query.isError
        ? safeAppErrorMessage(current.query.error, "적합성 근거를 불러오지 못했습니다.")
        : "조회 중이거나 응답을 확인하지 못했습니다. 열린 초안은 유지됩니다."}
      {isAppError(current.query.error) && current.query.error.requestId ? (
        <span className="request-id"> 요청 ID: {current.query.error.requestId}</span>
      ) : null}
    </InlineNotice>
  );
}
