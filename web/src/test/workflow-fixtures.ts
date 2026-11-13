import type { WorkflowDefinition } from "@/shared/api/generated";

// Shapes of the real additive GET views, shared by browser/component fixtures.
// Authorization and SQL filtering are separately exercised against Go stores.
export function workflowReadFixture(
  input: readonly (Partial<WorkflowDefinition> & { id: string })[],
  query: object = {},
) {
  const params = query as Record<string, unknown>;
  const workflows = input.map((row): WorkflowDefinition => ({
    name: row.id,
    description: "",
    allowed_teams: "",
    enabled: false,
    created_by: "fixture",
    created_at: "2026-11-12T00:00:00Z",
    updated_at: "2026-11-12T00:00:00Z",
    steps: [],
    ...row,
  }));
  if (params.view === "detail") return { workflow: workflows.find((row) => row.id === params.id) ?? null };
  if (params.view !== "page") return { workflows };
  const limit = Number(params.limit ?? 25),
    offset = Number(params.offset ?? 0);
  let filtered = workflows.filter((row) => {
    const search = String(params.q ?? "").toLowerCase();
    return (
      [row.id, row.name, row.description, row.allowed_teams].some((value) =>
        value.toLowerCase().includes(search),
      ) &&
      (params.status !== "enabled" || row.enabled) &&
      (params.status !== "disabled" || !row.enabled)
    );
  });
  const sorts = String(params.sort ?? "created_at:desc").split(",");
  filtered = [...filtered].sort((a, b) => {
    for (const sort of sorts) {
      const [field, direction] = sort.split(":");
      if (!field || !Object.hasOwn(a, field)) continue;
      const key = field as keyof WorkflowDefinition;
      const left = String(a[key]),
        right = String(b[key]);
      const diff = left < right ? -1 : left > right ? 1 : 0;
      if (diff) return direction === "desc" ? -diff : diff;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return {
    workflows: filtered
      .slice(offset, offset + limit)
      .map(({ steps, ...row }) => ({ ...row, step_count: steps?.length ?? 0 })),
    total: filtered.length,
    limit,
    offset,
    summary: { total: workflows.length, enabled: workflows.filter((row) => row.enabled).length },
  };
}
