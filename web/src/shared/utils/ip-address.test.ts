import { describe, expect, it } from "vitest";

import { isValidIPAddress } from "@/shared/utils/ip-address";

describe("isValidIPAddress", () => {
  it.each(["192.0.2.10", "2001:db8::1", "::ffff:192.0.2.10", "unknown"])("accepts %s", (value) =>
    expect(isValidIPAddress(value)).toBe(true),
  );

  it.each(["", "192.0.2.999", "192.168.001.1", "2001:db8::gg", "fe80::1%eth0", "not-an-ip"])(
    "rejects %s",
    (value) => expect(isValidIPAddress(value)).toBe(false),
  );
});
