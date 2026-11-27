import { apiClient } from "@/shared/api/client";
import type { WorkQuery } from "@/shared/api/domains/insights-common";
import type { WorkExportQuery, WorkExportView } from "@/shared/api/domains/insights-usage";
import { downloadApiFile } from "@/shared/api/download-file";
import { fileEndpoints } from "@/shared/api/file-endpoints";
import type { FileDownloadContext } from "@/shared/hooks/use-file-download";

import type { ListKind } from "./session-list-model";
import type { UsageTab } from "./usage-filters";

export const exportViewLabels: Readonly<Record<WorkExportView, string>> = {
  categories: "업무 유형",
  teams: "조직",
  models: "모델",
  sessions: "업무 세션",
  requests: "요청",
};

/** The server table a tab exports; undefined for tabs the export endpoint has no table for. */
export function exportView(tab: UsageTab, list: ListKind): WorkExportView | undefined {
  switch (tab) {
    case "summary":
    case "categories":
      return "categories";
    case "teams":
      return "teams";
    case "models":
      return "models";
    case "sessions":
      return list;
    default:
      return undefined;
  }
}

interface ExportContext {
  /** The category whose children the 업무 유형 tab is showing. */
  parent: string;
  /** Classification status filter of the request list. */
  status: string;
}

/**
 * The export query: the same filters the screen reads with. A drill-down level
 * narrows the export to that category, and the request list keeps its status filter.
 */
export function exportQuery(base: WorkQuery, view: WorkExportView, context: ExportContext): WorkExportQuery {
  return {
    ...base,
    ...(view === "categories" && context.parent && !base.category ? { category: context.parent } : {}),
    ...(view === "requests" && context.status ? { status: context.status } : {}),
    view,
  };
}

export const exportFilename = (query: WorkExportQuery): string =>
  `work-usage-${query.view}-${query.from ?? "from"}_${query.to ?? "to"}.csv`;

export async function downloadUsageCsv(
  query: WorkExportQuery,
  ownership: FileDownloadContext,
): Promise<void> {
  const file = await apiClient.file(fileEndpoints.workUsage, {
    ...ownership,
    query,
    routeId: "insights.usage",
  });
  downloadApiFile(exportFilename(query), file);
}
