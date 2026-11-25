import type { createBrowserRouter } from "react-router";

type Router = ReturnType<typeof createBrowserRouter>;
interface Measurement {
  key: string;
  start: number;
  owner?: object;
}

export interface RouteLoadObserver {
  claim: (owner: object) => (() => number | undefined) | undefined;
  discard: () => void;
}

const observers = new WeakMap<Router, RouteLoadObserver>();

export const getRouteLoadObserver = (router: Router): RouteLoadObserver | undefined => observers.get(router);

/** One ephemeral router key and monotonic time; no pathname, query, or history. */
export function observeRouteLoads(router: Router): void {
  if (observers.has(router)) return;
  let key = router.state.navigation.location?.key ?? router.state.location.key;
  const navigation = performance.getEntriesByType?.("navigation")[0];
  let current: Measurement | undefined =
    navigation && document.visibilityState === "visible" ? { key, start: navigation.startTime } : undefined;
  const observer: RouteLoadObserver = {
    discard: () => {
      current = undefined;
    },
    claim: (owner) => {
      const measured = current;
      if (!measured || (measured.owner && measured.owner !== owner)) return undefined;
      measured.owner = owner;
      return () => {
        if (current !== measured || document.visibilityState !== "visible") return undefined;
        current = undefined;
        const elapsed = Math.round(performance.now() - measured.start);
        return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 120_000 ? elapsed : undefined;
      };
    },
  };
  observers.set(router, observer);
  const unsubscribe = router.subscribe((state) => {
    const nextKey = state.navigation.location?.key ?? state.location.key;
    if (nextKey === key) return;
    key = nextKey;
    current = document.visibilityState === "visible" ? { key, start: performance.now() } : undefined;
  });
  const visibility = () => {
    if (document.visibilityState !== "visible") observer.discard();
  };
  document.addEventListener("visibilitychange", visibility);
  const dispose = router.dispose.bind(router);
  router.dispose = () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", visibility);
    observer.discard();
    observers.delete(router);
    dispose();
  };
}
