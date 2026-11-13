import type { WorkAppDefinition } from "@/shared/api/generated";

// Shapes of the real additive GET views, shared by browser/component fixtures.
// Authorization and SQL filtering are separately exercised against Go stores.
export function workAppReadFixture(
  input: readonly (Partial<WorkAppDefinition> & { id: string })[],
  query: object = {},
) {
  const params = query as Record<string, unknown>;
  const apps = input.map((row): WorkAppDefinition => ({
    title: row.id,
    icon: "",
    allowed_roles: "",
    owner: "fixture",
    description: "",
    allowed_teams: "",
    status: "active",
    created_at: "2026-11-12T00:00:00Z",
    updated_at: "2026-11-12T00:00:00Z",
    components: [],
    ...row,
  }));
  if (params.view === "detail") return { app: apps.find((row) => row.id === params.id) ?? null };
  if (params.view !== "page") return { apps };
  const limit = Number(params.limit ?? 25),
    offset = Number(params.offset ?? 0);
  let filtered = apps.filter((row) => {
    const search = String(params.q ?? "").toLowerCase();
    return (
      [row.id, row.title, row.description, row.allowed_teams, row.allowed_roles, row.owner].some((value) =>
        value.toLowerCase().includes(search),
      ) &&
      (params.status !== "active" || row.status === "active") &&
      (params.status !== "archived" || row.status === "archived")
    );
  });
  const sorts = String(params.sort ?? "title:asc").split(",");
  filtered = [...filtered].sort((a, b) => {
    for (const sort of sorts) {
      const [field, direction] = sort.split(":");
      if (!field || !Object.hasOwn(a, field)) continue;
      const key = field as keyof WorkAppDefinition;
      const left = String(a[key]),
        right = String(b[key]);
      const diff = left < right ? -1 : left > right ? 1 : 0;
      if (diff) return direction === "desc" ? -diff : diff;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return {
    apps: filtered
      .slice(offset, offset + limit)
      .map(({ components, ...row }) => ({ ...row, component_count: components?.length ?? 0 })),
    total: filtered.length,
    limit,
    offset,
    summary: {
      total: apps.length,
      active: apps.filter((row) => row.status === "active").length,
      archived: apps.filter((row) => row.status === "archived").length,
      unscoped: apps.filter((row) => row.allowed_teams === "" && row.allowed_roles === "").length,
    },
  };
}
