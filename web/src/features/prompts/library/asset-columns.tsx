import { Send, Trash2 } from "lucide-react";
import type { PromptAsset } from "@/shared/api/domains/prompts";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Switch } from "@/shared/components/ui/Switch";
import type { PromptColumn } from "./prompt-parts";
import {
  assetStatusLabel,
  assetStatusTone,
  assetStatusTransitions,
  canSubmitAsset,
  type AssetStatusTransition,
} from "./prompt-utils";
import { libraryNumber, libraryCost, libraryPercent } from "./library-model";
interface Props {
  canWrite: boolean;
  toggleUncertain: boolean;
  onSelect: (asset: PromptAsset, trigger: HTMLButtonElement) => void;
  onSubmit: (asset: PromptAsset, trigger: HTMLButtonElement) => void;
  onDecision: (asset: PromptAsset, transition: AssetStatusTransition, trigger: HTMLButtonElement) => void;
  onEdit: (asset: PromptAsset, trigger: HTMLButtonElement) => void;
  onDelete: (asset: PromptAsset, trigger: HTMLButtonElement) => void;
  onToggle: (asset: PromptAsset, enabled: boolean) => void;
}
const writeHint = "편집 권한이 없거나 다른 작업을 처리하고 있습니다.";
export function useAssetColumns({
  canWrite,
  toggleUncertain,
  onSelect,
  onSubmit,
  onDecision,
  onEdit,
  onDelete,
  onToggle,
}: Props): ReadonlyArray<PromptColumn<PromptAsset>> {
  return [
    {
      id: "name",
      sortValue: (row) => row.name,
      header: "이름",
      cell: (asset) => (
        <Button
          size="small"
          variant="ghost"
          onClick={(event) => {
            onSelect(asset, event.currentTarget);
          }}
        >
          {asset.name || asset.id}
        </Button>
      ),
    },
    {
      id: "status",
      sortValue: (row) => row.status,
      header: "상태",
      cell: (asset) => <Badge tone={assetStatusTone(asset.status)}>{assetStatusLabel(asset.status)}</Badge>,
    },
    {
      id: "category",
      sortValue: (row) => row.category,
      header: "분류",
      cell: (asset) => asset.category || "—",
    },
    {
      id: "tags",
      header: "태그",
      cell: (asset) => (
        <span className="prompt-tag-list">
          {(asset.tags ?? []).length === 0
            ? "—"
            : (asset.tags ?? []).map((tag) => <Badge key={tag}>{tag}</Badge>)}
        </span>
      ),
    },
    {
      id: "use_count",
      sortValue: (row) => row.use_count,
      header: "재사용",
      cell: (asset) => <span className="cell-number">{libraryNumber(asset.use_count)}</span>,
    },
    {
      id: "call_count",
      sortValue: (row) => row.call_count,
      header: "호출수",
      cell: (asset) => <span className="cell-number">{libraryNumber(asset.call_count)}</span>,
    },
    {
      id: "success_rate",
      sortValue: (row) => row.success_rate,
      header: "성공률",
      cell: (asset) => <span className="cell-number">{libraryPercent(asset.success_rate)}</span>,
    },
    {
      id: "avg_cost",
      sortValue: (row) => row.avg_cost_krw,
      header: "평균 비용",
      cell: (asset) => <span className="cell-number">{libraryCost(asset.avg_cost_krw)}</span>,
    },
    {
      id: "approved_by",
      sortValue: (row) => row.approved_by,
      header: "승인자",
      cell: (asset) => asset.approved_by || "—",
    },
    {
      id: "enabled",
      header: "사용",
      cell: (asset) => (
        <Switch
          checked={asset.enabled === true}
          disabled={!canWrite || toggleUncertain || typeof asset.enabled !== "boolean"}
          title={canWrite ? undefined : writeHint}
          label="사용"
          aria-label={`${asset.name || asset.id} 사용`}
          onCheckedChange={(checked) => onToggle(asset, checked)}
        />
      ),
    },
    {
      id: "actions",
      header: "동작",
      cell: (asset) => (
        <span className="prompt-filter-actions">
          {canSubmitAsset(asset.status) ? (
            <Button
              size="small"
              disabled={!canWrite}
              title={canWrite ? undefined : writeHint}
              aria-label={`${asset.name || asset.id} 검토 제출`}
              onClick={(event) => {
                onSubmit(asset, event.currentTarget);
              }}
            >
              <Send aria-hidden="true" /> 검토 제출
            </Button>
          ) : null}
          {assetStatusTransitions(asset.status).map((transition) => (
            <Button
              key={transition.status}
              size="small"
              variant={transition.tone === "danger" ? "danger" : "secondary"}
              disabled={!canWrite}
              title={canWrite ? undefined : writeHint}
              aria-label={`${asset.name || asset.id} ${transition.label}`}
              onClick={(event) => {
                onDecision(asset, transition, event.currentTarget);
              }}
            >
              {transition.label}
            </Button>
          ))}
          <Button
            size="small"
            disabled={!canWrite}
            title={canWrite ? undefined : writeHint}
            aria-label={`${asset.name || asset.id} 편집`}
            onClick={(event) => {
              onEdit(asset, event.currentTarget);
            }}
          >
            편집
          </Button>
          <Button
            size="small"
            variant="danger"
            disabled={!canWrite}
            title={canWrite ? undefined : writeHint}
            aria-label={`${asset.name || asset.id} 삭제`}
            onClick={(event) => {
              onDelete(asset, event.currentTarget);
            }}
          >
            <Trash2 aria-hidden="true" /> 삭제
          </Button>
        </span>
      ),
    },
  ];
}
