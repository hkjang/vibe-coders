import { useAuth } from "@/app/auth/AuthProvider";
import type { PromptAsset, PromptAssetHistoryEntry } from "@/shared/api/domains/prompts";
import { assertFeatureRead } from "@/shared/hooks/use-feature-read-owner";
import { useLibraryOwner } from "./library-context";
import { libraryError, libraryID } from "./library-model";
import { readLibraryAssets, readLibraryHistory } from "./library-api";
import { assetRevision, newAssetID, type AssetFormValues } from "./asset-form";

export function useAssetReview() {
  const owner = useLibraryOwner();
  const { credentialPrefixes } = useAuth();
  const current = async (expected: PromptAsset | undefined) => {
    assertFeatureRead(owner);
    if (!expected || !libraryID(expected.id, credentialPrefixes)) throw libraryError("changed");
    const response = await readLibraryAssets({}, credentialPrefixes);
    assertFeatureRead(owner);
    const latest = response.assets.find((row) => row.id === expected.id);
    if (!latest || assetRevision(latest) !== assetRevision(expected)) throw libraryError("changed");
  };
  return {
    current,
    create: async (value: AssetFormValues) => {
      assertFeatureRead(owner);
      const id = newAssetID(value);
      if (!libraryID(id, credentialPrefixes)) throw libraryError();
      const response = await readLibraryAssets({}, credentialPrefixes);
      assertFeatureRead(owner);
      if (response.assets.some((row) => row.id === id)) throw libraryError("exists");
    },
    rollback: async (expected: PromptAsset | undefined, snapshot: PromptAssetHistoryEntry | undefined) => {
      await current(expected);
      if (!expected || !snapshot?.has_snapshot || !Number.isSafeInteger(snapshot.version_num))
        throw libraryError("changed");
      const response = await readLibraryHistory(expected.id, credentialPrefixes);
      assertFeatureRead(owner);
      const latest = response.history.find((row) => row.id === snapshot.id);
      if (JSON.stringify(latest) !== JSON.stringify(snapshot)) throw libraryError("changed");
    },
  };
}

export function assertAssetReceipt(asset: PromptAsset | undefined, id: string, changes: object = {}) {
  if (
    !asset ||
    asset.id !== id ||
    Object.entries(changes).some(([key, value]) => JSON.stringify(asset[key]) !== JSON.stringify(value))
  )
    throw libraryError("unknown");
}
export function assertAssetStatus(result: { id?: string; status?: string }, id: string, status: string) {
  if (result.id !== id || result.status !== status) throw libraryError("unknown");
}
