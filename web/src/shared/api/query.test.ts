import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/api/error";
import { buildApiPath, serializeQuery } from "@/shared/api/query";

describe("API query serialization", () => {
  it("encodes reserved and Unicode characters without changing parameter order", () => {
    expect(
      serializeQuery({
        search: "한글 & symbols/=?",
        cursor: "next page",
      }),
    ).toBe("search=%ED%95%9C%EA%B8%80+%26+symbols%2F%3D%3F&cursor=next+page");
  });

  it("uses repeated keys for arrays and preserves zero, false, and empty strings", () => {
    expect(
      serializeQuery({
        provider: ["alpha", "beta"],
        threshold: 0,
        enabled: false,
        search: "",
      }),
    ).toBe("provider=alpha&provider=beta&threshold=0&enabled=false&search=");
  });

  it("omits null, undefined, empty arrays, and optional array values", () => {
    expect(
      serializeQuery({
        missing: undefined,
        nullable: null,
        empty: [] as readonly string[],
        mixed: ["first", undefined, null, "last"],
      }),
    ).toBe("mixed=first&mixed=last");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite number %s as a contract error",
    (value) => {
      expect(() => serializeQuery({ threshold: value })).toThrowError(AppError);
      expect(() => serializeQuery({ threshold: value })).toThrowError(
        expect.objectContaining({ kind: "contract" }),
      );
    },
  );

  it("rejects unsupported runtime values as a contract error", () => {
    const unsafeQuery = { filter: { nested: true } } as unknown as { filter: string };

    expect(() => serializeQuery(unsafeQuery)).toThrowError(expect.objectContaining({ kind: "contract" }));
  });

  it("only appends a question mark when at least one value is present", () => {
    expect(buildApiPath("/admin/stats")).toBe("/admin/stats");
    expect(buildApiPath("/admin/stats", { optional: undefined })).toBe("/admin/stats");
    expect(buildApiPath("/admin/routing/health", { window: "1h" })).toBe("/admin/routing/health?window=1h");
  });
});
