import { describe, expect, it, vi } from "vitest";

import { waitForAccessRejection, type AccessExpiryProbe } from "../../tests/auth-live/expiry-sync";

const valid = (status: number, expiredAtServer: boolean): AccessExpiryProbe => ({
  status,
  expiredAtServer,
  validClaims: true,
  validServerDate: true,
});
function scenario(results: AccessExpiryProbe[]) {
  let elapsed = 0;
  const probe = vi.fn(async () => results.shift() ?? valid(200, false));
  const sleep = vi.fn(async (milliseconds: number) => {
    elapsed += milliseconds;
  });
  return {
    probe,
    sleep,
    now: () => elapsed,
    advance: (milliseconds: number) => {
      elapsed += milliseconds;
    },
  };
}

describe("actual Go access expiry synchronization", () => {
  it("waits for real server rejection and expiry, not a fixed timer", async () => {
    const run = scenario([valid(200, false), valid(200, false), valid(401, true)]);
    await expect(waitForAccessRejection(run.probe, { ttlSeconds: 8, ...run })).resolves.toBeUndefined();
    expect(run.probe).toHaveBeenCalledTimes(3);
    expect(run.sleep).toHaveBeenCalledTimes(2);
  });
  it("does not treat an early revoked-session 401 as wall-clock expiry", async () => {
    const run = scenario([valid(401, false), valid(401, true)]);
    await waitForAccessRejection(run.probe, { ttlSeconds: 8, ...run });
    expect(run.probe).toHaveBeenCalledTimes(2);
  });
  it("requires the next request to reject after a response crosses the expiry boundary", async () => {
    const run = scenario([valid(200, true), valid(401, true)]);
    await waitForAccessRejection(run.probe, { ttlSeconds: 8, ...run });
    expect(run.probe).toHaveBeenCalledTimes(2);
    expect(run.sleep).not.toHaveBeenCalled();
  });
  it("never polls past a second accepted request after observed expiry", async () => {
    const run = scenario([valid(200, true), valid(200, true), valid(401, true)]);
    await expect(waitForAccessRejection(run.probe, { ttlSeconds: 8, ...run })).rejects.toThrow(
      "after observed server expiry",
    );
    expect(run.probe).toHaveBeenCalledTimes(2);
  });
  it.each([403, 429, 500])("fails immediately on unexpected status %i", async (status) => {
    const run = scenario([valid(status, false), valid(401, true)]);
    await expect(waitForAccessRejection(run.probe, { ttlSeconds: 8, ...run })).rejects.toThrow(
      "Unexpected isolated",
    );
    expect(run.probe).toHaveBeenCalledTimes(1);
  });
  it.each(["validClaims", "validServerDate"] as const)("fails immediately on invalid %s", async (field) => {
    const run = scenario([{ ...valid(200, false), [field]: false }, valid(401, true)]);
    await expect(waitForAccessRejection(run.probe, { ttlSeconds: 8, ...run })).rejects.toThrow();
    expect(run.probe).toHaveBeenCalledTimes(1);
  });
  it("bounds all waiting by TTL plus five seconds", async () => {
    const run = scenario([]);
    await expect(waitForAccessRejection(run.probe, { ttlSeconds: 8, ...run })).rejects.toThrow(
      "within its bound",
    );
    expect(run.now()).toBe(13_000);
    expect(run.probe).toHaveBeenCalledTimes(130);
    expect(run.probe).toHaveBeenLastCalledWith(100);
  });
  it("rejects a successful probe that finishes after the deadline", async () => {
    const run = scenario([]);
    const probe = vi.fn(async () => {
      run.advance(13_001);
      return valid(401, true);
    });
    await expect(
      waitForAccessRejection(probe, { ttlSeconds: 8, now: run.now, sleep: run.sleep }),
    ).rejects.toThrow("within its bound");
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it("does not retain probe exception details", async () => {
    const run = scenario([]);
    const probe = vi.fn(async () => {
      throw new Error("SYNTHETIC_PRIVATE_EXPIRY_MARKER");
    });
    await expect(
      waitForAccessRejection(probe, { ttlSeconds: 8, now: run.now, sleep: run.sleep }),
    ).rejects.toThrow(/^Isolated access expiry probe failed\.$/u);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
