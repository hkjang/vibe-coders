import type { PromptTestCase } from "@/shared/api/domains/gateway.schemas";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { labExecutionModels } from "./prompt-lab-model";

export function LabRunReview({ target }: { target: PromptTestCase | undefined }) {
  const models = labExecutionModels(target?.models_json);
  return (
    <div className="page-stack" tabIndex={0} role="region" aria-label="실행 조건 검토">
      <dl className="lab-metadata">
        <dt>저장된 실행 모델</dt>
        <dd>{models?.join(", ") || "모델 설정 확인 필요"}</dd>
        <dt>예상 모델 호출</dt>
        <dd>{models ? `${models.length}회` : "미확인"}</dd>
        <dt>출력 계약</dt>
        <dd>{target?.contract_id || "미지정"}</dd>
      </dl>
      <InlineNotice title="실행 조건 확인">
        중복 모델을 제외한 처음 5개 모델까지 호출합니다. 실제 공급자 요청과 비용이 발생하며 이 화면에서
        금액·출력 토큰 상한을 설정하지 않습니다. 현재 자동 채점은 서버의 규칙 기반 검사이며 별도로 등록한 평가
        기준은 적용되지 않습니다. 출력 계약은 저장된 응답 일부를 검사하며 전체 응답의 형식 준수를 보장하지
        않습니다.
      </InlineNotice>
      <p>기존 서버 실행 기록에는 모델 응답 일부가 저장될 수 있습니다. 입력·모델을 확인한 뒤 실행하세요.</p>
    </div>
  );
}
