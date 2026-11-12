/** Project an existing catalog fixture explicitly; malformed fixtures stay malformed. */
export function teamFixtureResponse(catalog: unknown, query?: object) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return catalog;
  const value = catalog as Record<string, unknown>;
  const values = (query ?? {}) as Record<string, unknown>;
  if (values.view === "usage") return { teams: value.teams };
  if (values.view !== "registered" || !Array.isArray(value.auth_teams)) return catalog;
  const teams: unknown[] = value.auth_teams;
  const limit = Number(values.limit ?? 25),
    offset = Number(values.offset ?? 0);
  return { auth_teams: teams.slice(offset, offset + limit), total: teams.length, limit, offset };
}
