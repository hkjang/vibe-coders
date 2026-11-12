import { describe, expect, it } from "vitest";
import { mockApi } from "@/test/api";
import { readMeSessions, readMeOnboarding, inspectMeConnection } from "./me-access-api";
import { connectionExamples, requireSessionTarget } from "./me-access-model";

const scope = { user: "public-user", team: "public-team", prefixes: ["public_credential_"] };
const urls = { base_url: "https://gateway.example/v1", mcp_url: "https://gateway.example/mcp/gateway" };
const metadata = {
  ...urls,
  client: "openai-sdk",
  available_models: [],
  recommended_models: ["vibe/auto"],
  scopes: null,
};
describe("personal access API contracts", () => {
  it.each([
    { current_session_id: "current", sessions: [{ id: "current", current: false }] },
    { current_session_id: "current", sessions: [{ id: "other", current: true }] },
    { current_session_id: "current", sessions: [{ id: "other" }, { id: "other" }] },
    { sessions: [{ id: "../private" }] },
    { sessions: [{ id: "public_credential_abcdef123456abcdef123456abcdef12" }] },
  ])("rejects inconsistent or unsafe session identity before caching", async (data) => {
    mockApi({ "GET /me/sessions": () => data });
    await expect(readMeSessions(scope)).rejects.toBeDefined();
  });
  it("retains unknown current status without authorizing a session write", async () => {
    mockApi({ "GET /me/sessions": () => ({ sessions: [{ id: "public-device" }] }) });
    const data = await readMeSessions(scope);
    expect(data.sessions[0]?.current).toBeUndefined();
    expect(() => requireSessionTarget(data, "public-device", [])).toThrow();
  });
  it("strips private fields and masks secrets in session labels", async () => {
    mockApi({
      "GET /me/sessions": () => ({
        current_session_id: "current",
        sessions: [
          {
            id: "current",
            current: true,
            user_agent: "public_credential_abcdef123456abcdef123456abcdef12",
            secret: "private payload",
          },
        ],
      }),
    });
    const data = await readMeSessions(scope);
    expect(JSON.stringify(data)).not.toMatch(/abcdef123456|private payload/u);
  });
  it.each([
    { base_url: "https://user:password@gateway.example/v1" },
    { base_url: "javascript:alert(1)" },
    { base_url: "https://gateway.example/v1?key=private" },
    { base_url: "https://gateway.example/v1\nprint('private')" },
    { mcp_url: "https://other.example/mcp/gateway" },
    { mcp_url: "https://gateway.example/admin" },
    { client: "cursor" },
  ])("rejects unsafe/mismatched connection metadata", async (data) => {
    mockApi({ "GET /me/onboarding-pack": () => ({ ...metadata, ...data }) });
    await expect(readMeOnboarding(scope, "openai-sdk")).rejects.toBeDefined();
  });
  it("caches only metadata and builds a placeholder config without server commands", async () => {
    mockApi({
      "GET /me/onboarding-pack": () => ({
        ...metadata,
        config: "private server command",
        mcp_config: { secret: "private payload" },
        sample_curl: "private shell",
        note: "private note",
      }),
    });
    const data = await readMeOnboarding(scope, "openai-sdk");
    expect(JSON.stringify(data)).not.toContain("private");
    expect(data.scopes).toEqual([]);
    const examples = connectionExamples(data.base_url, data.mcp_url);
    expect(examples.sdk).toContain('api_key="<YOUR_API_KEY>"');
    expect(JSON.parse(examples.mcp)).toEqual({
      mcpServers: {
        "vibe-gateway": { url: urls.mcp_url, headers: { Authorization: "Bearer <YOUR_API_KEY>" } },
      },
    });
  });
  it.each([
    { client: "cursor" },
    { overall: "unknown" },
    { auth_mode: "" },
    {
      checks: [
        { name: "scope", status: "pass" },
        { name: "scope", status: "fail" },
      ],
    },
  ])("rejects a mismatched diagnostic acknowledgment", async (data) => {
    mockApi({
      "POST /me/connection-doctor": () => ({
        ...urls,
        client: "openai-sdk",
        overall: "pass",
        auth_mode: "jwt",
        checks: [{ name: "authorization", status: "pass" }],
        ...data,
      }),
    });
    await expect(inspectMeConnection(scope, "openai-sdk")).rejects.toBeDefined();
  });
  it("disables automatic unauthorized replay for an explicit diagnostic POST", async () => {
    const api = mockApi({
      "POST /me/connection-doctor": () => ({
        ...urls,
        client: "openai-sdk",
        overall: "warn",
        auth_mode: "jwt",
        checks: [{ name: "endpoint_reachability", status: "skip" }],
      }),
    });
    await inspectMeConnection(scope, "openai-sdk");
    expect(api.spy.mock.calls[0]?.[1]).toMatchObject({ retryUnauthorized: false, cache: "no-store" });
  });
});
