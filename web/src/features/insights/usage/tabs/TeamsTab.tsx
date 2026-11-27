import { categoryPaint } from "@/features/insights/charts/palette";
import { SankeyChart } from "@/features/insights/charts/SankeyChart";
import type { WorkTeamRow } from "@/shared/api/domains/insights-usage";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

import { flowColumns, flowNodeKey, flowNodePaint, isFlowRest } from "../flow-model";
import { MatrixPanel, noTeamLabel } from "../panels/MatrixPanel";
import { useFlow, useMatrix, useTeams } from "../use-usage-queries";
import { sessionsUpdates, useUsageNav } from "../use-usage-nav";
import {
  changeRate,
  formatChange,
  formatMetric,
  formatSigned,
  metricLabels,
  metricValue,
  suppressedHint,
} from "../usage-metrics";
import type { UsageTabProps } from "../usage-tab-props";
import { CategoryLabel, Panel, PlainTable, Suppressed, type PlainColumn } from "../usage-ui";

const topCategories = 3;

export function TeamsTab({ filters, query, minGroupSize }: UsageTabProps): React.JSX.Element {
  const nav = useUsageNav();
  const { metric } = filters;
  const matrix = useMatrix(query);
  const flow = useFlow(query);
  const teams = useTeams(query);
  const withheld = <Suppressed minGroupSize={minGroupSize} />;
  // A withheld team has its lists emptied by the server: say 보호됨 rather than "none".
  const listOrNone = (row: WorkTeamRow, length: number, list: () => React.JSX.Element): React.ReactNode =>
    length > 0 ? list() : row.suppressed ? withheld : "—";

  const columns: PlainColumn<WorkTeamRow>[] = [
    { id: "team", header: "조직", cell: (row) => row.team || noTeamLabel },
    {
      id: "value",
      header: metricLabels[metric],
      numeric: true,
      cell: (row) => {
        const value = metricValue(row.current, metric);
        if (row.suppressed || value === null) return <Suppressed minGroupSize={minGroupSize} />;
        const change =
          filters.compare && row.previous ? changeRate(value, metricValue(row.previous, metric)) : undefined;
        return (
          <>
            {formatMetric(value, metric)}
            {change !== undefined ? <small className="wi-cell-sub">{formatChange(change)}</small> : null}
          </>
        );
      },
    },
    {
      id: "users",
      header: "활성 사용자",
      numeric: true,
      help: "기간 안에 AI를 한 번 이상 쓴 고유 사용자 수입니다. 조직 정원이 아닙니다.",
      cell: (row) =>
        row.suppressed || row.current.users === null ? (
          <Suppressed minGroupSize={minGroupSize} />
        ) : (
          `${formatNumber(row.current.users)}명`
        ),
    },
    {
      id: "per-user",
      header: "사용자당 세션",
      numeric: true,
      help: "세션 수 ÷ 활성 사용자 수. 분모는 정원이 아니라 활성 사용자입니다.",
      cell: (row) =>
        row.suppressed || row.sessions_per_user === null ? (
          <Suppressed minGroupSize={minGroupSize} />
        ) : (
          formatNumber(row.sessions_per_user, 1)
        ),
    },
    {
      id: "top",
      header: `주력 업무 TOP ${topCategories}`,
      cell: (row) =>
        listOrNone(row, row.top_categories.length, () => (
          <ul className="wi-cell-list">
            {row.top_categories.slice(0, topCategories).map((item) => (
              <li key={item.category.id}>
                <CategoryLabel
                  name={item.category.name || item.category.id}
                  paint={categoryPaint(item.category.id)}
                />
                <span>{formatPercent(item.share, 0)}</span>
              </li>
            ))}
          </ul>
        )),
    },
    {
      id: "diversity",
      header: "다양성",
      numeric: true,
      help: "업무가 여러 유형에 고르게 퍼진 정도입니다. 클수록 다양한 업무에 씁니다.",
      cell: (row) => (row.suppressed || row.diversity === null ? withheld : formatNumber(row.diversity, 2)),
    },
    {
      id: "cost",
      header: "비용",
      numeric: true,
      cell: (row) => {
        const cost = row.suppressed ? null : metricValue(row.current, "cost");
        return cost === null ? withheld : formatKRW(cost);
      },
    },
    {
      id: "rising",
      header: "최근 증가 업무",
      cell: (row) =>
        listOrNone(row, row.rising.length, () => (
          <ul className="wi-cell-list">
            {row.rising.slice(0, topCategories).map((item) => (
              <li key={item.category.id}>
                <span>{item.category.name || item.category.id}</span>
                <span>{formatSigned(item.delta, metric)}</span>
              </li>
            ))}
          </ul>
        )),
    },
    {
      id: "deviation",
      header: "전체 대비 편차",
      help: "이 조직에서의 업무 비중에서 전체 조직의 비중을 뺀 값(퍼센트포인트)입니다.",
      cell: (row) =>
        listOrNone(row, row.deviation.length, () => (
          <ul className="wi-cell-list">
            {row.deviation.slice(0, topCategories).map((item) => {
              const points = (item.team_share - item.overall_share) * 100;
              return (
                <li key={item.category.id}>
                  <span>{item.category.name || item.category.id}</span>
                  <span
                    title={`조직 ${formatPercent(item.team_share)} · 전체 ${formatPercent(item.overall_share)}`}
                  >
                    {points >= 0 ? "+" : "−"}
                    {Math.abs(points).toFixed(1)}%p
                  </span>
                </li>
              );
            })}
          </ul>
        )),
    },
  ];

  return (
    <div className="wi-stack">
      <InlineNotice tone="info" title="이 탭의 수치를 읽는 법">
        사용자당 수치의 분모는 조직 정원이 아니라 기간 안에 AI를 쓴 <strong>활성 사용자</strong>입니다.
        사용량이 많다는 것은 성과가 좋다는 뜻이 아니며, 이 화면은 조직이나 개인의 성과 평가에 쓰도록 만든 것이
        아닙니다. 활성 사용자가 {formatNumber(minGroupSize)}명 미만인 조직·칸과, 다른 값에서 빼서 그런 값을
        알아낼 수 있는 칸은 값을 가립니다.
      </InlineNotice>

      <SectionCard
        title="조직 × 업무 히트맵"
        description={`조직별로 어떤 업무에 ${metricLabels[metric]}가 몰리는지입니다. 칸을 누르면 그 조직·업무의 세션 목록으로 이동합니다.`}
      >
        <Panel query={matrix} label="조직 × 업무 히트맵" isEmpty={(data) => data.rows.length === 0}>
          {(data) => (
            <MatrixPanel
              data={data}
              metric={metric}
              minGroupSize={minGroupSize}
              onSelectCell={(team, category) => nav.go(sessionsUpdates({ team, category }))}
              onSelectCategory={(category) => nav.go({ tab: "categories", parent: category })}
            />
          )}
        </Panel>
      </SectionCard>

      <SectionCard
        title="조직 → 업무 → 모델 흐름"
        description={`${metricLabels[metric]}가 어느 조직에서 어떤 업무를 거쳐 어떤 모델로 가는지입니다. 띠의 굵기가 크기입니다.`}
      >
        <Panel
          query={flow}
          label="조직 → 업무 → 모델 흐름"
          isEmpty={(data) =>
            (data.links.length === 0 || data.nodes.length === 0) && data.suppressed_links === 0
          }
          withheld={{ when: (data) => data.suppressed && data.links.length === 0, minGroupSize }}
        >
          {(data) => (
            <>
              <SankeyChart
                caption={`조직에서 업무를 거쳐 모델로 가는 ${metricLabels[metric]} 흐름`}
                columns={flowColumns}
                nodes={data.nodes}
                links={data.links}
                paintOf={flowNodePaint}
                format={(value) => formatMetric(value, metric)}
                valueHeader={metricLabels[metric]}
                selectableKinds={["team", "category", "model"]}
                isSelectable={(node) => !isFlowRest(node)}
                selectHint="관련 목록 보기"
                onSelect={(node) => {
                  const key = flowNodeKey(node);
                  if (node.kind === "team") nav.go(sessionsUpdates({ team: key }));
                  else if (node.kind === "category") nav.go({ tab: "categories", parent: key });
                  else nav.go({ tab: "models", model: key });
                }}
              />
              {data.suppressed_links > 0 ? (
                <p className="wi-note" title={suppressedHint(minGroupSize)}>
                  보호된 연결 {formatNumber(data.suppressed_links)}개: 사용자가 적은 연결은 그리지 않고, 작은
                  조직·업무·모델은 열마다 ‘기타’로 묶었습니다. 노드 크기는 보이는 연결의 합입니다.
                </p>
              ) : null}
            </>
          )}
        </Panel>
      </SectionCard>

      <SectionCard
        title="조직별 활용"
        description="조직마다 주로 쓰는 업무, 활성 사용자, 다양성, 비용과 전체와 다른 점입니다."
      >
        <Panel query={teams} label="조직별 활용" isEmpty={(data) => data.rows.length === 0}>
          {(data) => (
            <>
              <PlainTable
                caption="조직별 업무 활용"
                wide
                columns={columns}
                rows={data.rows}
                rowKey={(row, index) => row.team || `none-${index}`}
              />
              <p className="wi-note">
                분모: {data.denominators === "active_users" ? "활성 사용자" : data.denominators}. 조직 정원과
                부서 계층은 이 서버에 없어 반영하지 않습니다.
              </p>
            </>
          )}
        </Panel>
      </SectionCard>
    </div>
  );
}
