import type { AdminStats } from "@/shared/api/schemas";
import { formatDateTime, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";
import type { UsageColumn } from "./OverviewUsageTable";

type Metrics = { requests: number; tokens: number; cost_krw: number; average_latency_ms: number };
type Group = AdminStats["by_model"][number];
type Key = AdminStats["top_users"][number];
type Language = AdminStats["by_language"][number];

export const usageLabel = (value: string): string => value || "미확인";
export const keyLabel = (row: Key): string => row.name || row.api_key_id || "미확인";
export const keySearch = (row: Key): string => `${keyLabel(row)} ${row.team || "미확인"}`;
export const groupLabel = (row: Group): string => usageLabel(row.key);
export const languageLabel = (row: Language): string => usageLabel(row.language);
export const keyIdentity = (row: Key): string => row.api_key_id;
export const groupIdentity = (row: Group): string => row.key;
export const languageIdentity = (row: Language): string => row.language;

function metricColumns<T extends Metrics>(): UsageColumn<T>[] {
  return [
    {
      id: "requests",
      title: "요청 수",
      value: (row) => row.requests,
      cell: (row) => formatNumber(row.requests),
      numeric: true,
    },
    {
      id: "tokens",
      title: "토큰 수",
      value: (row) => row.tokens,
      cell: (row) => formatNumber(row.tokens),
      numeric: true,
    },
    {
      id: "cost",
      title: "비용 (원)",
      value: (row) => row.cost_krw,
      cell: (row) => formatKRW(row.cost_krw),
      numeric: true,
    },
    {
      id: "latency",
      title: "평균 지연 (ms)",
      value: (row) => row.average_latency_ms,
      cell: (row) => formatNumber(row.average_latency_ms),
      numeric: true,
    },
  ];
}

export const keyColumns: readonly UsageColumn<Key>[] = [
  { id: "name", title: "API 키 이름", value: keyLabel },
  { id: "team", title: "팀", value: (row) => usageLabel(row.team) },
  ...metricColumns<Key>(),
  {
    id: "last_seen",
    title: "마지막 사용",
    value: (row) => Date.parse(row.last_seen) || 0,
    cell: (row) => formatDateTime(row.last_seen),
    numeric: true,
  },
];
export const modelColumns: readonly UsageColumn<Group>[] = [
  { id: "model", title: "모델", value: groupLabel },
  ...metricColumns<Group>(),
];
export const ipColumns: readonly UsageColumn<Group>[] = [
  { id: "ip", title: "클라이언트 IP", value: groupLabel },
  ...metricColumns<Group>().filter((column) => column.id !== "latency"),
];
export const languageColumns: readonly UsageColumn<Language>[] = [
  { id: "language", title: "언어", value: languageLabel },
  {
    id: "requests",
    title: "요청 수",
    value: (row) => row.requests,
    cell: (row) => formatNumber(row.requests),
    numeric: true,
  },
  {
    id: "confidence",
    title: "평균 신뢰도",
    value: (row) => row.average_confidence,
    cell: (row) => formatPercent(row.average_confidence),
    numeric: true,
  },
];

const statusLabels: Record<string, string> = {
  "2xx": "성공 (2xx)",
  "3xx": "리다이렉트 (3xx)",
  "4xx": "클라이언트 오류 (4xx)",
  quota: "한도 초과",
  "5xx": "서버 오류 (5xx)",
};
type Status = AdminStats["by_status"][number];
export const statusLabel = (row: Status): string => statusLabels[row.class] ?? row.class;
export const statusIdentity = (row: Status): string => row.class;
export function statusColumns(total: number): UsageColumn<Status>[] {
  return [
    { id: "class", title: "상태", value: statusLabel },
    {
      id: "requests",
      title: "요청 수",
      value: (row) => row.requests,
      cell: (row) => formatNumber(row.requests),
      numeric: true,
    },
    {
      id: "share",
      title: "수신 상태 내 비중",
      value: (row) => (total > 0 ? row.requests / total : 0),
      cell: (row) => formatPercent(total > 0 ? row.requests / total : 0),
      numeric: true,
    },
  ];
}
