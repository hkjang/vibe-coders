import { z } from "zod";

// The legacy admin APIs are documented without response schemas. Screens that port
// them describe the fields they render and let the rest pass through, so a new
// server field never turns into a client-side contract failure.

/** An object whose declared fields are validated and whose other fields are kept. */
export function looseObject<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.looseObject(shape);
}

/** Any JSON object (used for opaque payloads shown as JSON). */
export const unknownRecord = z.record(z.string(), z.unknown());

/** A list whose items are validated leniently; non-object items are dropped. */
export function looseList<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.array(z.looseObject(shape));
}

/** Servers return numbers as strings in a few legacy tables. */
export const numberish = z.union([
  z.number(),
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/u)
    .transform(Number),
]);

/** Accepts `null`/missing and normalises to a default. */
export function orDefault<Schema extends z.ZodType>(schema: Schema, fallback: z.output<Schema>) {
  return schema.nullish().transform((value) => (value ?? fallback) as z.output<Schema>);
}

/** `{ status: "ok" }`-style acknowledgements returned by mutations. */
export const acknowledgementSchema = z.looseObject({ status: z.string().optional() });
