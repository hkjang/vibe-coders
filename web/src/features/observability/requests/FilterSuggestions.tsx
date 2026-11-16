import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, type RefObject } from "react";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Button } from "@/shared/components/ui/Button";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";

type SuggestField = "ip" | "language" | "model" | "tag";
const fieldLabels: Record<SuggestField, string> = {
  ip: "클라이언트 IP",
  language: "언어",
  model: "모델",
  tag: "태그",
};

/**
 * Autocomplete for one request filter, offered as a native `<datalist>`: the operator
 * still types freely, but the values this gateway has actually seen are one keystroke
 * away instead of guessed. The server scopes the list to the caller's teams and masks
 * it for callers without raw-prompt access.
 */
export function FilterSuggestions({
  enabled,
  field,
  id,
  inputRef,
}: {
  /** Fetched on first focus, so opening the screen costs no extra request. */
  enabled: boolean;
  field: SuggestField;
  id: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}): React.JSX.Element {
  const owner = useFeatureReadOwner("observability.requests", `request-suggestions:${field}`);
  const currentOwner = useRef<FeatureReadOwner | undefined>(undefined);
  useLayoutEffect(() => {
    currentOwner.current = owner;
    return () => {
      currentOwner.current = undefined;
    };
  }, [owner]);
  const suggestions = useQuery({
    enabled: enabled && owner.readable && !owner.denied,
    queryKey: featureOwnedKey(["observability", "suggest", field], owner),
    // Distinct values change slowly; one fetch per screen visit is plenty.
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(endpoints.domains.observability.suggestions, {
        query: { field },
        routeId: "observability.requests",
        signal,
      });
      assertFeatureRead(owner, signal);
      return data;
    },
  });
  // Read the query status even before the owner commits, so the first successful
  // response remains subscribed and renders after the layout effect activates it.
  const values = suggestions.isSuccess && enabled && owner.isCurrent() ? suggestions.data.values : [];
  const failed = enabled && owner.readable && (owner.denied || suggestions.isError);

  return (
    <>
      <datalist id={id}>
        {values.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      {failed && (
        <div className="request-suggestion-error" role="status">
          <span>
            {owner.denied
              ? "자동완성 조회가 거부되었습니다. 권한을 확인하세요."
              : "자동완성 목록을 확인할 수 없습니다."}{" "}
            값을 직접 입력하거나 다시 불러오세요.
          </span>
          <Button
            type="button"
            size="small"
            variant="secondary"
            disabled={suggestions.isFetching}
            aria-label={`${fieldLabels[field]} 자동완성 다시 불러오기`}
            onClick={() => {
              if (currentOwner.current !== owner || !owner.readable) return;
              if (owner.denied) owner.restart();
              else if (owner.isCurrent()) void suggestions.refetch();
              else return;
              inputRef?.current?.focus();
            }}
          >
            다시 불러오기
          </Button>
        </div>
      )}
    </>
  );
}
