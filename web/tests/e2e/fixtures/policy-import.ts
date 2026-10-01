import { expect, type BrowserContext } from "@playwright/test";
import type { ImportPolicy, PolicyImportBody } from "../../../src/shared/api/domains/policy-import";
import { test as base, account, policy as editorPolicy } from "./policy-editor";

export { account };
if (!editorPolicy.name || editorPolicy.rules?.some((rule) => !rule.id))
  throw new Error("Import fixture needs explicit exported policy name and rule IDs");
export const policy: ImportPolicy = {
  ...editorPolicy,
  name: editorPolicy.name,
  rules: editorPolicy.rules?.map((rule) => ({ ...rule, id: String(rule.id) })) ?? [],
};
type Reply = { status?: number; body: unknown; commit?: boolean; requestId?: string };
type Hold = { promise: Promise<void>; release: () => void };
export function exportDocument(policies: ImportPolicy[]) {
  const time = "2026-01-01T00:00:00Z";
  return {
    version: 1,
    count: policies.length,
    policies: policies.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      enabled: row.enabled ?? false,
      priority: row.priority || 100,
      rollout_percent: row.rollout_percent || 100,
      created_at: row.created_at ?? time,
      updated_at: row.updated_at ?? time,
      rules: (row.rules ?? []).map((rule) => ({
        id: rule.id,
        policy_id: row.id,
        name: rule.name ?? "",
        enabled: rule.enabled ?? false,
        priority: rule.priority || 100,
        conditions: rule.conditions ?? {},
        actions: rule.actions ?? {},
        created_at: rule.created_at ?? time,
        updated_at: rule.updated_at ?? time,
      })),
    })),
  };
}

// Synthetic browser transport, not a database or server-atomicity test. Do not
// enforce UI readonly/confirmation/ownership guards here: observe every attempt.
async function installImports(context: BrowserContext, origin: string, publish: (rows: unknown[]) => void) {
  let rows = structuredClone([policy]) as ImportPolicy[];
  let exportCount = 0;
  let rawExport: string | undefined;
  let failFollowup = false;
  const dryRuns: PolicyImportBody[] = [];
  const applies: PolicyImportBody[] = [];
  const bodies: string[] = [];
  const completed: number[] = [];
  const finishedExports: number[] = [];
  const holds = new Map<string, Hold>();
  const replies = new Map<number, Reply>();
  const failedReads = new Set<number>();
  const errors: string[] = [];
  function hold(kind: "export" | "apply", number: number) {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    holds.set(`${kind}:${number}`, { promise, release });
  }
  await context.route(/\/admin\/policies\/(?:export|import)(?:\?.*)?$/u, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      errors.push(`external ${request.method()} ${url.origin}`);
      return route.abort("blockedbyclient");
    }
    const exporting = url.pathname.endsWith("/export");
    expect(request.headers().authorization).toBe("Bearer public-editor-access");
    expect(request.headers()["x-vibe-route"]).toBe("governance.policies");
    const json = (body: unknown, status = 200, requestId = "req-public-policy-import") =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
        headers: { "X-Request-ID": requestId, "Cache-Control": "no-store" },
      });
    if (exporting && request.method() === "GET") {
      const sequence = ++exportCount;
      const snapshot = rawExport ?? JSON.stringify(exportDocument(rows));
      const failed = failedReads.has(sequence) || (failFollowup && applies.length > 0);
      await holds.get(`export:${sequence}`)?.promise;
      if (failed) await json({ error: { message: "public export unavailable" } }, 503);
      else await route.fulfill({ status: 200, contentType: "application/json", body: snapshot });
      finishedExports.push(sequence);
      return;
    }
    if (!exporting && request.method() === "POST") {
      const body = request.postDataJSON() as PolicyImportBody;
      expect(Array.isArray(body.policies)).toBe(true);
      const dry = url.searchParams.get("dry_run") === "1";
      expect(url.search).toBe(dry ? "?dry_run=1" : "");
      const requests = dry ? dryRuns : applies;
      requests.push(body);
      const sequence = requests.length;
      if (!dry) bodies.push(request.postData() ?? "");
      const plan = body.policies.map((row) => ({
        id: row.id,
        name: row.name,
        action: rows.some((old) => old.id === row.id) ? "update" : "create",
        rules: row.rules?.length ?? 0,
      }));
      const ack = {
        dry_run: dry,
        created: plan.filter((row) => row.action === "create").length,
        updated: plan.filter((row) => row.action === "update").length,
        plan,
      };
      if (dry) return json(ack);
      await holds.get(`apply:${sequence}`)?.promise;
      const reply = replies.get(sequence) ?? { body: ack, commit: true };
      if (reply.commit ?? false) {
        for (const submitted of body.policies) {
          const old = rows.find((row) => row.id === submitted.id);
          const normalized = { ...structuredClone(submitted), rules: submitted.rules ?? old?.rules ?? [] };
          rows = old
            ? rows.map((row) => (row.id === submitted.id ? normalized : row))
            : [...rows, normalized];
        }
        publish(rows);
      }
      await json(reply.body, reply.status ?? 200, reply.requestId);
      completed.push(sequence);
      return;
    }
    errors.push(`${request.method()} ${url.pathname}`);
    return json({ error: { message: "unexpected synthetic import method" } }, 501);
  });
  return {
    dryRuns,
    applies,
    bodies,
    completed,
    finishedExports,
    errors,
    exports: () => exportCount,
    rows: (next: ImportPolicy[]) => {
      rows = structuredClone(next);
    },
    rawExport: (next: string | undefined) => {
      rawExport = next;
    },
    failExport: (sequence: number) => failedReads.add(sequence),
    failFollowup: (next: boolean) => {
      failFollowup = next;
    },
    reply: (sequence: number, next: Reply) => replies.set(sequence, next),
    holdExport: (sequence: number) => hold("export", sequence),
    holdApply: (sequence: number) => hold("apply", sequence),
    releaseExport: (sequence: number) => holds.get(`export:${sequence}`)?.release(),
    releaseApply: (sequence: number) => holds.get(`apply:${sequence}`)?.release(),
    releaseAll: () => {
      for (const item of holds.values()) item.release();
    },
  };
}
type ImportGateway = Awaited<ReturnType<typeof installImports>>;
export const test = base.extend<{ imports: ImportGateway }>({
  imports: async ({ context, gateway, baseURL }, run) => {
    // Establish the session fixture before adding the two endpoint overrides.
    expect(gateway.saves).toEqual([]);
    if (!baseURL) throw new Error("Expected local synthetic import base URL");
    const imports = await installImports(context, new URL(baseURL).origin, gateway.policies);
    try {
      await run(imports);
    } finally {
      for (const page of context.pages()) await page.close();
      imports.releaseAll();
      await context.unrouteAll({ behavior: "wait" });
      expect(imports.errors).toEqual([]);
      expect(gateway.saves).toEqual([]);
    }
  },
});
