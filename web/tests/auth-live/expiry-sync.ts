export type AccessExpiryProbe = {
  status: number;
  validClaims: boolean;
  validServerDate: boolean;
  expiredAtServer: boolean;
};

type ExpiryWaitOptions = {
  ttlSeconds: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

/** Test-only synchronization. Never put credentials or clock values in errors. */
export async function waitForAccessRejection(
  probe: (remainingMs: number) => Promise<AccessExpiryProbe>,
  { ttlSeconds, now = () => performance.now(), sleep = delay }: ExpiryWaitOptions,
): Promise<void> {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 15) {
    throw new Error("Invalid isolated authentication TTL.");
  }
  const deadline = now() + (ttlSeconds + 5) * 1_000;
  let requireRejection = false;
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Actual access expiry was not confirmed within its bound.");
    let result: AccessExpiryProbe;
    try {
      result = await probe(Math.max(1, Math.floor(remaining)));
    } catch {
      throw new Error("Isolated access expiry probe failed.");
    }
    if (now() >= deadline) throw new Error("Actual access expiry was not confirmed within its bound.");
    if (!result.validClaims) throw new Error("Isolated access token lifetime is invalid.");
    if (!result.validServerDate) throw new Error("Isolated server clock response is invalid.");
    if (result.status !== 200 && result.status !== 401) {
      throw new Error("Unexpected isolated access expiry status.");
    }
    if (requireRejection && result.status !== 401) {
      throw new Error("A new request accepted access after observed server expiry.");
    }
    if (result.status === 401 && result.expiredAtServer) return;
    if (result.status === 200 && result.expiredAtServer) {
      // Token verification can precede a DB read and response Date generation.
      // Require the NEXT request, started after observed expiry, to reject it.
      requireRejection = true;
      continue;
    }
    // A revoked session can return 401 before token expiry (AUTH-LIVE-005).
    // Still observe real server expiry before exercising the UI refresh path.
    await sleep(Math.min(100, Math.max(0, deadline - now())));
  }
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
