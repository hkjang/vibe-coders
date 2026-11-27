import { ArrowRight } from "lucide-react";
import { Link } from "react-router";

import type { WorkInsight } from "@/shared/api/domains/insights-usage";
import { Badge } from "@/shared/components/ui/Badge";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

import { insightSearch } from "../insight-link";
import { severityLabel, severityTone } from "../usage-labels";

/** Insights with the evidence each rests on: period, comparison, sample and the numbers. */
export function InsightList({ insights }: { insights: readonly WorkInsight[] }): React.JSX.Element {
  return (
    <ul className="wi-insight-list" aria-label="인사이트 목록">
      {insights.map((insight) => {
        const search = insightSearch(insight.link);
        const figures = Object.entries(insight.evidence.metrics);
        return (
          <li key={insight.id} className="wi-insight">
            <div className="wi-insight-head">
              <Badge tone={severityTone(insight.severity)}>{severityLabel(insight.severity)}</Badge>
              <strong>{insight.title}</strong>
            </div>
            {insight.body ? <p>{insight.body}</p> : null}
            <dl className="wi-signal-facts">
              <div>
                <dt>기간</dt>
                <dd>{insight.evidence.period || "—"}</dd>
              </div>
              <div>
                <dt>비교</dt>
                <dd>{insight.evidence.compare || "비교 없음"}</dd>
              </div>
              <div>
                <dt>표본</dt>
                <dd>{formatNumber(insight.evidence.sample)}건</dd>
              </div>
              {figures.map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{formatNumber(value, 2)}</dd>
                </div>
              ))}
            </dl>
            <div className="wi-insight-foot">
              <span>{insight.created_at ? `${formatDateTime(insight.created_at)} 생성` : ""}</span>
              {search !== undefined ? (
                <Link to={{ search }} aria-label={`${insight.title} 근거 화면 열기`}>
                  근거 보기 <ArrowRight aria-hidden="true" />
                </Link>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
