import { AppError } from "@/shared/api/error";

export type QueryPrimitive = string | number | boolean;
export type QueryParameter =
  QueryPrimitive | null | undefined | readonly (QueryPrimitive | null | undefined)[];

type SerializableQuery<Query extends object> = {
  readonly [Key in keyof Query]: Query[Key] extends QueryParameter ? Query[Key] : never;
};

function queryContractError(message: string, details: unknown): AppError {
  return new AppError(message, { kind: "contract", details });
}

function serializePrimitive(key: string, value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "boolean":
      return String(value);
    case "number":
      if (Number.isFinite(value)) return String(value);
      throw queryContractError("API 쿼리 숫자는 유한한 값이어야 합니다.", { key, value });
    default:
      throw queryContractError("API 쿼리는 문자열, 숫자 또는 불리언만 사용할 수 있습니다.", {
        key,
        value,
      });
  }
}

export function serializeQuery<Query extends object>(query?: Query & SerializableQuery<Query>): string {
  if (query === undefined) return "";

  const parameters = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(query)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value === null || value === undefined) continue;
      parameters.append(key, serializePrimitive(key, value));
    }
  }
  return parameters.toString();
}

export function buildApiPath<Query extends object>(
  path: string,
  query?: Query & SerializableQuery<Query>,
): string {
  const serialized = serializeQuery(query);
  return serialized ? `${path}?${serialized}` : path;
}
