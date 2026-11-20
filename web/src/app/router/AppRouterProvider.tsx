import { useCallback, type ComponentProps } from "react";
import { RouterProvider } from "react-router/dom";
import { SearchLocationContext } from "@/shared/hooks/search-location";
import { getRouteLoadObserver } from "@/shared/telemetry/route-load";
import { RouteLoadContext } from "@/shared/telemetry/route-load-context";

export function AppRouterProvider({ router, ...props }: ComponentProps<typeof RouterProvider>) {
  const readLocation = useCallback(() => {
    const { location, navigation } = router.state;
    return navigation.location ?? location;
  }, [router]);
  return (
    <SearchLocationContext value={readLocation}>
      <RouteLoadContext value={getRouteLoadObserver(router)}>
        <RouterProvider {...props} router={router} />
      </RouteLoadContext>
    </SearchLocationContext>
  );
}
