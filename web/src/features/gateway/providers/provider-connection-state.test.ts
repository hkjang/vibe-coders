import { describe, expect, it } from "vitest";
import { providerConnectionInput } from "./provider-connection-state";
import { providerFormValues, redactedProviderURL } from "./provider-form";
import { connectionOutcome, connectionProvider } from "./provider-connection-test-harness";
import { providerConnectionSchema } from "@/shared/api/domains/provider-connection.schemas";

describe("연결 검사 입력과 안전 응답", () => {
  it("새 이름과 키는 전송 본문에만 두고 이름을 기존 규칙으로 정리한다", () => {
    expect(
      providerConnectionInput(
        {
          ...providerFormValues(),
          name: " new-name ",
          base_url: " https://public.example/v1 ",
          api_key: " public-key ",
        },
        undefined,
        false,
      ),
    ).toEqual({
      body: {
        name: "new-name",
        base_url: "https://public.example/v1",
        credential_mode: "draft",
        api_key: " public-key ",
      },
    });
  });
  it("새 키는 저장 키와 무인증 동의보다 우선하며 바꾼 주소를 사용한다", () => {
    expect(
      providerConnectionInput(
        {
          ...providerFormValues(connectionProvider),
          base_url: "https://other.example/v1",
          api_key: "public-new-key",
        },
        connectionProvider,
        true,
      ),
    ).toEqual({
      body: {
        provider_ref: connectionProvider.identity,
        base_url: "https://other.example/v1",
        timeout_ms: 30000,
        credential_mode: "draft",
        api_key: "public-new-key",
      },
    });
  });
  it("저장된 키가 있으면 무인증 동의가 있어도 stored로만 검사한다", () => {
    expect(
      providerConnectionInput(providerFormValues(connectionProvider), connectionProvider, true),
    ).toMatchObject({ body: { credential_mode: "stored", provider_ref: connectionProvider.identity } });
  });
  it("새 무인증은 명시적 동의가 필요하다", () => {
    expect(
      providerConnectionInput(
        { ...providerFormValues(), name: "new", base_url: "https://public.example" },
        undefined,
        false,
      ),
    ).toHaveProperty("issue.field", "api_key");
  });
  it("키 없는 기존 공급자는 참조와 none을 보내되 키 삭제를 주장하지 않는다", () => {
    const row = {
      ...connectionProvider,
      provider: { ...connectionProvider.provider, api_key_configured: false },
    };
    expect(providerConnectionInput(providerFormValues(row), row, true)).toMatchObject({
      body: { credential_mode: "none", provider_ref: row.identity },
    });
  });
  it.each(["", "   ", "two names", "a,b"])("새 이름 %j 거부", (name) => {
    expect(
      providerConnectionInput(
        { ...providerFormValues(), name, base_url: "https://public.example" },
        undefined,
        true,
      ),
    ).toHaveProperty("issue.field", "name");
  });
  it("기존 이름의 생성 제한을 새로 강제하거나 원 이름을 전송하지 않는다", () => {
    const row = { ...connectionProvider, provider: { ...connectionProvider.provider, name: "legacy name" } };
    const result = providerConnectionInput(providerFormValues(row), row, false);
    expect(result).toHaveProperty("body.provider_ref", row.identity);
    expect(result).not.toHaveProperty("body.name");
  });
  it.each([redactedProviderURL, "file:///private", ""])("검사할 수 없는 URL %j 차단", (base_url) => {
    expect(
      providerConnectionInput(
        { ...providerFormValues(connectionProvider), base_url },
        connectionProvider,
        false,
      ),
    ).toHaveProperty("issue.field", "base_url");
  });
  it.each([
    "https://other.example/v1",
    "https://public.example/v1/",
    "https://public.example/v1?tenant=other",
  ])("저장 키는 달라진 원문 주소 %s로 보내지 않는다", (base_url) => {
    expect(
      providerConnectionInput(
        { ...providerFormValues(connectionProvider), base_url },
        connectionProvider,
        false,
      ),
    ).toHaveProperty("issue.field", "api_key");
  });
  it("현재 서버의 저장 정규화 재검사를 대체하지 않는다", () => {
    // Same visible legacy query is allowed locally; server must still reject
    // if save's trailing slash normalization would change its destination.
    const row = {
      ...connectionProvider,
      provider: { ...connectionProvider.provider, base_url: "https://public.example/v1?tenant=a/" },
    };
    expect(providerConnectionInput(providerFormValues(row), row, false)).toHaveProperty(
      "body.credential_mode",
      "stored",
    );
  });
  it.each(["-1", "0.5", "600001", "Infinity"])("잘못된 제한 시간 %s 거부", (timeout_ms) => {
    expect(
      providerConnectionInput(
        { ...providerFormValues(connectionProvider), timeout_ms },
        connectionProvider,
        false,
      ),
    ).toHaveProperty("issue.field", "timeout_ms");
  });
  it.each(["", "0", "600000"])("제한 시간 %j 전송 의미 보존", (timeout_ms) => {
    const result = providerConnectionInput(
      { ...providerFormValues(connectionProvider), timeout_ms },
      connectionProvider,
      false,
    );
    if (timeout_ms === "") expect(result).not.toHaveProperty("body.timeout_ms");
    else expect(result).toHaveProperty("body.timeout_ms", Number(timeout_ms));
  });
  it("API 키의 UTF-8 바이트 상한을 확인한다", () => {
    expect(
      providerConnectionInput(
        { ...providerFormValues(connectionProvider), api_key: "가".repeat(2731) },
        connectionProvider,
        false,
      ),
    ).toHaveProperty("issue.field", "api_key");
  });
  it("응답의 0개 모델 성공을 보존한다", () => {
    expect(providerConnectionSchema.parse({ ...connectionOutcome, model_count: 0 })).toHaveProperty(
      "model_count",
      0,
    );
  });
  it.each([
    { outcome: "unknown" },
    { duration_ms: -1 },
    { duration_ms: Infinity },
    { timeout_ms: 10001 },
    { model_count: 10001 },
    { model_count: null },
    { upstream_status: 99 },
    { raw_url: "https://private.example" },
    { outcome: "timeout", model_count: 0 },
    { upstream_status: null },
    { upstream_status: 401 },
    { outcome: "authentication_rejected", model_count: null, upstream_status: 200 },
    { outcome: "redirect_blocked", model_count: null, upstream_status: 200 },
  ])("미확인·비정상·원문 추가 응답은 거부한다 %j", (change) => {
    expect(providerConnectionSchema.safeParse({ ...connectionOutcome, ...change }).success).toBe(false);
  });
});
