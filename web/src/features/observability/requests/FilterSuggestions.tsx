import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";

type SuggestField = "ip" | "language" | "model" | "tag";

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
}: {
  /** Fetched on first focus, so opening the screen costs no extra request. */
  enabled: boolean;
  field: SuggestField;
  id: string;
}): React.JSX.Element {
  const suggestions = useQuery({
    enabled,
    queryKey: ["observability", "suggest", field],
    // Distinct values change slowly; one fetch per screen visit is plenty.
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.suggestions, {
        query: { field },
        routeId: "observability.requests",
        signal,
      }),
  });

  return (
    <datalist id={id}>
      {(suggestions.data?.values ?? []).map((value) => (
        <option key={value} value={value} />
      ))}
    </datalist>
  );
}
