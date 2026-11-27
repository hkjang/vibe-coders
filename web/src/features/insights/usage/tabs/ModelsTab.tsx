import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { formatNumber } from "@/shared/utils/format";

import { ModelTable, SuggestionList } from "../panels/ModelTable";
import { suppressedLabel } from "../usage-metrics";
import { useModels } from "../use-usage-queries";
import type { UsageTabProps } from "../usage-tab-props";
import { Panel } from "../usage-ui";

export function ModelsTab({ query, minGroupSize }: UsageTabProps): React.JSX.Element {
  const models = useModels(query);
  return (
    <div className="wi-stack">
      <SectionCard
        title="업무 × 모델"
        description="업무마다 어떤 모델이 얼마나 쓰이는지, 세션당 토큰·비용, 지연, 오류·재시도·모델 전환율과 피드백입니다."
      >
        <Panel
          query={models}
          label="업무 × 모델"
          isEmpty={(data) => data.rows.length === 0}
          withheld={{ when: (data) => data.suppressed && data.rows.length === 0, minGroupSize }}
        >
          {(data) => {
            const lowSample = data.rows.filter((row) => row.low_sample && !row.suppressed).length;
            const withheld = data.rows.filter((row) => row.suppressed).length;
            return (
              <>
                <ModelTable rows={data.rows} minGroupSize={minGroupSize} />
                <p className="wi-note">
                  P50·P95 지연은 지연 히스토그램에서 추정한 값입니다.
                  {lowSample > 0
                    ? ` ‘표본 적음’ ${formatNumber(lowSample)}개 행은 표본이 적어 비율이 크게 흔들릴 수 있으니 판단 근거로 쓰지 마세요.`
                    : ""}
                  {withheld > 0
                    ? ` 사용자가 적은 ${formatNumber(withheld)}개 행은 수치를 ‘${suppressedLabel}’으로 가렸고, 모델 변경 제안에서도 뺐습니다.`
                    : ""}
                </p>
              </>
            );
          }}
        </Panel>
      </SectionCard>

      <SectionCard
        title="더 저렴한 모델 제안"
        description="같은 업무에서 품질 신호가 비슷한 더 저렴한 모델이 있을 때만 제안합니다. 근거와 표본을 함께 봅니다."
      >
        <Panel
          query={models}
          label="모델 변경 제안"
          isEmpty={(data) => data.suggestions.length === 0}
          emptyHint="표본이 충분하고 차이가 뚜렷한 경우에만 제안이 나옵니다."
          withheld={{ when: (data) => data.suppressed && data.rows.length === 0, minGroupSize }}
        >
          {(data) => (
            <>
              <SuggestionList suggestions={data.suggestions} />
              <InlineNotice tone="info">
                제안은 집계에서 계산한 참고 자료입니다. 라우팅 규칙은 바뀌지 않으며, 적용은 라우팅 화면에서
                직접 검토해 결정하세요.
              </InlineNotice>
            </>
          )}
        </Panel>
      </SectionCard>
    </div>
  );
}
