import type { KillSwitchState } from "@/shared/api/domains/governance";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { killSwitchMessages } from "./kill-switch-messages";

export function KillSwitchTraffic({
  traffic,
  stale,
}: {
  traffic: KillSwitchState["traffic"];
  stale: boolean;
}): React.JSX.Element {
  if (!traffic)
    return (
      <InlineNotice tone="info" title="요청 수 관측값이 없습니다.">
        관측값 부재는 0건이 아닙니다.
      </InlineNotice>
    );
  return (
    <section aria-label="응답한 서버의 현재 트래픽">
      <p>{killSwitchMessages.traffic}</p>
      {stale ? <p role="status">이전 관측값입니다. 상태를 다시 확인하세요.</p> : null}
      <KeyValueList
        items={[
          { label: "처리 중 요청", value: `${formatNumber(traffic.proxy_inflight)}건` },
          {
            label: "관측 시각",
            value: (
              <time dateTime={traffic.observed_at} title={traffic.observed_at}>
                {formatDateTime(traffic.observed_at)}
              </time>
            ),
          },
          { label: "응답한 서버 참조", value: traffic.instance_ref, mono: true },
        ]}
      />
      <p>부하 분산·재시작 시 서버 참조가 바뀝니다. 관리·MCP·별도 기능은 제외합니다.</p>
    </section>
  );
}
