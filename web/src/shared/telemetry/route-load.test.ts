import { createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteLoadObserver, observeRouteLoads } from "@/shared/telemetry/route-load";

let clock = 0;
let visibility: DocumentVisibilityState = "visible";
let navigation: PerformanceEntry[];
const routers: ReturnType<typeof createMemoryRouter>[] = [];

beforeEach(() => {
  clock = 100;
  visibility = "visible";
  navigation = [{ name: "", entryType: "navigation", startTime: 0, duration: 0, toJSON: () => ({}) }];
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(performance, "getEntriesByType").mockImplementation(() => navigation);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
afterEach(() => routers.splice(0).forEach((router) => router.dispose()));

function createRouter(loader?: () => Promise<null>) {
  const router = createMemoryRouter([{ path: "/first" }, { path: "/next", loader }, { path: "/last" }], {
    initialEntries: ["/first"],
  });
  routers.push(router);
  observeRouteLoads(router);
  const observer = getRouteLoadObserver(router);
  if (!observer) throw new Error("Observer missing");
  return { router, observer };
}

describe("route display measurement", () => {
  it("includes initial navigation and consumes the sample once", () => {
    const { observer } = createRouter();
    clock = 345.7;
    const finish = observer.claim({});
    expect(finish?.()).toBe(346);
    expect(finish?.()).toBeUndefined();
    expect(observer.claim({})).toBeUndefined();
  });

  it("includes pending loader time and measures cached navigation from a fresh start", async () => {
    let resolve!: (value: null) => void;
    const pending = new Promise<null>((done) => {
      resolve = done;
    });
    const { router, observer } = createRouter(() => pending);
    const abandoned = observer.claim({});
    clock = 200;
    const transition = router.navigate("/next?private=never-sent");
    expect(router.state.navigation.state).toBe("loading");
    expect(abandoned?.()).toBeUndefined();
    clock = 600;
    resolve(null);
    await transition;
    clock = 650;
    expect(observer.claim({})?.()).toBe(450);
    clock = 700;
    await router.navigate("/last");
    clock = 710;
    expect(observer.claim({})?.()).toBe(10);
  });

  it("drops hidden transitions and does not restart a discarded sample on visibility restoration", async () => {
    const { router, observer } = createRouter();
    const finish = observer.claim({});
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(finish?.()).toBeUndefined();
    expect(observer.claim({})).toBeUndefined();
    visibility = "hidden";
    await router.navigate("/next");
    visibility = "visible";
    expect(observer.claim({})).toBeUndefined();
    await router.navigate("/last");
    expect(observer.claim({})?.()).toBe(0);
  });

  it("does not transfer a pending sample to a different visit or account", () => {
    const { observer } = createRouter();
    const owner = {};
    expect(observer.claim(owner)).toBeTypeOf("function");
    expect(observer.claim({})).toBeUndefined();
    expect(observer.claim(owner)?.()).toBe(100);
  });

  it.each([-1, 120_001, Number.NaN, Number.POSITIVE_INFINITY])("drops invalid elapsed time %s", (elapsed) => {
    const { observer } = createRouter();
    clock = elapsed;
    expect(observer.claim({})?.()).toBeUndefined();
  });

  it("does not invent initial navigation timing and cleans up on disposal", async () => {
    navigation = [];
    const { router, observer } = createRouter();
    expect(observer.claim({})).toBeUndefined();
    await router.navigate("/next");
    const finish = observer.claim({});
    router.dispose();
    expect(finish?.()).toBeUndefined();
    expect(getRouteLoadObserver(router)).toBeUndefined();
    routers.splice(routers.indexOf(router), 1);
  });
});
