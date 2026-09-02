import { QueryClient } from "@tanstack/react-query";

import { isAppError } from "@/shared/api/error";

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        refetchIntervalInBackground: false,
        retry: (failureCount, error) =>
          failureCount < 1 && isAppError(error) && error.retryable && error.status !== 429,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
