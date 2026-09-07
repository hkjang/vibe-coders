import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PanelFailure } from "@/features/governance/reports/report-parts";
import type { ReportWindow } from "@/features/governance/reports/report-window";
import { downloadExport, exportDateStamp } from "@/features/governance/reports/report-download";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type { NarrativeSection } from "@/shared/api/domains/governance-reports";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { KeyValueList, type KeyValueItem } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDate, formatNumber } from "@/shared/utils/format";

/**
 * Section metrics are an open map. Only scalars are shown as key/value rows; nested
 * objects (for example `top_teams`) stay out of the summary rather than being guessed at.
 */
function metricItems(metrics: Record<string, unknown> | null | undefined): KeyValueItem[] {
  if (!metrics) return [];
  const items: KeyValueItem[] = [];
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number") items.push({ label: key, value: formatNumber(value, 1) });
    else if (typeof value === "string") items.push({ label: key, value });
    else if (typeof value === "boolean") items.push({ label: key, value: value ? "예" : "아니오" });
    else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      items.push({ label: key, value: value.join(" · ") });
    }
  }
  return items;
}

function NarrativeSectionCard({ section }: { section: NarrativeSection }): React.JSX.Element {
  const items = metricItems(section.metrics);
  return (
    <article className="gov-narrative-section">
      <h4>{section.title}</h4>
      <p>{section.narrative}</p>
      {items.length > 0 ? <KeyValueList columns={3} items={items} /> : null}
    </article>
  );
}

export function NarrativeTab({
  canExport,
  refetchInterval,
  window: reportWindow,
}: {
  canExport: boolean;
  refetchInterval: number | false;
  window: ReportWindow;
}): React.JSX.Element {
  const [exporting, setExporting] = useState(false);
  const report = useQuery({
    queryKey: ["governance", "narrative", reportWindow],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governanceReports.narrativeReport, {
        query: { window: reportWindow },
        signal,
        routeId: "governance.reports",
      }),
    refetchInterval,
    refetchIntervalInBackground: false,
  });

  const sections = report.data?.sections ?? [];
  const period = report.data
    ? `${formatDate(report.data.period_start)} ~ ${formatDate(report.data.period_end)}`
    : "—";

  const exportMarkdown = async (): Promise<void> => {
    setExporting(true);
    try {
      await downloadExport(
        `/admin/reports/narrative?window=${encodeURIComponent(reportWindow)}&format=md`,
        `ai-gateway-report-${exportDateStamp()}.md`,
      );
      toast.success("운영 보고서 마크다운을 내려받았습니다.");
    } catch (error) {
      toast.error(safeAppErrorMessage(error, "마크다운을 내려받지 못했습니다."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="gov-stack">
      {report.isError ? (
        <PanelFailure error={report.error} label="운영 보고서" onRetry={() => void report.refetch()} />
      ) : null}
      <SectionCard
        headingLevel={2}
        title="월간 운영 서술 보고서"
        description={`대상 기간 ${period}`}
        actions={
          <Button
            onClick={() => void exportMarkdown()}
            disabled={!canExport || exporting}
            title={canExport ? undefined : "보고서를 내려받으려면 admin:read 권한이 필요합니다."}
          >
            <Download aria-hidden="true" /> 마크다운 다운로드
          </Button>
        }
      >
        {report.isPending ? (
          <p role="status">보고서를 생성하는 중입니다.</p>
        ) : sections.length === 0 ? (
          <EmptyState
            title="아직 보고서로 만들 집계가 없습니다."
            description="요청·비용·정책 이벤트가 쌓이면 기간별 서술 보고서가 자동으로 생성됩니다."
          />
        ) : (
          <div className="gov-stack">
            {sections.map((section, index) => (
              <NarrativeSectionCard key={`${section.title}-${index}`} section={section} />
            ))}
          </div>
        )}
        {report.data?.note ? <p className="gov-note">{report.data.note}</p> : null}
      </SectionCard>
    </div>
  );
}
