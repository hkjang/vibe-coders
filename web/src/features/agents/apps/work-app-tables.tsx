import { useMemo } from "react";
import type { WorkAppMetadata } from "@/shared/api/domains/work-app-page.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import type { DataTableColumn } from "@/shared/data-table/columns";
import { displayColumn } from "@/features/agents/table-columns";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { WorkAppDetailLink } from "./WorkAppDetailLink";

export function workAppStatusLabel(status: string | undefined): string {
  return status === "active" ? "활성" : status === "archived" ? "보관" : "상태 확인 필요";
}

export function useWorkAppColumns(onOpen?: (trigger: HTMLElement) => boolean) {
  return useMemo<ReadonlyArray<DataTableColumn<WorkAppMetadata>>>(
    () => [
      displayColumn<WorkAppMetadata>("title", "앱", (row) => <WorkAppDetailLink row={row} onOpen={onOpen} />),
      displayColumn<WorkAppMetadata>("status", "상태", (row) => (
        <Badge tone={row.status === "active" ? "success" : "muted"}>{workAppStatusLabel(row.status)}</Badge>
      )),
      displayColumn<WorkAppMetadata>("components", "구성 요소", (row) => (
        <span className="cell-number">{formatNumber(row.component_count)}</span>
      )),
      displayColumn<WorkAppMetadata>("scope", "허용 팀/역할", (row) =>
        [row.allowed_teams || "전체 팀", row.allowed_roles || "전체 역할"].join(" · "),
      ),
      displayColumn<WorkAppMetadata>("owner", "책임자", (row) => row.owner || "—"),
      displayColumn<WorkAppMetadata>("created_at", "생성일", (row) => formatDateTime(row.created_at)),
      displayColumn<WorkAppMetadata>("updated_at", "수정일", (row) => formatDateTime(row.updated_at)),
      displayColumn<WorkAppMetadata>("id", "ID", (row) => row.id),
    ],
    [onOpen],
  );
}
