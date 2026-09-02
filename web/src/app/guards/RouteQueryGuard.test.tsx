import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { RouteQueryGuard } from "@/app/guards/RouteQueryGuard";
import { rejectedSensitiveQuery } from "@/shared/security/app-route-query";

function Probe({ rendered }: { rendered: () => void }): React.JSX.Element {
  const location = useLocation();
  rendered();
  return (
    <output data-state={JSON.stringify(location.state)}>
      {location.pathname}
      {location.search}
      {rejectedSensitiveQuery(location.state, "q") ? ":rejected" : ""}
    </output>
  );
}

describe("RouteQueryGuard", () => {
  it("sanitizes route queries before rendering its guarded child", async () => {
    const rendered = vi.fn();
    render(
      <MemoryRouter initialEntries={["/gateway/providers?q=Bearer%20private&status=enabled&token=private"]}>
        <Routes>
          <Route element={<RouteQueryGuard />}>
            <Route path="gateway/providers" element={<Probe rendered={rendered} />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("status")).toHaveTextContent("/gateway/providers?status=enabled:rejected");
    expect(rendered).toHaveBeenCalledTimes(1);
  });

  it("does not copy arbitrary or nested user state into the sanitized location", async () => {
    const rendered = vi.fn();
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/gateway/models",
            search: "?provider=openai",
            state: {
              nested: { clientSecret: "state-private" },
              token: "state-private",
              appSensitiveQueryKeys: ["q", "state-private"],
              providerDetailRejected: true,
              providerSearchRejected: true,
            },
          },
        ]}
      >
        <Routes>
          <Route element={<RouteQueryGuard />}>
            <Route path="gateway/models" element={<Probe rendered={rendered} />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const output = await screen.findByRole("status");
    expect(output).toHaveAttribute(
      "data-state",
      JSON.stringify({
        appSensitiveQueryKeys: ["q"],
        providerDetailRejected: true,
        providerSearchRejected: true,
      }),
    );
    expect(output.outerHTML).not.toContain("state-private");
    expect(rendered).toHaveBeenCalledTimes(1);
  });

  it("preserves a boolean Provider rejection marker without retaining raw state", async () => {
    const rendered = vi.fn();
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/gateway/providers",
            state: {
              providerDetailRejected: true,
              requestedProvider: "legacy,unsafe-provider",
              nested: { provider: "legacy,unsafe-provider" },
            },
          },
        ]}
      >
        <Routes>
          <Route element={<RouteQueryGuard />}>
            <Route path="gateway/providers" element={<Probe rendered={rendered} />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const output = await screen.findByRole("status");
    expect(output).toHaveAttribute("data-state", JSON.stringify({ providerDetailRejected: true }));
    expect(output.outerHTML).not.toContain("legacy,unsafe-provider");
    expect(rendered).toHaveBeenCalledTimes(1);
  });

  it("drops an unsafe nested return_to before rendering login", async () => {
    const rendered = vi.fn();
    render(
      <MemoryRouter initialEntries={["/login?return_to=%2Fapp%2Fgateway%2Fmodels%3Ftoken%3Dprivate"]}>
        <Routes>
          <Route element={<RouteQueryGuard />}>
            <Route path="login" element={<Probe rendered={rendered} />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("status")).toHaveTextContent("/login");
    expect(screen.getByRole("status")).not.toHaveTextContent("private");
    expect(rendered).toHaveBeenCalledTimes(1);
  });

  it("drops a double-encoded secret nested inside return_to", async () => {
    const rendered = vi.fn();
    render(
      <MemoryRouter
        initialEntries={["/login?return_to=%2Fapp%2Fgateway%2Fproviders%3Fq%3D%252561pi_key%25253Dprivate"]}
      >
        <Routes>
          <Route element={<RouteQueryGuard />}>
            <Route path="login" element={<Probe rendered={rendered} />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("status")).toHaveTextContent("/login");
    expect(screen.getByRole("status")).not.toHaveTextContent("return_to");
    expect(rendered).toHaveBeenCalledTimes(1);
  });
});
