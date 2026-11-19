import type { z } from "zod";
import type { ApiFileEndpoint, FileResponseContract } from "@/shared/api/file-endpoint";

import type { OpenApiMethod, OpenApiMethodFor, OpenApiPath } from "@/shared/api/generated/paths.gen";

// Every API call goes through an endpoint built here. The brand keeps ad-hoc
// `{ method, path }` objects out of the client, and the OpenAPI-derived path and
// method types keep the registry aligned with the server's documented surface.
const endpointBrand: unique symbol = Symbol("api-endpoint");
declare const operationData: unique symbol;

export interface OperationData {
  readonly url: OpenApiPath;
  readonly query?: object;
}

/** Replaces the generated (usually untyped) query with an app-defined query type. */
export type WithQuery<Data extends OperationData, Query extends object> = Omit<Data, "query"> & {
  readonly query?: Query;
};

/**
 * Declares the request body of an operation. The generated types give every
 * legacy route `body?: never` because those routes have no documented request
 * schema, so a domain states the body it actually sends here.
 */
export type WithBody<Data extends OperationData, Body> = Omit<Data, "body"> & {
  readonly body: Body;
};

export interface ApiRoute<
  Data extends OperationData = OperationData,
  Method extends OpenApiMethod = OpenApiMethod,
> {
  readonly method: Method;
  readonly path: Data["url"];
  readonly [endpointBrand]: true;
  readonly [operationData]?: Data;
}

/** A registered raw-text write; callers cannot choose a transport content type. */
export interface TextRequestContract {
  readonly contentType: "text/csv";
  readonly maxBytes: number;
}

export interface ApiEndpoint<
  Data extends OperationData,
  Method extends OpenApiMethod = OpenApiMethod,
  Schema extends z.ZodType = z.ZodType,
> extends ApiRoute<Data, Method> {
  readonly schema: Schema;
  readonly querySchema?: z.ZodType<object>;
  readonly errorSchemas?: ApiEndpointErrorSchemas;
  readonly textRequest?: TextRequestContract;
}

export type ApiEndpointErrorSchemas = Readonly<Partial<Record<number, z.ZodType>>>;

export interface ApiEndpointBase {
  readonly method: OpenApiMethod;
  readonly path: OpenApiPath;
  readonly schema: z.ZodType;
  readonly querySchema?: z.ZodType<object>;
  readonly errorSchemas?: ApiEndpointErrorSchemas;
  readonly textRequest?: TextRequestContract;
  readonly [endpointBrand]: true;
}

export type ApiEndpointData<Endpoint extends ApiEndpointBase> =
  Endpoint extends ApiEndpoint<infer Data> ? Data : never;

export type ApiEndpointOutput<Endpoint extends ApiEndpointBase> = z.output<Endpoint["schema"]>;

/**
 * Declares one JSON operation. `Data` is the generated `<Method><Path>Data` type
 * (optionally wrapped in `WithQuery`), `Response` the generated response type;
 * the zod schema must accept that response so parsing and typing agree.
 */
export function operation<Data extends OperationData, Response>() {
  return <Method extends OpenApiMethodFor<Data["url"]>, Schema extends z.ZodType<Response>>(
    method: Method,
    path: Data["url"],
    schema: Schema,
    querySchema?: z.ZodType<object>,
    errorSchemas?: ApiEndpointErrorSchemas,
  ): ApiEndpoint<Data, Method, Schema> => ({
    [endpointBrand]: true,
    method,
    path,
    schema,
    ...(querySchema ? { querySchema } : {}),
    ...(errorSchemas ? { errorSchemas } : {}),
  });
}

/** Raw text writes use the JSON response contract and never replay on authentication failure. */
export function textOperation<Data extends OperationData, Response>() {
  return <
    Method extends OpenApiMethodFor<Data["url"]> & ("POST" | "PUT" | "PATCH"),
    Schema extends z.ZodType<Response>,
  >(
    method: Method,
    path: Data["url"],
    schema: Schema,
    textRequest: TextRequestContract,
  ): ApiEndpoint<WithBody<Data, string>, Method, Schema> => ({
    [endpointBrand]: true,
    method,
    path,
    schema,
    textRequest,
  });
}

/** Buffered, read-only file operations retain generated path/method checking. */
export function fileOperation<Data extends OperationData>() {
  return <Method extends OpenApiMethodFor<Data["url"]> & "GET">(
    method: Method,
    path: Data["url"],
    contract: FileResponseContract,
    querySchema?: z.ZodType<object>,
  ): ApiFileEndpoint<Data> => ({
    [endpointBrand]: true,
    method,
    path,
    ...contract,
    responseFormat: "bytes",
    ...(querySchema ? { querySchema } : {}),
  });
}

/** Declares a navigation-only route (no JSON body is parsed). */
export function route<Data extends OperationData>() {
  return <Method extends OpenApiMethodFor<Data["url"]>>(
    method: Method,
    path: Data["url"],
  ): ApiRoute<Data, Method> => ({ [endpointBrand]: true, method, path });
}

/**
 * Builds the path of a parameterised OpenAPI route. Values are percent-encoded so
 * an identifier can never introduce a new path segment or query string.
 */
export function pathWithParams<Path extends OpenApiPath>(
  template: Path,
  params: Record<string, string | number>,
): Path {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`missing path parameter ${key} for ${template}`);
    return encodeURIComponent(String(value));
  }) as Path;
}

/**
 * Binds a parameterised endpoint to concrete path parameters, e.g.
 * `withPathParams(endpoints.domains.access.users.update, { id })`. Values are
 * percent-encoded, so an identifier can never add a path segment of its own.
 */
export function withPathParams<Endpoint extends ApiRoute>(
  endpoint: Endpoint,
  params: Readonly<Record<string, string | number>>,
): Endpoint {
  return { ...endpoint, path: pathWithParams(endpoint.path, params) } as Endpoint;
}

export type EndpointLeaves<Registry> = Registry extends ApiEndpointBase
  ? Registry
  : Registry extends ApiRoute
    ? never
    : Registry extends object
      ? { [Key in keyof Registry]: EndpointLeaves<Registry[Key]> }[keyof Registry]
      : never;
