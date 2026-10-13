import { createContext, useContext } from "react";
import { featureOwnedKey, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";

export const ModelReadContext = createContext<FeatureReadOwner | undefined>(undefined);
export const modelOwnedKey = featureOwnedKey;
export function useModelReadOwner(): FeatureReadOwner {
  const owner = useContext(ModelReadContext);
  if (!owner) throw new Error("모델 조회 경계가 필요합니다.");
  return owner;
}
