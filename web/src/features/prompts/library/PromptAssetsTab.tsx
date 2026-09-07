import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { z } from "zod";

import { PanelFailure, PromptTable, type PromptColumn } from "@/features/prompts/library/prompt-parts";
import { assetStatusLabel, assetStatusTone } from "@/features/prompts/library/prompt-utils";
import { apiClient } from "@/shared/api/client";
import type { PromptAsset, PromptAssetQuery } from "@/shared/api/domains/prompts";
import { pathWithParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { FormField } from "@/shared/components/form/FormField";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Sheet } from "@/shared/components/ui/Sheet";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

const routeId = "prompts.library";
const assetStatuses = ["draft", "pending", "approved", "standard"] as const;

const assetFormSchema = z.object({
  id: z.string().trim().max(120),
  name: z.string().trim().min(1, "이름을 입력하세요."),
  category: z.string().trim().min(1),
  tags: z.string().trim().max(400),
  description: z.string().trim().max(2000),
  body: z.string().trim().min(1, "프롬프트 본문을 입력하세요."),
  status: z.string().trim().min(1),
});
type AssetFormValues = z.infer<typeof assetFormSchema>;

function assetQueryFrom(params: URLSearchParams): PromptAssetQuery {
  const query: PromptAssetQuery = {};
  const keyword = params.get("asset_q")?.trim();
  if (keyword && !containsPotentialSecret(keyword)) query.q = keyword;
  const status = params.get("asset_status")?.trim();
  if (status) query.status = status;
  const category = params.get("asset_category")?.trim();
  if (category) query.category = category;
  const tag = params.get("asset_tag")?.trim();
  if (tag) query.tag = tag;
  return query;
}

export function PromptAssetsTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [params, updateSearch] = useSearchState();
  const [editing, setEditing] = useState<PromptAsset | undefined>();
  const [formOpen, setFormOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PromptAsset | undefined>();
  const [searchError, setSearchError] = useState<string | undefined>();
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLButtonElement | null>(null);

  const query = useMemo(() => assetQueryFrom(params), [params]);
  const selectedId = params.get("asset")?.trim() ?? "";

  const assets = useQuery({
    queryKey: ["prompts", "assets", query],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.prompts.assets.list, { query, signal, routeId }),
  });

  const rows = assets.data?.assets ?? [];
  const stats = assets.data?.stats ?? {};
  const categories = assets.data?.categories ?? [];
  const knownTags = assets.data?.known_tags ?? [];
  const selected = rows.find((asset) => asset.id === selectedId);

  const form = useZodForm<AssetFormValues, AssetFormValues>(assetFormSchema, {
    id: "",
    name: "",
    category: "custom",
    tags: "",
    description: "",
    body: "",
    status: "draft",
  });

  const saveAsset = useMutationFeedback({
    mutate: (values: AssetFormValues) =>
      apiClient.request(endpoints.domains.prompts.assets.save, {
        body: {
          ...(values.id ? { id: values.id } : {}),
          name: values.name,
          category: values.category,
          description: values.description,
          body: values.body,
          tags: values.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
          status: values.status,
        },
        routeId,
      }),
    invalidates: [["prompts", "assets"]],
    successMessage: "프롬프트 자산을 저장했습니다.",
    errorMessage: "프롬프트 자산을 저장하지 못했습니다.",
  });

  const removeAsset = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(
        {
          ...endpoints.domains.prompts.assets.remove,
          path: pathWithParams(endpoints.domains.prompts.assets.remove.path, { id }),
        },
        { routeId },
      ),
    invalidates: [["prompts", "assets"]],
    successMessage: "프롬프트 자산을 삭제했습니다.",
    errorMessage: "프롬프트 자산을 삭제하지 못했습니다.",
  });

  const openCreate = (): void => {
    setEditing(undefined);
    form.reset({
      id: "",
      name: "",
      category: "custom",
      tags: "",
      description: "",
      body: "",
      status: "draft",
    });
    setFormOpen(true);
  };

  const openEdit = (asset: PromptAsset): void => {
    setEditing(asset);
    form.reset({
      id: asset.id,
      name: asset.name ?? "",
      category: asset.category ?? "custom",
      tags: (asset.tags ?? []).join(", "),
      description: asset.description ?? "",
      body: asset.body ?? "",
      status: asset.status ?? "draft",
    });
    setFormOpen(true);
  };

  const columns: ReadonlyArray<PromptColumn<PromptAsset>> = [
    {
      id: "name",
      header: "이름",
      cell: (asset) => (
        <Button
          size="small"
          variant="ghost"
          onClick={(event) => {
            rowTriggerRef.current = event.currentTarget;
            updateSearch({ asset: asset.id });
          }}
        >
          {asset.name || asset.id}
        </Button>
      ),
    },
    {
      id: "status",
      header: "상태",
      cell: (asset) => <Badge tone={assetStatusTone(asset.status)}>{assetStatusLabel(asset.status)}</Badge>,
    },
    { id: "category", header: "분류", cell: (asset) => asset.category || "—" },
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
      header: "재사용",
      cell: (asset) => <span className="cell-number">{formatNumber(asset.use_count)}</span>,
    },
    {
      id: "call_count",
      header: "호출수",
      cell: (asset) => <span className="cell-number">{formatNumber(asset.call_count)}</span>,
    },
    {
      id: "success_rate",
      header: "성공률",
      cell: (asset) => <span className="cell-number">{formatPercent(asset.success_rate)}</span>,
    },
    {
      id: "avg_cost",
      header: "평균 비용",
      cell: (asset) => <span className="cell-number">{formatKRW(asset.avg_cost_krw)}</span>,
    },
    {
      id: "approved_by",
      header: "승인자",
      cell: (asset) => asset.approved_by || "—",
    },
    {
      id: "actions",
      header: "동작",
      cell: (asset) => (
        <span className="prompt-filter-actions">
          <Button
            size="small"
            disabled={!canWrite}
            title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
            aria-label={`${asset.name || asset.id} 편집`}
            onClick={(event) => {
              rowTriggerRef.current = event.currentTarget;
              openEdit(asset);
            }}
          >
            편집
          </Button>
          <Button
            size="small"
            variant="danger"
            disabled={!canWrite}
            title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
            aria-label={`${asset.name || asset.id} 삭제`}
            onClick={(event) => {
              rowTriggerRef.current = event.currentTarget;
              setPendingDelete(asset);
            }}
          >
            <Trash2 aria-hidden="true" /> 삭제
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="page-stack">
      <StatGrid label="프롬프트 자산 요약">
        <StatCard label="전체" value={formatNumber(rows.length)} />
        <StatCard label="조직 표준" value={formatNumber(stats.standard ?? 0)} tone="success" />
        <StatCard label="승인됨" value={formatNumber(stats.approved ?? 0)} tone="info" />
        <StatCard label="검토 대기" value={formatNumber(stats.pending ?? 0)} tone="warning" />
        <StatCard label="초안" value={formatNumber(stats.draft ?? 0)} />
      </StatGrid>

      <SectionCard
        title="자산 관리소"
        description="팀이 공유하는 프롬프트 자산 목록입니다. 본문은 이 화면에서만 표시하며 주소나 브라우저 저장소에 남기지 않습니다."
        actions={
          <Button
            ref={createTriggerRef}
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
            onClick={openCreate}
          >
            <Plus aria-hidden="true" /> 새 자산
          </Button>
        }
      >
        <form
          className="prompt-filter-form"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const keyword = String(new FormData(event.currentTarget).get("asset_q") ?? "").trim();
            if (containsPotentialSecret(keyword)) {
              setSearchError(secretSearchMessage);
              return;
            }
            setSearchError(undefined);
            updateSearch({ asset_q: keyword || undefined });
          }}
        >
          <FormField label="이름·설명 검색" error={searchError} id="asset-q">
            {(control) => (
              <Input
                {...control}
                name="asset_q"
                key={params.get("asset_q") ?? ""}
                defaultValue={params.get("asset_q") ?? ""}
              />
            )}
          </FormField>
          <FormField label="상태" id="asset-status">
            {(control) => (
              <Select
                {...control}
                value={params.get("asset_status") ?? ""}
                onChange={(event) => updateSearch({ asset_status: event.target.value || undefined })}
              >
                <option value="">전체 상태</option>
                {assetStatuses.map((status) => (
                  <option key={status} value={status}>
                    {assetStatusLabel(status)}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="분류" id="asset-category">
            {(control) => (
              <Select
                {...control}
                value={params.get("asset_category") ?? ""}
                onChange={(event) => updateSearch({ asset_category: event.target.value || undefined })}
              >
                <option value="">전체 분류</option>
                {categories.map((category) => (
                  <option key={category.key} value={category.key}>
                    {category.label ?? category.key}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="태그" id="asset-tag">
            {(control) => (
              <Select
                {...control}
                value={params.get("asset_tag") ?? ""}
                onChange={(event) => updateSearch({ asset_tag: event.target.value || undefined })}
              >
                <option value="">전체 태그</option>
                {knownTags.map((tag) => (
                  <option key={tag.key} value={tag.key}>
                    {tag.label ?? tag.key}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <div className="prompt-filter-actions">
            <Button type="submit" variant="primary">
              검색
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                updateSearch({
                  asset_q: undefined,
                  asset_status: undefined,
                  asset_category: undefined,
                  asset_tag: undefined,
                })
              }
            >
              필터 초기화
            </Button>
          </div>
        </form>

        {assets.isError ? (
          <PanelFailure
            error={assets.error}
            hasData={Boolean(assets.data)}
            label="프롬프트 자산"
            onRetry={() => void assets.refetch()}
          />
        ) : null}

        {!assets.isPending && !assets.isError && rows.length === 0 ? (
          <EmptyState
            title="등록된 프롬프트 자산이 없습니다."
            description="자주 쓰는 프롬프트를 자산으로 등록하면 팀이 같은 품질로 재사용할 수 있습니다."
            actions={
              <Button variant="primary" disabled={!canWrite} onClick={openCreate}>
                <Plus aria-hidden="true" /> 새 자산
              </Button>
            }
          />
        ) : (
          <PromptTable
            caption="프롬프트 자산 목록"
            columns={columns}
            rows={rows}
            loading={assets.isPending}
            error={assets.isError && !assets.data ? "자산 목록을 불러오지 못했습니다." : undefined}
            onRetry={() => void assets.refetch()}
          />
        )}
      </SectionCard>

      <InlineNotice tone="warning" title="이 화면에서 제공하지 않는 기능">
        검토 제출·승인·반려, 버전 이력과 롤백, 팀별 사용 현황은 서버 API가 아직 공개 규격(OpenAPI)에 포함되어
        있지 않아 이식하지 못했습니다. 기존 화면(/admin#/prompt-assets)에서 처리하세요.
      </InlineNotice>

      <Sheet
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!open) updateSearch({ asset: undefined });
        }}
        returnFocusRef={rowTriggerRef}
        title={selected?.name ?? "프롬프트 자산"}
        description="자산의 메타데이터와 프롬프트 본문입니다."
      >
        {selected ? (
          <div className="page-stack">
            <KeyValueList
              items={[
                { label: "ID", value: selected.id, mono: true },
                { label: "상태", value: assetStatusLabel(selected.status) },
                { label: "분류", value: selected.category ?? "—" },
                { label: "태그", value: (selected.tags ?? []).join(", ") },
                { label: "설명", value: selected.description ?? "—" },
                { label: "승인자", value: selected.approved_by ?? "—" },
                { label: "승인 시각", value: formatDateTime(selected.approved_at) },
                { label: "최근 사용", value: formatDateTime(selected.last_used_at) },
                { label: "재사용 횟수", value: formatNumber(selected.use_count) },
                { label: "성공률", value: formatPercent(selected.success_rate) },
                { label: "평균 비용", value: formatKRW(selected.avg_cost_krw) },
                { label: "평균 지연", value: `${formatNumber(selected.avg_latency_ms)} ms` },
              ]}
            />
            <h3>프롬프트 본문</h3>
            <p className="prompt-asset-body">{selected.body || "본문이 없습니다."}</p>
          </div>
        ) : null}
      </Sheet>

      <FormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        returnFocusRef={editing ? rowTriggerRef : createTriggerRef}
        form={form}
        title={editing ? "프롬프트 자산 편집" : "새 프롬프트 자산"}
        description="이름과 본문은 필수입니다. 본문은 서버에만 저장되며 주소에는 남지 않습니다."
        submitLabel="저장"
        onSubmit={async (values) => {
          await saveAsset.mutateAsync(values);
        }}
      >
        <FormField label="이름" required error={form.formState.errors.name?.message}>
          {(control) => <Input {...control} {...form.register("name")} />}
        </FormField>
        <FormField
          label="ID (slug)"
          description="비워 두면 이름에서 자동 생성합니다. 기존 ID를 쓰면 해당 자산을 덮어씁니다."
          error={form.formState.errors.id?.message}
        >
          {(control) => <Input {...control} {...form.register("id")} readOnly={editing !== undefined} />}
        </FormField>
        <FormField label="분류" error={form.formState.errors.category?.message}>
          {(control) => (
            <Select {...control} {...form.register("category")}>
              {(categories.length > 0 ? categories : [{ key: "custom", label: "기타" }]).map((category) => (
                <option key={category.key} value={category.key}>
                  {category.label ?? category.key}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="상태" error={form.formState.errors.status?.message}>
          {(control) => (
            <Select {...control} {...form.register("status")}>
              {assetStatuses.map((status) => (
                <option key={status} value={status}>
                  {assetStatusLabel(status)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField
          label="태그"
          description="쉼표로 구분합니다. 예: security, java"
          error={form.formState.errors.tags?.message}
        >
          {(control) => <Input {...control} {...form.register("tags")} />}
        </FormField>
        <FormField label="설명" error={form.formState.errors.description?.message}>
          {(control) => <Textarea {...control} rows={2} {...form.register("description")} />}
        </FormField>
        <FormField label="프롬프트 본문" required error={form.formState.errors.body?.message}>
          {(control) => <Textarea {...control} rows={8} {...form.register("body")} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined);
        }}
        returnFocusRef={rowTriggerRef}
        title="프롬프트 자산을 삭제할까요?"
        description={`"${pendingDelete?.name ?? pendingDelete?.id ?? ""}" 자산을 삭제합니다. 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        tone="danger"
        onConfirm={async () => {
          if (pendingDelete) await removeAsset.mutateAsync(pendingDelete.id);
        }}
      />
    </div>
  );
}
