import { libraryNumber } from "./library-model";
import { useLibraryQuery } from "./use-library-query";
import { readLibraryAssets } from "./library-api";
import { Plus } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  assetFormSchema,
  emptyAssetForm,
  assetFormValues,
  assetStatuses,
  type AssetFormValues,
} from "./asset-form";
import { useAssetActions } from "./use-asset-actions";
import { useAssetColumns } from "./asset-columns";
import { AssetFormFields } from "./AssetFormFields";
import { AssetChangePreview } from "./AssetChangePreview";
import { useAuth } from "@/app/auth/AuthProvider";

import { AssetReviewLoader } from "./AssetReviewLoader";
import { PanelFailure, PromptTable } from "@/features/prompts/library/prompt-parts";
import { assetStatusLabel, type AssetStatusTransition } from "@/features/prompts/library/prompt-utils";
import type { PromptAsset, PromptAssetQuery } from "@/shared/api/domains/prompts";
import { FormField } from "@/shared/components/form/FormField";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { useLibraryBusy } from "./use-library-mutation";
import { LibraryWriteNotice } from "./LibraryWriteNotice";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";

function assetQueryFrom(params: URLSearchParams, prefixes: readonly string[]): PromptAssetQuery {
  const query: PromptAssetQuery = {};
  const keyword = params.get("asset_q")?.trim();
  if (keyword && !containsPotentialSecret(keyword, prefixes)) query.q = keyword;
  const status = params.get("asset_status")?.trim();
  if (status) query.status = status;
  const category = params.get("asset_category")?.trim();
  if (category) query.category = category;
  const tag = params.get("asset_tag")?.trim();
  if (tag) query.tag = tag;
  return query;
}

export function PromptAssetsTab({ canWrite: canEdit }: { canWrite: boolean }): React.JSX.Element {
  const busy = useLibraryBusy();
  const canWrite = canEdit && !busy;
  const { credentialPrefixes } = useAuth();
  const [params, updateSearch] = useSearchState();
  const [editing, setEditing] = useState<PromptAsset | undefined>();
  const [formOpen, setFormOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PromptAsset | undefined>();
  const [pendingSubmit, setPendingSubmit] = useState<PromptAsset | undefined>();
  const [pendingDecision, setPendingDecision] = useState<
    { asset: PromptAsset; transition: AssetStatusTransition } | undefined
  >();
  const [searchError, setSearchError] = useState<string | undefined>();
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLButtonElement | null>(null);

  const query = useMemo(() => assetQueryFrom(params, credentialPrefixes), [params, credentialPrefixes]);
  const selectedId = params.get("asset")?.trim() ?? "";

  const assets = useLibraryQuery({
    key: ["prompts", "assets", query],
    read: (prefixes, signal) => readLibraryAssets(query, prefixes, signal),
  });

  const rows = assets.data?.assets ?? [];
  const stats = assets.data?.stats ?? {};
  const categories = assets.data?.categories ?? [];
  const knownTags = assets.data?.known_tags ?? [];

  const form = useZodForm<AssetFormValues, AssetFormValues>(assetFormSchema, { ...emptyAssetForm });

  const { createAsset, updateAsset, toggleAsset, submitAsset, decideAsset, removeAsset } =
    useAssetActions(editing);

  const openCreate = (): void => {
    setEditing(undefined);
    form.reset({ ...emptyAssetForm });
    setFormOpen(true);
  };

  const openEdit = (asset: PromptAsset): void => {
    setEditing(asset);
    form.reset(assetFormValues(asset));
    setFormOpen(true);
  };

  const columns = useAssetColumns({
    canWrite,
    toggleUncertain: toggleAsset.uncertain,
    onSelect: (asset, trigger) => {
      rowTriggerRef.current = trigger;
      updateSearch({ asset: asset.id });
    },
    onSubmit: (asset, trigger) => {
      rowTriggerRef.current = trigger;
      setPendingSubmit(asset);
    },
    onDecision: (asset, transition, trigger) => {
      rowTriggerRef.current = trigger;
      setPendingDecision({ asset, transition });
    },
    onEdit: (asset, trigger) => {
      rowTriggerRef.current = trigger;
      openEdit(asset);
    },
    onDelete: (asset, trigger) => {
      rowTriggerRef.current = trigger;
      setPendingDelete(asset);
    },
    onToggle: (asset, enabled) => toggleAsset.mutate({ asset, enabled }),
  });

  return (
    <div className="page-stack">
      <StatGrid label="프롬프트 자산 요약">
        <StatCard label="검색 결과" value={libraryNumber(assets.data ? rows.length : undefined)} />
        <StatCard
          label="조직 표준"
          value={libraryNumber(assets.data ? (stats.standard ?? 0) : undefined)}
          tone="success"
        />
        <StatCard
          label="승인됨"
          value={libraryNumber(assets.data ? (stats.approved ?? 0) : undefined)}
          tone="info"
        />
        <StatCard
          label="검토 대기"
          value={libraryNumber(assets.data ? (stats.pending ?? 0) : undefined)}
          tone="warning"
        />
        <StatCard label="초안" value={libraryNumber(assets.data ? (stats.draft ?? 0) : undefined)} />
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
            if (containsPotentialSecret(keyword, credentialPrefixes)) {
              setSearchError(secretSearchMessage);
              return;
            }
            setSearchError(undefined);
            updateSearch({ asset_q: keyword || undefined, assets_page: undefined });
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
                onChange={(event) =>
                  updateSearch({ asset_status: event.target.value || undefined, assets_page: undefined })
                }
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
                onChange={(event) =>
                  updateSearch({ asset_category: event.target.value || undefined, assets_page: undefined })
                }
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
                onChange={(event) =>
                  updateSearch({ asset_tag: event.target.value || undefined, assets_page: undefined })
                }
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
                  assets_page: undefined,
                })
              }
            >
              필터 초기화
            </Button>
          </div>
        </form>

        <LibraryWriteNotice uncertain={toggleAsset.uncertain} />
        <p className="muted">상태별 요약은 전체 자산 기준입니다. 검색 결과의 표시는 현재 필터를 따릅니다.</p>
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
            title={
              Object.keys(query).length ? "조건에 맞는 자산이 없습니다." : "등록된 프롬프트 자산이 없습니다."
            }
            description="자주 쓰는 프롬프트를 자산으로 등록하면 팀이 같은 품질로 재사용할 수 있습니다."
            actions={
              <Button variant="primary" disabled={!canWrite} onClick={openCreate}>
                <Plus aria-hidden="true" /> 새 자산
              </Button>
            }
          />
        ) : (
          <PromptTable
            tableId="assets"
            caption="프롬프트 자산 목록"
            columns={columns}
            rows={rows}
            loading={assets.isPending}
            error={assets.isError && !assets.data ? "자산 목록을 불러오지 못했습니다." : undefined}
            onRetry={() => void assets.refetch()}
          />
        )}
      </SectionCard>

      {selectedId ? (
        <AssetReviewLoader
          key={selectedId}
          id={selectedId}
          canWrite={canWrite}
          returnFocusRef={rowTriggerRef}
          onOpenChange={(open) => {
            if (!open) updateSearch({ asset: undefined });
          }}
        />
      ) : null}

      <FormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        returnFocusRef={editing ? rowTriggerRef : createTriggerRef}
        form={form}
        title={editing ? "프롬프트 자산 편집" : "새 프롬프트 자산"}
        description="이름과 본문은 필수입니다. 본문은 서버에만 저장되며 주소에는 남지 않습니다."
        submitLabel="저장"
        submitDisabled={
          !canWrite || (editing ? updateAsset.uncertain || !form.formState.isDirty : createAsset.uncertain)
        }
        scrollBody
        scrollHint="입력 영역은 키보드로 스크롤할 수 있습니다. 저장은 아래 버튼에서 진행하세요."
        onSubmit={async (values) => {
          await (editing ? updateAsset : createAsset).mutateAsync(values);
        }}
      >
        <LibraryWriteNotice uncertain={editing ? updateAsset.uncertain : createAsset.uncertain} />
        <AssetFormFields form={form} editing={editing !== undefined} categories={categories} />
        <AssetChangePreview form={form} asset={editing} />
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
        confirmDisabled={!canWrite || removeAsset.uncertain}
        tone="danger"
        onConfirm={async () => {
          if (pendingDelete) await removeAsset.mutateAsync(pendingDelete);
        }}
      >
        <LibraryWriteNotice uncertain={removeAsset.uncertain} />
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingSubmit !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingSubmit(undefined);
        }}
        returnFocusRef={rowTriggerRef}
        title="검토를 제출할까요?"
        description={`"${pendingSubmit?.name ?? pendingSubmit?.id ?? ""}" 자산을 검토 대기 상태로 보내고 검토자에게 알립니다.`}
        confirmLabel="검토 제출"
        confirmDisabled={!canWrite || submitAsset.uncertain}
        onConfirm={async () => {
          if (pendingSubmit) await submitAsset.mutateAsync(pendingSubmit);
        }}
      >
        <LibraryWriteNotice uncertain={submitAsset.uncertain} />
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingDecision !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDecision(undefined);
        }}
        returnFocusRef={rowTriggerRef}
        title={`이 자산을 ${pendingDecision?.transition.label ?? ""} 처리할까요?`}
        description={`"${pendingDecision?.asset.name ?? pendingDecision?.asset.id ?? ""}" 자산의 상태가 바뀌며 변경 이력에 사유가 함께 남습니다.`}
        confirmLabel={pendingDecision?.transition.label ?? "확인"}
        confirmDisabled={!canWrite || decideAsset.uncertain}
        tone={pendingDecision?.transition.tone ?? "primary"}
        requireReason
        onConfirm={async (reason) => {
          if (pendingDecision) {
            await decideAsset.mutateAsync({
              asset: pendingDecision.asset,
              status: pendingDecision.transition.status,
              note: reason,
            });
          }
        }}
      >
        <LibraryWriteNotice uncertain={decideAsset.uncertain} />
      </ConfirmDialog>
    </div>
  );
}
