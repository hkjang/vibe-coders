import { describe, expect, it } from "vitest";

import {
  buildProviderRows,
  displayProviderBaseURL,
  filterProviderRows,
  invalidProviderURLDisplay,
  providerSearchContainsSensitiveValue,
  providerPageNumber,
} from "@/features/gateway/providers/provider-catalog";
import type { Provider, ProviderSLO, ProviderSLOEvaluation, RoutingHealth } from "@/shared/api/schemas";

const providerRef = (seed: string): string =>
  `prv_${[...seed]
    .map((character) => character.charCodeAt(0).toString(36))
    .join("")
    .padEnd(43, "x")
    .slice(0, 43)}`;

const provider = (name: string, enabled = true): Provider => ({
  name,
  provider_ref: providerRef(name),
  base_url: `https://${name}.example/v1`,
  api_key_configured: true,
  timeout_ms: 15_000,
  enabled,
  model_patterns: `${name}-*`,
  failover_group: "primary",
  priority: 100,
  created_at: "2026-09-01T00:00:00Z",
});

const evaluation = (providerName: string, breached: boolean): ProviderSLOEvaluation => ({
  provider: providerName,
  provider_ref: providerRef(providerName),
  requests: 10,
  enabled: true,
  breached,
  metrics: {
    availability: { target: 0.99, actual: breached ? 0.9 : 1, breached, enforced: true },
    p95_latency_ms: { target: 500, actual: 400, breached: false, enforced: true },
    error_rate: { target: 0.01, actual: 0, breached: false, enforced: true },
    fallback_rate: { target: 0.01, actual: 0, breached: false, enforced: true },
  },
});

const slo = (providerName: string): ProviderSLO => ({
  provider: providerName,
  provider_ref: providerRef(providerName),
  availability_target: 0.99,
  p95_latency_target_ms: 500,
  error_rate_target: 0.01,
  fallback_rate_target: 0.01,
  enabled: true,
  note: "production",
  updated_at: "2026-09-01T00:00:00Z",
});

function routingHealth(providerName: string): RoutingHealth {
  const score = {
    provider: providerName,
    provider_ref: providerRef(providerName),
    score: 20,
    requests: 10,
    average_latency_ms: 400,
    p95_latency_ms: 600,
    timeouts: 1,
    rate_429: 0,
    rate_5xx: 1,
    fallbacks: 1,
    fallback_rate: 0.1,
  };
  return {
    since: "2026-09-01T00:00:00Z",
    until: "2026-09-02T00:00:00Z",
    threshold: 70,
    providers: [score],
    ranking: [],
    degraded: [score],
    alerts: [],
    trend: [],
    breakers: {
      enabled: true,
      threshold: 3,
      cooldown_seconds: 30,
      states: [],
      shared: true,
      instance_id: "gateway-1",
    },
  };
}

describe("provider catalog", () => {
  it.each(["corp+_", "+svc_"])("scans raw query pairs before form decoding for %s", (prefix) => {
    const secret = `${prefix}${"B".repeat(32)}`;
    const url = `https://provider.example/v1?region=korea&value=${secret}&value=${encodeURIComponent(secret)}&${secret}=public&value=ordinary+words`;
    expect(displayProviderBaseURL(url, [prefix])).toBe(
      "https://provider.example/v1?region=korea&value=***&value=***&value=ordinary+words",
    );
  });

  it("does not serialize a configured credential split across query pairs", () => {
    const secret = `corp&_${"B".repeat(32)}`;
    expect(displayProviderBaseURL(`https://provider.example/v1?value=${secret}`, ["corp&_"])).toBe(
      invalidProviderURLDisplay,
    );
  });

  it("keeps paging normalization unchanged", () => {
    expect([null, "", "0", "-1", "2.5", "text", "2"].map(providerPageNumber)).toEqual([1, 1, 1, 1, 1, 1, 2]);
  });

  it.each(["corp_", "%41_"])(
    "uses %s prefixes for safe identity and filtered display without changing editable metadata",
    (prefix) => {
      const credential = `${prefix}${"B".repeat(32)}`;
      const original = {
        ...provider("safe"),
        base_url: `https://provider.example/v1?value=${encodeURIComponent(credential)}`,
        model_patterns: credential,
        failover_group: credential,
      };
      const rows = buildProviderRows(
        [original, { ...original, provider_ref: providerRef("private"), name: credential }],
        [],
        [],
        undefined,
        false,
        [prefix],
      );
      expect(rows[1]?.nameRedacted).toBe(true);
      expect(rows[1]?.displayName).not.toContain(credential);
      expect(rows[0]?.provider).toEqual(original);
      expect(filterProviderRows(rows, "BBBB", "all", [prefix])).toEqual([]);
      expect(providerSearchContainsSensitiveValue(credential, [prefix])).toBe(true);
    },
  );
  it("redacts encoded percent-prefix URL values without decoding the configured prefix away", () => {
    const credential = `%41_${"B".repeat(32)}`;
    const url = `https://provider.example/v1?value=${encodeURIComponent(credential)}&region=korea`;
    expect(displayProviderBaseURL(url, ["%41_"])).toBe("https://provider.example/v1?value=***&region=korea");
  });

  it.each([
    ["uppercase", "CORP_", "CORP_"],
    ["encoded uppercase", "CORP_", "%43%4F%52%50%5F"],
    ["unicode", "회사_", "회사_"],
    ["encoded unicode", "회사_", "%ED%9A%8C%EC%82%AC%5F"],
  ])("redacts %s credential hostnames before URL canonicalization", (_name, prefix, encodedPrefix) => {
    const value = `https://${encodedPrefix}${"A".repeat(32)}.example/v1?api-version=2026-01-01`;
    expect(displayProviderBaseURL(value, [prefix])).toBe(invalidProviderURLDisplay);
    expect(displayProviderBaseURL(value, [prefix])).not.toContain(new URL(value).hostname);
  });

  it("retains safe canonical host context while removing userinfo and fragments", () => {
    const value = "https://CORP_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345:private@회사.example/v1?region=korea#hidden";
    const displayed = displayProviderBaseURL(value, ["CORP_", "회사_"]);
    expect(displayed).toBe(`${new URL(value).origin}/v1?region=korea`);
    expect(displayed).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(displayed).not.toContain("private");
    expect(displayed).not.toContain("hidden");
    expect(displayProviderBaseURL("https://CORP_short.example/v1", ["CORP_"])).toBe(
      "https://corp_short.example/v1",
    );
  });

  it.each([
    "corp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "%63%6f%72%70%5fABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "%2563%256f%2572%2570%255fABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
  ])("runtime credential prefixes redact URL components without changing safe context (%s)", (secret) => {
    const prefixes = ["corp_"];
    expect(displayProviderBaseURL(`https://provider.example/v1/${secret}`, prefixes)).toBe(
      invalidProviderURLDisplay,
    );
    const displayed = displayProviderBaseURL(
      `https://provider.example/v1?api-version=2026-01-01&value=${secret}&${secret}=public&region=korea`,
      prefixes,
    );
    expect(displayed).toBe("https://provider.example/v1?api-version=2026-01-01&value=***&region=korea");
    expect(displayed).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
  });

  it("runtime credential prefixes preserve ordinary names and do not alter default-prefix checks", () => {
    expect(displayProviderBaseURL("https://provider.example/corp_short?value=corp_report", ["corp_"])).toBe(
      "https://provider.example/corp_short?value=corp_report",
    );
    expect(
      displayProviderBaseURL("https://provider.example/v1?value=vc_sk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", [
        "corp_",
      ]),
    ).toBe("https://provider.example/v1?value=***");
  });

  it("uses available SLO evidence without treating disabled or unevaluated providers as healthy", () => {
    const rows = buildProviderRows(
      [provider("healthy"), provider("degraded"), provider("unknown"), provider("disabled", false)],
      [],
      [evaluation("healthy", false), evaluation("degraded", true)],
    );

    expect(rows.map(({ health }) => health)).toEqual(["healthy", "degraded", "unknown", "unknown"]);
  });

  it("marks enabled providers as Checking while the selected range is loading", () => {
    const rows = buildProviderRows(
      [provider("enabled"), provider("disabled", false)],
      [],
      [evaluation("enabled", false)],
      undefined,
      true,
    );

    expect(rows.map(({ health }) => health)).toEqual(["checking", "unknown"]);
    expect(filterProviderRows(rows, "", "healthy")).toEqual([]);
    expect(filterProviderRows(rows, "", "degraded")).toEqual([]);
    expect(filterProviderRows(rows, "", "unknown").map((row) => row.provider.name)).toEqual(["disabled"]);
  });

  it("filters normalized text and configuration or health states", () => {
    const rows = buildProviderRows(
      [provider("Alpha"), provider("Beta", false)],
      [],
      [evaluation("Alpha", false)],
    );

    expect(filterProviderRows(rows, "ALPHA", "healthy").map((row) => row.provider.name)).toEqual(["Alpha"]);
    expect(filterProviderRows(rows, "primary", "disabled").map((row) => row.provider.name)).toEqual(["Beta"]);
  });

  it("uses opaque references to distinguish and enrich unsafe legacy provider names", () => {
    const firstName = "sk-ant-first-private-value";
    const secondName = "Bearer second-private-value";
    const reservedName = "[provider-name-omitted]";
    const unsafeProviders = [firstName, secondName, reservedName].map((name) => ({
      ...provider("legacy"),
      name,
      provider_ref: providerRef(name),
      base_url: "https://legacy.example/v1",
      model_patterns: "legacy-*",
    }));
    const unsafeScores = unsafeProviders.map(({ name, provider_ref }) => {
      const score = routingHealth(name).providers[0];
      if (!score) throw new Error("Expected routing score fixture");
      return { ...score, provider: "[provider-name-omitted]", provider_ref };
    });
    const rows = buildProviderRows(
      unsafeProviders,
      unsafeProviders.map(({ name }) => ({
        ...slo(name),
        provider: "[provider-name-omitted]",
      })),
      unsafeProviders.map(({ name }) => ({
        ...evaluation(name, true),
        provider: "[provider-name-omitted]",
      })),
      {
        ...routingHealth(firstName),
        providers: unsafeScores,
        degraded: unsafeScores,
      },
    );

    expect(new Set(rows.map((row) => row.identity)).size).toBe(3);
    expect(rows.every((row) => row.nameRedacted)).toBe(true);
    expect(rows.every((row) => row.displayName.startsWith("공급자 이름 비공개"))).toBe(true);
    expect(rows.every((row) => row.identity.startsWith("prv_"))).toBe(true);
    expect(rows.map((row) => row.health)).toEqual(["degraded", "degraded", "degraded"]);
    expect(rows.every((row) => row.routing && row.slo && row.evaluation)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(firstName);
    expect(JSON.stringify(rows)).not.toContain(secondName);
    expect(filterProviderRows(rows, "first-private", "all")).toEqual([]);
    expect(filterProviderRows(rows, "이름 비공개", "degraded")).toHaveLength(3);

    const rebuilt = buildProviderRows(unsafeProviders);
    expect(rebuilt.map((row) => row.identity)).toEqual(rows.map((row) => row.identity));

    const safeRow = buildProviderRows([provider("safe")], [], [], routingHealth("safe"))[0];
    if (!safeRow) throw new Error("Expected a safe Provider row");
    expect(safeRow).toMatchObject({
      displayName: "safe",
      health: "degraded",
      identity: providerRef("safe"),
      nameRedacted: false,
      routing: { provider: "safe" },
    });
  });

  it("masks credentials and secret-like query values in displayed base URLs", () => {
    const displayed = displayProviderBaseURL(
      "https://operator:password@provider.example/v1?api-version=2026-01-01&secretKey=one&passwordHash=two&authToken=three&credentialId=four&signatureVersion=five&clientSecretValue=seven#token=six",
    );

    for (const secret of ["operator", "password@", "one", "two", "three", "four", "five", "six", "seven"]) {
      expect(displayed).not.toContain(secret);
    }
    expect(displayed).toContain("api-version=2026-01-01");
    expect(displayProviderBaseURL("not a URL secret=private")).toBe(invalidProviderURLDisplay);
  });

  it("searches only the sanitized URL and detects credential-bearing search input", () => {
    const unsafeProvider = {
      ...provider("legacy"),
      base_url: "https://operator:password@provider.example/v1?api-version=2026-01-01&token=private#secret",
    };
    const rows = buildProviderRows([unsafeProvider]);

    expect(filterProviderRows(rows, "private", "all")).toEqual([]);
    expect(filterProviderRows(rows, "provider.example", "all")).toHaveLength(1);
    for (const unsafe of [
      unsafeProvider.base_url,
      "api_key=private",
      "credentialId:private",
      "Bearer private",
      "sk-private12345678",
      "https://provider.example/v1/sk-private12345678",
      "https://provider.example/v1?foo=sk-private12345678",
      "eyJheader.eyJpayload.signature",
    ]) {
      expect(providerSearchContainsSensitiveValue(unsafe)).toBe(true);
    }
    expect(providerSearchContainsSensitiveValue("api-version=2026-01-01")).toBe(false);
    expect(providerSearchContainsSensitiveValue("provider.example")).toBe(false);
  });

  it.each([
    "sk-proj-abcdefgh",
    "%73%6b%2dproj%2dabcdefgh",
    "%2573%256b%252dproj%252dabcdefgh",
    "Bearer%20private-authorization-value",
    "Basic%20dXNlcjpwYXNzd29yZA%3D%3D",
    "https%3A%2F%2Fuser%3Aprivate-password%40nested.example%2Fv1",
    "%252Ftoken%253Dprivate-assignment-value",
  ])("masks a credential-bearing ordinary query value (%s) while keeping safe URL context", (value) => {
    const displayed = displayProviderBaseURL(
      `https://provider.example/v1?api-version=2026-01-01&value=${value}&region=korea`,
    );
    const parsed = new URL(displayed);
    expect(parsed.origin + parsed.pathname).toBe("https://provider.example/v1");
    expect(parsed.searchParams.get("api-version")).toBe("2026-01-01");
    expect(parsed.searchParams.get("region")).toBe("korea");
    expect(parsed.searchParams.get("value")).toBe("***");
    expect(displayed).not.toContain(value);
  });

  it.each([
    "sk-proj-abcdefgh",
    "%73%6b%2dproj%2dabcdefgh",
    "%2573%256b%252dproj%252dabcdefgh",
    "token=private-path-value",
    "%2574oken%253Dprivate-path-value",
    "%252Ftoken%253Dprivate-path-value",
    "Bearer%20private-path-value",
  ])("does not display credentials in decoded path components (%s)", (path) => {
    expect(displayProviderBaseURL(`https://provider.example/v1/${path}?api-version=2026-01-01`)).toBe(
      invalidProviderURLDisplay,
    );
  });

  it("removes credential-bearing query names and masks multiply encoded sensitive names", () => {
    const displayed = displayProviderBaseURL(
      "https://provider.example/v1?sk-proj-abcdefgh=value&%2574oken=private-value&region=korea",
    );
    expect(displayed).not.toContain("abcdefgh");
    expect(displayed).not.toContain("private-value");
    expect(new URL(displayed).searchParams.get("region")).toBe("korea");
  });

  it("preserves ordinary encoded deployment paths and repeated nonsecret parameters", () => {
    const displayed = displayProviderBaseURL(
      "https://provider.example/docs/tokenization/%ED%95%9C%EA%B8%80?api-version=2026-01-01&region=korea&region=japan",
    );
    const parsed = new URL(displayed);
    expect(decodeURIComponent(parsed.pathname)).toBe("/docs/tokenization/한글");
    expect(parsed.searchParams.getAll("region")).toEqual(["korea", "japan"]);
    expect(parsed.searchParams.get("api-version")).toBe("2026-01-01");
  });
});
