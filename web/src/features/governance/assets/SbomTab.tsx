import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { sbomTypeLabels, sbomTypes } from "@/features/governance/assets/sbom-types";
import { BadgeList, PanelFailure } from "@/features/governance/reports/report-parts";
import { downloadExport } from "@/features/governance/reports/report-download";
import { apiClient } from "@/shared/api/client";
import type { SbomEntry } from "@/shared/api/domains/governance-reports";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatNumber } from "@/shared/utils/format";

function sbomColumns(): ReadonlyArray<DataTableColumn<SbomEntry>> {
  const column = createDataTableColumnHelper<SbomEntry>();
  return column.columns([
    column.accessor((row) => row.type, {
      id: "type",
      header: "유형",
      cell: ({ row }) => <Badge tone="info">{sbomTypeLabels[row.original.type] ?? row.original.type}</Badge>,
    }),
    column.accessor((row) => row.name || row.id, {
      id: "name",
      header: "이름",
      cell: ({ row }) => (
        <div>
          <div>{row.original.name || row.original.id}</div>
          <div className="mono truncate" title={row.original.id}>
            {row.original.id}
          </div>
        </div>
      ),
    }),
    column.accessor((row) => row.owner, {
      id: "owner",
      header: "소유자",
      cell: ({ row }) =>
        row.original.owner === "(미지정)" ? <Badge tone="warning">미지정</Badge> : row.original.owner || "—",
    }),
    column.accessor((row) => row.status, { id: "status", header: "상태" }),
    column.accessor((row) => row.deps, {
      id: "deps",
      header: "의존성",
      cell: ({ row }) => (
        <span className="truncate" title={row.original.deps}>
          {row.original.deps || "—"}
        </span>
      ),
    }),
    column.accessor((row) => row.gaps.join(", "), {
      id: "gaps",
      header: "공백",
      cell: ({ row }) => <BadgeList items={row.original.gaps} tone="danger" />,
    }),
  ]);
}

export function SbomTab({
  canExport,
  onTypeChange,
  refetchInterval,
  type,
}: {
  canExport: boolean;
  onTypeChange: (type: string) => void;
  refetchInterval: number | false;
  type: string;
}): React.JSX.Element {
  const columns = useMemo(() => sbomColumns(), []);
  const [gapsOnly, setGapsOnly] = useState(false);
  const [exporting, setExporting] = useState(false);
  const sbom = useQuery({
    queryKey: ["governance", "sbom"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governanceReports.sbom, {
        signal,
        routeId: "governance.assets",
      }),
    refetchInterval,
    refetchIntervalInBackground: false,
  });

  const entries = sbom.data?.entries ?? [];
  const byType = sbom.data?.by_type ?? {};
  const visible = entries.filter(
    (entry) => (type === "" || entry.type === type) && (!gapsOnly || entry.gaps.length > 0),
  );

  const exportJson = async (): Promise<void> => {
    setExporting(true);
    try {
      await downloadExport("/admin/sbom", "ai-asset-sbom.json");
      toast.success("AI 자산 SBOM을 JSON으로 내려받았습니다.");
    } catch (error) {
      toast.error(safeAppErrorMessage(error, "JSON을 내려받지 못했습니다."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="gov-stack">
      {sbom.isError ? (
        <PanelFailure error={sbom.error} label="AI 자산 SBOM" onRetry={() => void sbom.refetch()} />
      ) : null}
      <StatGrid label="AI 자산 요약">
        <StatCard label="총 자산" value={formatNumber(sbom.data?.total ?? 0)} />
        {sbomTypes.map((assetType) => (
          <StatCard
            key={assetType}
            label={sbomTypeLabels[assetType] ?? assetType}
            value={formatNumber(byType[assetType] ?? 0)}
          />
        ))}
        <StatCard
          label="거버넌스 공백"
          tone={(sbom.data?.gap_count ?? 0) > 0 ? "warning" : "success"}
          value={formatNumber(sbom.data?.gap_count ?? 0)}
          hint="소유자 미지정·검증 미흡 등"
        />
      </StatGrid>

      <SectionCard
        headingLevel={2}
        title={`자산 명세 (${formatNumber(visible.length)})`}
        description="게이트웨이가 관리하는 AI 자산의 소유권·상태·의존성 명세입니다."
        actions={
          <Button
            onClick={() => void exportJson()}
            disabled={!canExport || exporting}
            title={canExport ? undefined : "내보내려면 admin:read 권한이 필요합니다."}
          >
            <Download aria-hidden="true" /> JSON 내보내기
          </Button>
        }
      >
        <Toolbar label="자산 필터">
          <label className="gov-toolbar-field">
            자산 유형
            <Select value={type} onChange={(event) => onTypeChange(event.currentTarget.value)}>
              <option value="">전체 유형</option>
              {sbomTypes.map((assetType) => (
                <option key={assetType} value={assetType}>
                  {sbomTypeLabels[assetType] ?? assetType}
                </option>
              ))}
            </Select>
          </label>
          <Checkbox
            label="거버넌스 공백만 보기"
            checked={gapsOnly}
            onChange={(event) => setGapsOnly(event.currentTarget.checked)}
          />
        </Toolbar>
        <DataTable
          caption="AI 자산 SBOM"
          columns={columns}
          data={visible}
          getRowId={(row, index) => `${row.type}-${row.id}-${index}`}
          loading={sbom.isPending}
          error={sbom.isError ? safeAppErrorMessage(sbom.error, "SBOM을 불러오지 못했습니다.") : undefined}
          onRetry={() => void sbom.refetch()}
          emptyMessage="조건에 맞는 자산이 없습니다."
        />
        {!sbom.isPending && !sbom.isError && entries.length === 0 ? (
          <EmptyState
            title="등록된 AI 자산이 없습니다."
            description="스킬·워크플로·AI 앱·모델 계약·프롬프트 자산을 만들면 이 명세에 나타납니다."
          />
        ) : null}
        {sbom.data?.note ? <p className="gov-note">{sbom.data.note}</p> : null}
      </SectionCard>
    </div>
  );
}
