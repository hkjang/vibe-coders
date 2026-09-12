import { describe, expect, it } from "vitest";

import { setupSteps } from "@/features/overview/setup-steps";
import type { AdminStats, OpsStatus } from "@/shared/api/schemas";

const emptyStats = { total_requests: 0 } as AdminStats;

function status(overrides: { auth?: boolean; pricing?: boolean; providers?: number }): OpsStatus {
  return {
    providers: Array.from({ length: overrides.providers ?? 0 }, () => ({ provider: "openai" })),
    security: {
      auth_enabled: overrides.auth ?? false,
      pricing_configured: overrides.pricing ?? false,
      dev_secret: false,
      raw_prompts_logged: false,
      raw_bodies_logged: false,
    },
  } as unknown as OpsStatus;
}

describe("setupSteps", () => {
  it("reads every step from what the gateway reports, not from stored progress", () => {
    const steps = setupSteps(emptyStats, status({ auth: true, providers: 2 }));
    expect(steps.map((step) => [step.id, step.done])).toEqual([
      ["providers", true],
      ["auth", true],
      ["pricing", false],
      ["traffic", false],
    ]);
  });

  it("treats a gateway with no reported status as nothing set up yet", () => {
    expect(setupSteps(emptyStats, undefined).every((step) => !step.done)).toBe(true);
  });

  it("marks the traffic step done as soon as one request has been served", () => {
    const steps = setupSteps({ total_requests: 1 } as AdminStats, status({}));
    expect(steps.find((step) => step.id === "traffic")?.done).toBe(true);
  });

  it("points each unfinished step at the screen that finishes it", () => {
    const steps = setupSteps(emptyStats, status({}));
    expect(steps.map((step) => step.to)).toEqual([
      "/gateway/providers",
      "/system/settings",
      "/gateway/models",
      "/gateway/chat",
    ]);
  });
});
