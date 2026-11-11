import { Save, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { withPathParams } from "@/shared/api/endpoint-factory";
import type { SavedFilter } from "@/shared/api/domains/prompts";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { Select } from "@/shared/components/ui/Select";
import { FormField } from "@/shared/components/form/FormField";
import { Input } from "@/shared/components/ui/Input";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { useLibraryQuery } from "./use-library-query";
import { useLibraryMutation, useLibraryBusy } from "./use-library-mutation";
import { readLibraryFilters } from "./library-api";
import { libraryError, libraryID, libraryRouteId as routeId } from "./library-model";
import { searchUpdatesFrom } from "./search-filters";
import { PanelFailure } from "./prompt-parts";
import { LibraryWriteNotice } from "./LibraryWriteNotice";
const savedFilterView = "prompts";
export function SavedPromptFilters({
  canWrite: canEdit,
  queryString,
}: {
  canWrite: boolean;
  queryString: string;
}) {
  const busy = useLibraryBusy();
  const canWrite = canEdit && !busy;
  const { credentialPrefixes } = useAuth();
  const [, updateSearch] = useSearchState();
  const [savingName, setSavingName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SavedFilter>();
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const savedFilters = useLibraryQuery({
    key: ["prompts", "saved-filters", savedFilterView],
    read: readLibraryFilters,
  });
  const savedRows = savedFilters.data?.filters ?? [];
  const saveFilter = useLibraryMutation({
    prepare: async (value: { name: string; params: string }) => {
      if (!value.name || containsPotentialSecret(value.name, credentialPrefixes)) throw libraryError();
      searchUpdatesFrom(new URLSearchParams(value.params), credentialPrefixes);
    },
    mutate: (value: { name: string; params: string }) =>
      apiClient.request(endpoints.domains.prompts.savedFilters.create, {
        body: { ...value, view: savedFilterView },
        routeId,
        retryUnauthorized: false,
      }),
    validate: (result, value) => {
      if (
        !result.filter ||
        !libraryID(result.filter.id, credentialPrefixes) ||
        result.filter.view !== savedFilterView ||
        result.filter.name !== value.name ||
        result.filter.params !== value.params
      )
        throw libraryError("unknown");
    },
    invalidates: [["prompts", "saved-filters"]],
    successMessage: "현재 필터를 저장했습니다.",
    errorMessage: "필터를 저장하지 못했습니다.",
    onSuccess: () => setSavingName(""),
  });
  const removeFilter = useLibraryMutation({
    prepare: async (expected: SavedFilter) => {
      const current = await readLibraryFilters(credentialPrefixes);
      if (JSON.stringify(current.filters.find((row) => row.id === expected.id)) !== JSON.stringify(expected))
        throw libraryError("changed");
    },
    mutate: (expected: SavedFilter) =>
      apiClient.request(withPathParams(endpoints.domains.prompts.savedFilters.remove, { id: expected.id }), {
        routeId,
        retryUnauthorized: false,
      }),
    validate: (result, expected) => {
      if (result.id !== expected.id || result.status !== "deleted") throw libraryError("unknown");
    },
    invalidates: [["prompts", "saved-filters"]],
    successMessage: "저장된 필터를 삭제했습니다.",
    errorMessage: "저장된 필터를 삭제하지 못했습니다.",
  });
  return (
    <>
      <p className="muted">
        저장한 필터는 관리자들이 함께 사용합니다. 비밀번호나 프롬프트 원문을 검색 조건으로 저장하지 마세요.
      </p>
      <LibraryWriteNotice uncertain={saveFilter.uncertain} />
      <div className="prompt-filter-actions">
        <FormField label="저장된 필터" id="prompt-saved">
          {(control) => (
            <Select
              {...control}
              value=""
              onChange={(event) => {
                const selected = savedRows.find((filter) => filter.id === event.target.value);
                if (!selected?.params) return;
                try {
                  updateSearch({
                    ...searchUpdatesFrom(new URLSearchParams(selected.params), credentialPrefixes),
                    search_page: undefined,
                  });
                } catch {
                  toast.error("이 필터에는 지원하지 않는 조건이 있습니다. 검색 조건을 다시 입력하세요.", {
                    duration: Infinity,
                  });
                }
              }}
            >
              <option value="">불러올 필터를 선택하세요</option>
              {savedRows.map((filter) => (
                <option key={filter.id} value={filter.id}>
                  {filter.name ?? filter.id}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="저장할 이름" id="prompt-save-name">
          {(control) => (
            <Input
              {...control}
              value={savingName}
              onChange={(event) => setSavingName(event.target.value)}
              placeholder="예: 보안 리뷰 프롬프트"
            />
          )}
        </FormField>
        <Button
          disabled={!canWrite || savingName.trim() === "" || saveFilter.isPending || saveFilter.uncertain}
          title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
          onClick={() => saveFilter.mutate({ name: savingName.trim(), params: queryString })}
        >
          <Save aria-hidden="true" /> 현재 필터 저장
        </Button>
      </div>

      {savedRows.length > 0 ? (
        <ul className="prompt-filter-actions" aria-label="저장된 필터 목록">
          {savedRows.map((filter) => (
            <li key={filter.id}>
              <Badge>{filter.name ?? filter.id}</Badge>{" "}
              <Button
                size="small"
                variant="ghost"
                disabled={!canWrite}
                title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
                aria-label={`저장된 필터 ${filter.name ?? filter.id} 삭제`}
                onClick={(event) => {
                  deleteTriggerRef.current = event.currentTarget;
                  setPendingDelete(filter);
                }}
              >
                <Trash2 aria-hidden="true" /> 삭제
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {savedFilters.isError ? (
        <PanelFailure
          error={savedFilters.error}
          hasData={Boolean(savedFilters.data)}
          label="저장된 필터"
          onRetry={() => void savedFilters.refetch()}
        />
      ) : null}
      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined);
        }}
        returnFocusRef={deleteTriggerRef}
        title="저장된 필터를 삭제할까요?"
        description={`저장된 필터 "${pendingDelete?.name ?? ""}"을(를) 삭제합니다. 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        confirmDisabled={!canWrite || removeFilter.uncertain}
        tone="danger"
        onConfirm={async () => {
          if (pendingDelete) await removeFilter.mutateAsync(pendingDelete);
        }}
      >
        <LibraryWriteNotice uncertain={removeFilter.uncertain} />
      </ConfirmDialog>
    </>
  );
}
