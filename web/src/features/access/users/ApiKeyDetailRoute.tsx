import { ApiKeyDetailFocusContext } from "./api-key-detail-focus";
import { useContext, useRef } from "react";
import { useSearchParams } from "react-router";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { ApiKeyDetail } from "./ApiKeyDetail";

export function ApiKeyDetailRoute({ owner }: { owner: FeatureReadOwner }) {
  const [params, setParams] = useSearchParams();
  const values = params.getAll("api_key_id");
  const fallbackRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useContext(ApiKeyDetailFocusContext) ?? fallbackRef;
  if (!values.length) return null;
  return (
    <ApiKeyDetail
      key={JSON.stringify(values)}
      values={values}
      owner={owner}
      returnFocusRef={returnFocusRef}
      onClose={() => {
        setParams((current) => {
          const next = new URLSearchParams(current);
          next.delete("api_key_id");
          return next;
        });
      }}
    />
  );
}
