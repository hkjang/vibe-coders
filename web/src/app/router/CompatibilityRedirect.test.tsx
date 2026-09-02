import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from "react-router";
import { describe, expect, it } from "vitest";

import { CompatibilityRedirect } from "@/app/router/CompatibilityRedirect";

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <output data-navigation-type={navigationType}>
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
  ] as const)("replaces /app/%s while preserving its query and hash", async (source, target) => {
    render(
      <MemoryRouter initialEntries={[`/${source}?team=platform&status=enabled#details`]}>
        <Routes>
          <Route path={source} element={<CompatibilityRedirect to={target} />} />
          <Route path={target} element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    const location = await screen.findByRole("status");
    expect(location).toHaveTextContent(`${target}?team=platform&status=enabled#details`);
    expect(location).toHaveAttribute("data-navigation-type", "REPLACE");
  });
});
