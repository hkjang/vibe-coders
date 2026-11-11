import { createContext, useContext } from "react";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";

export const LibraryOwnerContext = createContext<FeatureReadOwner | undefined>(undefined);
export function useLibraryOwner(): FeatureReadOwner {
  const owner = useContext(LibraryOwnerContext);
  if (!owner) throw new Error("프롬프트 보관함 조회 상태를 확인할 수 없습니다.");
  return owner;
}
