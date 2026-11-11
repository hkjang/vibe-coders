import "@/features/gateway/gateway.css";
import "./prompt-lab.css";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { usePromptLabController } from "./use-prompt-lab-controller";
import { PromptLabPanels } from "./PromptLabPanels";
import { PromptLabForms } from "./PromptLabForms";
import { PromptLabActions } from "./PromptLabActions";
import { PromptLabBoundary } from "./PromptLabBoundary";
import { PromptLabHistory } from "./PromptLabHistory";
import { useSearchState } from "@/shared/hooks/use-search-state";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
export function PromptLabPage() {
  const [params] = useSearchState();
  return (
    <PromptLabBoundary>
      {(owner) => <PromptLabContent key={params.get("exp") ?? ""} owner={owner} />}
    </PromptLabBoundary>
  );
}
function PromptLabContent({ owner }: { owner: FeatureReadOwner }) {
  const lab = usePromptLabController(owner);
  return (
    <div className="page-stack">
      <PageHeader
        title="프롬프트 실험실"
        status="preview"
        description="프롬프트 실험과 테스트 케이스, 출력 계약과 평가 기준을 관리합니다."
        legacyHref="/admin#/prompt-lab"
      />
      <PromptLabPanels lab={lab} />
      <PromptLabForms lab={lab} />
      <PromptLabActions lab={lab} />
      {lab.historyCase ? (
        <PromptLabHistory key={lab.historyCase.id} lab={lab} target={lab.historyCase} />
      ) : null}
    </div>
  );
}
