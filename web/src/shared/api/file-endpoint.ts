import type { z } from "zod";

import type { ApiRoute, OperationData } from "@/shared/api/endpoint-factory";

export interface FileResponseContract {
  readonly contentTypes: readonly string[];
  readonly maxBytes?: number;
  readonly tooLargeMessage?: string;
}

export interface ApiFileEndpoint<Data extends OperationData = OperationData>
  extends ApiRoute<Data, "GET">, FileResponseContract {
  readonly responseFormat: "bytes";
  readonly querySchema?: z.ZodType<object>;
  readonly errorSchemas?: never;
}

export type ApiFileEndpointData<Endpoint extends ApiFileEndpoint> =
  Endpoint extends ApiFileEndpoint<infer Data> ? Data : never;

export interface ApiFile {
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
  /** Recheck immediately before saving or publishing a result after an await. */
  readonly assertCurrent: () => void;
}
