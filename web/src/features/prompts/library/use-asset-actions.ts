import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { withPathParams } from "@/shared/api/endpoint-factory";
import type { PromptAsset } from "@/shared/api/domains/prompts";
import { tagsFromInput, newAssetID, assetPatch, type AssetFormValues } from "./asset-form";
import { useAssetReview, assertAssetReceipt, assertAssetStatus } from "./use-asset-review";
import { useLibraryMutation } from "./use-library-mutation";
import { libraryError, libraryRouteId as routeId } from "./library-model";
const assetQueryKeys = (id: string) => [
  ["prompts", "assets"],
  ["prompts", "asset-selected", id],
  ["prompts", "asset-history", id],
  ["prompts", "asset-usage", id],
];
export function useAssetActions(editing: PromptAsset | undefined) {
  const review = useAssetReview();
  // Creating upserts by slug (POST); editing an existing asset sends only the
  // changed fields (PATCH), so its review status and counters stay untouched.
  const createAsset = useLibraryMutation({
    prepare: review.create,
    validate: (result, values: AssetFormValues) =>
      assertAssetReceipt(result.template, newAssetID(values), {
        name: values.name,
        body: values.body,
        status: values.status,
      }),
    mutate: (values: AssetFormValues) =>
      apiClient.request(endpoints.domains.prompts.assets.save, {
        body: {
          id: newAssetID(values),
          name: values.name,
          category: values.category,
          description: values.description,
          body: values.body,
          tags: tagsFromInput(values.tags),
          status: values.status,
          note: values.note,
        },
        routeId,
        retryUnauthorized: false,
      }),
    invalidates: (values: AssetFormValues) => assetQueryKeys(newAssetID(values)),
    successMessage: "프롬프트 자산을 저장했습니다.",
    errorMessage: "프롬프트 자산을 저장하지 못했습니다.",
  });

  const updateAsset = useLibraryMutation({
    prepare: async (values: AssetFormValues) => {
      if (!editing || values.id !== editing.id) throw libraryError("changed");
      if (Object.keys(assetPatch(values, editing)).length === 0) throw libraryError();
      await review.current(editing);
    },
    validate: (result, values: AssetFormValues) => {
      if (!editing) throw libraryError();
      assertAssetReceipt(result.template, editing.id, assetPatch(values, editing));
    },
    mutate: (values: AssetFormValues) =>
      apiClient.request(withPathParams(endpoints.domains.prompts.assets.update, { id: values.id }), {
        body: editing ? assetPatch(values, editing) : {},
        routeId,
        retryUnauthorized: false,
      }),
    invalidates: (values: AssetFormValues) => assetQueryKeys(values.id),
    successMessage: "프롬프트 자산을 수정했습니다.",
    errorMessage: "프롬프트 자산을 수정하지 못했습니다.",
  });

  const toggleAsset = useLibraryMutation({
    prepare: async (value: { asset: PromptAsset; enabled: boolean }) => {
      await review.current(value.asset);
    },
    validate: (result, value) =>
      assertAssetReceipt(result.template, value.asset.id, { enabled: value.enabled }),
    mutate: (variables: { asset: PromptAsset; enabled: boolean }) =>
      apiClient.request(withPathParams(endpoints.domains.prompts.assets.update, { id: variables.asset.id }), {
        body: { enabled: variables.enabled },
        routeId,
        retryUnauthorized: false,
      }),
    invalidates: (value) => assetQueryKeys(value.asset.id),
    successMessage: (_result, variables) =>
      variables.enabled ? "자산을 사용 상태로 바꿨습니다." : "자산을 중지했습니다.",
    errorMessage: "자산 사용 여부를 바꾸지 못했습니다.",
  });

  const submitAsset = useLibraryMutation({
    prepare: async (asset: PromptAsset) => {
      await review.current(asset);
    },
    validate: (result, asset) => assertAssetStatus(result, asset.id, "pending"),
    mutate: (asset: PromptAsset) =>
      apiClient.request(withPathParams(endpoints.domains.prompts.assets.submit, { id: asset.id }), {
        routeId,
        retryUnauthorized: false,
      }),
    invalidates: (asset) => assetQueryKeys(asset.id),
    successMessage: "검토를 요청했습니다.",
    errorMessage: "검토를 요청하지 못했습니다.",
  });

  const decideAsset = useLibraryMutation({
    prepare: async (value: { asset: PromptAsset; status: string; note: string }) => {
      await review.current(value.asset);
    },
    validate: (result, value) => assertAssetStatus(result, value.asset.id, value.status),
    mutate: (variables: { asset: PromptAsset; status: string; note: string }) =>
      apiClient.request(
        withPathParams(endpoints.domains.prompts.assets.approve, { id: variables.asset.id }),
        {
          body: { status: variables.status, note: variables.note },
          routeId,
          retryUnauthorized: false,
        },
      ),
    invalidates: (value) => assetQueryKeys(value.asset.id),
    successMessage: "검토 결과를 반영했습니다.",
    errorMessage: "검토 결과를 반영하지 못했습니다.",
  });

  const removeAsset = useLibraryMutation({
    prepare: async (asset: PromptAsset) => {
      await review.current(asset);
    },
    validate: (result, asset) => assertAssetStatus(result, asset.id, "deleted"),
    mutate: (asset: PromptAsset) =>
      apiClient.request(withPathParams(endpoints.domains.prompts.assets.remove, { id: asset.id }), {
        routeId,
        retryUnauthorized: false,
      }),
    invalidates: (asset) => assetQueryKeys(asset.id),
    successMessage: "프롬프트 자산을 삭제했습니다.",
    errorMessage: "프롬프트 자산을 삭제하지 못했습니다.",
  });

  return { createAsset, updateAsset, toggleAsset, submitAsset, decideAsset, removeAsset };
}
