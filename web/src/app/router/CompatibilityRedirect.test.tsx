import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from "react-router";
import { describe, expect, it } from "vitest";

import { CompatibilityRedirect } from "@/app/router/CompatibilityRedirect";
import { sensitiveQueryRejectionStateKey } from "@/shared/security/app-route-query";

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <output data-navigation-type={navigationType} data-state={JSON.stringify(location.state)}>
      {location.pathname}
      {location.search}
      {location.hash}
    </output>
  );
}

describe("CompatibilityRedirect", () => {
  it.each([
    ["providers", "/gateway/providers"],
    ["models", "/gateway/models"],
  ] as const)(
    "replaces /app/%s while preserving only its allowed query and safe hash",
    async (source, target) => {
      render(
        <MemoryRouter initialEntries={[`/${source}?team=platform&status=enabled#details`]}>
          <Routes>
            <Route path={source} element={<CompatibilityRedirect to={target} />} />
            <Route path={target} element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>,
      );

      const location = await screen.findByRole("status");
      expect(location).toHaveTextContent(`${target}?status=enabled#details`);
      expect(location).toHaveAttribute("data-navigation-type", "REPLACE");
    },
  );

  it("does not forward credential query parameters or credential-like hashes", async () => {
    render(
      <MemoryRouter initialEntries={["/models?q=gpt&api_key=private#token=private"]}>
        <Routes>
          <Route path="models" element={<CompatibilityRedirect to="/gateway/models" />} />
          <Route path="gateway/models" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("status")).toHaveTextContent("/gateway/models?q=gpt");
    expect(screen.getByRole("status")).not.toHaveTextContent("private");
  });

  it("preserves only the safe rejection marker across a compatibility redirect", async () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/providers",
            state: {
              [sensitiveQueryRejectionStateKey]: ["q"],
              token: "state-private",
            },
          },
        ]}
      >
        <Routes>
          <Route path="providers" element={<CompatibilityRedirect to="/gateway/providers" />} />
          <Route path="gateway/providers" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    const location = await screen.findByRole("status");
    expect(location).toHaveAttribute("data-state", JSON.stringify({ appSensitiveQueryKeys: ["q"] }));
    expect(location.outerHTML).not.toContain("state-private");
  });
});
