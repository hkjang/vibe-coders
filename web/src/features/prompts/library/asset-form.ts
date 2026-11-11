import { z } from "zod";
import type { PromptAsset, PromptAssetUpdateBody } from "@/shared/api/domains/prompts";
import { hiddenLibraryText, libraryError } from "./library-model";

export const assetStatuses = ["draft", "pending", "approved", "standard"] as const;
export const emptyAssetForm: AssetFormValues = {
  id: "",
  name: "",
  category: "custom",
  tags: "",
  description: "",
  body: "",
  status: "draft",
  note: "",
};
export const assetFormSchema = z.object({
  id: z.string().trim().max(120),
  name: z.string().trim().min(1, "이름을 입력하세요."),
  category: z.string().trim().min(1),
  tags: z.string().trim().max(400),
  description: z.string().trim().max(2000),
  body: z.string().trim().min(1, "프롬프트 본문을 입력하세요."),
  status: z.enum(assetStatuses),
  note: z.string().trim().max(500),
});
export type AssetFormValues = z.infer<typeof assetFormSchema>;
export const tagsFromInput = (value: string) =>
  value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
export function assetFormValues(asset: PromptAsset): AssetFormValues {
  return {
    id: asset.id,
    name: asset.name ?? "",
    category: asset.category ?? "custom",
    tags: (asset.tags ?? []).join(", "),
    description: asset.description ?? "",
    body: asset.body ?? "",
    status: assetStatuses.includes(asset.status as AssetFormValues["status"])
      ? (asset.status as AssetFormValues["status"])
      : "draft",
    note: asset.note ?? "",
  };
}
// Matches the existing server slug, including consecutive '_'/'-' characters.
export function assetSlug(value: string): string {
  let result = "",
    dash = false;
  for (const character of value.trim().toLowerCase()) {
    if (/[a-z0-9_-]/u.test(character)) {
      result += character;
      dash = false;
    } else if (!dash && result) {
      result += "-";
      dash = true;
    }
  }
  return result.replace(/^-+|-+$/gu, "");
}
export const newAssetID = (value: AssetFormValues) => assetSlug(value.id) || assetSlug(value.name);
export function assetPatch(value: AssetFormValues, asset: PromptAsset): PromptAssetUpdateBody {
  const previous = assetFormValues(asset);
  const changes: { -readonly [Key in keyof PromptAssetUpdateBody]: PromptAssetUpdateBody[Key] } = {};
  for (const key of ["name", "category", "description", "body", "note"] as const) {
    if (value[key] === previous[key]) continue;
    if (value[key].includes(hiddenLibraryText)) throw libraryError();
    changes[key] = value[key];
  }
  const tags = tagsFromInput(value.tags);
  if (JSON.stringify(tags) !== JSON.stringify(asset.tags ?? [])) {
    if (tags.includes(hiddenLibraryText)) throw libraryError();
    changes.tags = tags;
  }
  return changes;
}
export function assetRevision(asset: PromptAsset) {
  return JSON.stringify([
    asset.id,
    asset.name,
    asset.category,
    asset.description,
    asset.body,
    asset.tags,
    asset.enabled,
    asset.status,
    asset.updated_at,
    asset.approved_by,
    asset.approved_at,
    asset.note,
  ]);
}
