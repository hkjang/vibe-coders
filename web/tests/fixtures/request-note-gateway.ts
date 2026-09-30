import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Public synthetic API responses only. These tests do not prove Go authorization,
// redaction, preservation, or persistence; the real HTTP contracts are separate.
export const targetUrl = "/app/observability/llm?tab=evaluations";
export const xviewUrl = "/app/observability/xview";
export const firstEmail = "note-one@example.invalid";
export const secondEmail = "note-two@example.invalid";
export const readerEmail = "note-reader@example.invalid";
export const firstId = "note-request-one";
export const secondId = "note-request-two";
const timestamp = "2026-09-30T01:00:00Z";
export const initial = {
  request_id: firstId,
  note: "기존 운영 메모",
  tags: ["지연", "확인필요"],
  created_by: "합성 운영자",
  updated_at: timestamp,
  exists: true,
  redacted_fields: [] as ("note" | "tags")[],
};
export const masked = {
  ...initial,
  note: "마스킹된 메모 [REDACTED]",
  tags: ["공개 태그", "[REDACTED]"],
  redacted_fields: ["note", "tags"] as ("note" | "tags")[],
};
type Note = typeof initial;
type Patch = { preserve_fields: ("note" | "tags")[]; note?: string; tags?: string[] };
const userFor = (email: string) => ({
  id: email === secondEmail ? "note-two" : email === readerEmail ? "note-reader" : "note-one",
  email,
  name: "요청 메모 검토자",
  role: email === readerEmail ? "readonly_admin" : "note_operator",
  roles: [email === readerEmail ? "readonly_admin" : "note_operator"],
  scopes: ["admin:read", ...(email === readerEmail ? [] : ["admin:write"])],
  team_id: "note-fixture-team",
  features: { "observability.llm": true, "observability.xview": true },
});
type User = ReturnType<typeof userFor>;
function bootstrap(
  user: User | undefined,
  version: string | undefined,
): Omit<UiBootstrapResponse, "backend_version"> & { backend_version?: string } {
  return {
    ...(version === undefined ? {} : { backend_version: version }),
    ui_version: "request-note-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: targetUrl,
      legacy_fallback: true,
      feedback_enabled: false,
      telemetry_enabled: false,
    },
    authentication: {
      enabled: true,
      authenticated: Boolean(user),
      mode: "session",
      keycloak_enabled: false,
      allow_local_login: true,
      sso_login_url: "/auth/keycloak/login",
    },
    ...(user ? { user } : {}),
    roles: user?.roles ?? [],
    permissions: user?.scopes ?? [],
    allowed_features: user ? ["observability.llm", "observability.xview"] : [],
    capabilities: { raw_prompt_view: false },
    migration_registry: [
      {
        feature_id: "observability.llm",
        title: "LLM 관측",
        app_path: "/app/observability/llm",
        legacy_path: "/admin#/llm",
      },
      {
        feature_id: "observability.xview",
        title: "XView 실시간",
        app_path: xviewUrl,
        legacy_path: "/admin#/xview",
      },
    ].map((feature) => ({
      ...feature,
      status: "preview",
      risk_level: "low",
      read_only: false,
      enabled_roles: [],
      rollout_percent: 100,
      fallback_enabled: true,
      required_permission: "admin:read",
      minimum_api_version: "v0.84.0",
      available: Boolean(user),
    })),
    system_status: { status: "healthy" },
    legacy_route_map: { "/app/observability/llm": "/admin#/llm", [xviewUrl]: "/admin#/xview" },
  };
}
function gate() {
  let pending: Promise<void> | undefined;
  let release: (() => void) | undefined;
  return {
    hold: () => {
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      release?.();
      pending = undefined;
    },
    wait: () => pending,
  };
}
async function installGateway(context: BrowserContext) {
  const sessions = new Map<string, { refresh: string; user: User }>();
  const notes = new Map<string, unknown>([
    [firstId, structuredClone(initial)],
    [secondId, { ...initial, request_id: secondId, note: "두 번째 요청 메모" }],
  ]);
  let version: string | undefined = "v0.86.16";
  let readStatus = 200,
    writeStatus = 200,
    readCount = 0,
    logins = 0,
    logouts = 0,
    logoutResponses = 0;
  let failAfterSave = false;
  const readGate = gate(),
    writeGate = gate(),
    logoutGate = gate();
  const writes: { method: string; id: string; body: Patch | null; userId: string }[] = [];
  const unexpected: string[] = [];
  const points = [firstId, secondId].map((request_id) => ({
    request_id,
    trace_id: `trace-${request_id}`,
    created_at: timestamp,
    ingested_at: timestamp,
    latency_ms: 900,
    first_chunk_ms: 200,
    status_code: 200,
    provider: "synthetic",
    model: "fixture-model",
    endpoint: "/v1/chat/completions",
    total_tokens: 1200,
    cost_krw: 90,
    stream: true,
  }));
  const otherReads: Record<string, unknown> = {
    "GET /admin/llm/timeseries": { window: "24h", bucket: "hour", since: timestamp, points: [] },
    "GET /admin/llm/evaluations": {
      summary: [],
      evaluations: [firstId, secondId].map((request_id) => ({
        id: `eval-${request_id}`,
        request_id,
        trace_id: `trace-${request_id}`,
        name: "품질 평가",
        score: 0.5,
        label: "확인",
        passed: false,
        created_at: timestamp,
      })),
    },
    "GET /admin/llm/feedback": { feedback: [] },
    "GET /admin/llm/prompts": { prompts: [] },
    "GET /admin/llm/insights": { insights: [] },
    "GET /admin/scatter": {
      points,
      groups: [],
      truncated: false,
      since: timestamp,
      cursor: { ingested_at: timestamp, request_id: secondId },
      server_time: timestamp,
    },
    "GET /admin/xview/delta": {
      points: [],
      cursor: { ingested_at: timestamp, request_id: secondId },
      has_more: false,
      server_time: timestamp,
    },
    "GET /admin/saved-filters": { filters: [] },
  };
  await context.route("**/*", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const call = `${request.method()} ${path}`;
    const authorization = request.headers().authorization ?? "";
    const session = sessions.get(authorization);
    const json = (body: unknown, status = 200, requestId = "req-note-fixture") =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": requestId },
        body: JSON.stringify(body),
      });
    if (call === "POST /auth/login") {
      const body = request.postDataJSON() as { email: string; password: string };
      expect([firstEmail, secondEmail, readerEmail]).toContain(body.email);
      expect(body.password).toBe("public-test-password");
      const user = userFor(body.email),
        access = `public-note-access-${++logins}`,
        refresh = `public-note-refresh-${logins}`;
      sessions.set(`Bearer ${access}`, { refresh, user });
      return json({
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(session?.user, version));
    if (call === "GET /auth/sso/status")
      return json({ keycloak_enabled: false, allow_local_login: true, login_url: "/auth/keycloak/login" });
    if (call === "GET /auth/me")
      return json({
        version: version ?? "",
        auth_enabled: true,
        credential_prefixes: ["public-fixture-key-"],
        ...(session ? { user: session.user } : {}),
      });
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (!path.startsWith("/admin/") && !path.startsWith("/auth/") && !path.startsWith("/me/"))
      return route.continue();
    if (!session) {
      unexpected.push(`unauthenticated ${call}`);
      return json({ error: { message: "Fixture login required" } }, 401);
    }
    if (call === "POST /auth/logout") {
      expect(request.postDataJSON()).toEqual({ refresh_token: session.refresh });
      sessions.delete(authorization);
      logouts += 1;
      await logoutGate.wait();
      await json({ ok: true });
      logoutResponses += 1;
      return;
    }
    const match = /^\/admin\/requests\/([^/]+)\/note$/.exec(path);
    if (match) {
      expect(request.headers()["x-vibe-ui"]).toBe("app");
      const id = decodeURIComponent(match[1] ?? "");
      if (request.method() === "GET") {
        readCount += 1;
        const snapshot = structuredClone(notes.get(id)),
          status = readStatus;
        await readGate.wait();
        return status === 200
          ? json(snapshot, 200, "req-note-read")
          : json({ error: { message: "Synthetic note read failed" } }, status, "req-note-read");
      }
      const method = request.method();
      // Any PUT/POST fallback is an unexpected write, not a permissive fixture.
      if (method !== "PATCH" && method !== "DELETE") {
        unexpected.push(call);
        return json({ error: { message: "Unexpected note mutation" } }, 405);
      }
      const body = method === "PATCH" ? (request.postDataJSON() as Patch) : null;
      if (body) {
        expect(Array.isArray(body.preserve_fields)).toBe(true);
        expect(Object.keys(body).every((key) => ["preserve_fields", "note", "tags"].includes(key))).toBe(
          true,
        );
        for (const field of body.preserve_fields) {
          expect(["note", "tags"]).toContain(field);
          expect(Object.hasOwn(body, field)).toBe(false);
        }
      }
      writes.push(structuredClone({ method, id, body, userId: session.user.id }));
      const status = writeStatus,
        writable = session.user.scopes.includes("admin:write");
      await writeGate.wait();
      if (!writable) return json({ error: { message: "Synthetic read-only session" } }, 401);
      if (status !== 200)
        return json({ error: { message: "Synthetic note save failed" } }, status, "req-note-write");
      const current = notes.get(id) as Note;
      const next: Note =
        body === null
          ? { ...initial, request_id: id, note: "", tags: [], exists: false }
          : {
              ...current,
              exists: true,
              note: body.preserve_fields.includes("note") ? current.note : (body.note ?? ""),
              tags: body.preserve_fields.includes("tags") ? current.tags : (body.tags ?? []),
              redacted_fields: current.redacted_fields.filter((field) =>
                body.preserve_fields.includes(field),
              ),
              updated_at: "2026-09-30T02:00:00Z",
            };
      notes.set(id, next);
      if (failAfterSave) readStatus = 503;
      return json(method === "DELETE" ? { id, status: "deleted" } : next, 200, "req-note-write");
    }
    const detail = /^\/admin\/llm\/traces\/([^/]+)$/.exec(path);
    if (detail && request.method() === "GET")
      return json({
        request: { id: detail[1], model: "fixture-model", status_code: 200, created_at: timestamp },
        spans: [],
        tools: [],
        evaluations: [],
        feedback: [],
      });
    if (/^\/admin\/requests\/[^/]+\/(explain|trace|links)$/.test(path) && request.method() === "GET")
      return json({ request_id: path.split("/")[3], spans: [], counts: {} });
    if (Object.hasOwn(otherReads, call)) return json(otherReads[call]);
    unexpected.push(call);
    return json({ error: { message: "Unexpected note fixture request" } }, 501);
  });
  return {
    writes,
    unexpected,
    reads: () => readCount,
    logouts: () => logouts,
    logoutResponses: () => logoutResponses,
    replaceNote: (next: unknown, id = firstId) => {
      notes.set(id, structuredClone(next));
    },
    setVersion: (next: string | undefined) => {
      version = next;
    },
    setWritable: (value: boolean) => {
      for (const session of sessions.values())
        session.user.scopes = ["admin:read", ...(value ? ["admin:write"] : [])];
    },
    failReads: () => {
      readStatus = 503;
    },
    succeedReads: () => {
      readStatus = 200;
    },
    failWrites: (status = 500) => {
      writeStatus = status;
    },
    succeedWrites: () => {
      writeStatus = 200;
    },
    failReadAfterSave: () => {
      failAfterSave = true;
    },
    holdReads: readGate.hold,
    releaseReads: readGate.release,
    holdWrites: writeGate.hold,
    releaseWrites: writeGate.release,
    holdLogouts: logoutGate.hold,
    releaseLogouts: logoutGate.release,
  };
}
type Gateway = Awaited<ReturnType<typeof installGateway>>;
export const test = base.extend<{ gateway: Gateway }>({
  gateway: async ({ context }, run) => {
    const gateway = await installGateway(context);
    try {
      await run(gateway);
    } finally {
      gateway.releaseReads();
      gateway.releaseWrites();
      gateway.releaseLogouts();
      expect(gateway.unexpected).toEqual([]);
    }
  },
});
