import { useCallback, type ComponentProps } from "react";
import { RouterProvider } from "react-router/dom";
import { SearchLocationContext } from "@/shared/hooks/search-location";

export function AppRouterProvider({ router, ...props }: ComponentProps<typeof RouterProvider>) {
  const readLocation = useCallback(() => {
    const { location, navigation } = router.state;
    return navigation.location ?? location;
  }, [router]);
  return (
    <SearchLocationContext value={readLocation}>
      <RouterProvider {...props} router={router} />
    </SearchLocationContext>
  );
}
