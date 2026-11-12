/** Explicit projection for older fixtures exercising account edits/ownership. */
export function accountFixtureResponse<
  T extends { auth_users: readonly Record<string, unknown>[]; team_names: Readonly<Record<string, string>> },
>(catalog: T, query?: object) {
  const values = (query ?? {}) as Record<string, unknown>;
  if (values.view !== "accounts") return catalog;
  const limit = Number(values.limit ?? 25),
    offset = Number(values.offset ?? 0);
  return {
    accounts: catalog.auth_users.slice(offset, offset + limit).map((account) => ({
      ...account,
      team_name: catalog.team_names[String(account.team_id ?? "")] ?? "",
    })),
    total: catalog.auth_users.length,
    limit,
    offset,
  };
}
