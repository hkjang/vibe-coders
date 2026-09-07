import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";

import { RouteQueryGuard } from "@/app/guards/RouteQueryGuard";

interface RenderScreenOptions {
  /** Route pattern the screen is mounted at (without `/app`), e.g. "/access/users/*". */
  path?: string;
  /** Initial location including search, e.g. "/access/users?tab=teams". */
  route?: string;
}

/**
 * Renders a screen with react-query, a memory router and the route query guard,
 * matching how the app shell mounts it. Auth comes from the test's `vi.mock`.
 */
export function renderScreen(
  ui: ReactNode,
  options: RenderScreenOptions = {},
): RenderResult & { client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const path = options.path ?? "/*";
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[options.route ?? "/"]}>
        <Routes>
          <Route element={<RouteQueryGuard />}>
            <Route path={path} element={ui} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client };
}
