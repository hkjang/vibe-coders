import { z } from "zod";
import { operation, type WithBody, type WithQuery } from "@/shared/api/endpoint-factory";
import type {
  GetAdminWorkflowsData,
  PostAdminWorkflowsData,
  WorkflowGraphReview,
  WorkflowGraphWriteRequest,
  WorkflowGraphPublishRequest,
  PostAdminWorkflowsIdPublishData,
  WorkflowPublishResult,
} from "@/shared/api/generated";
import { workflowDefinitionSchema } from "./workflow-page.schemas";

export const workflowGraphReviewSchema = z.object({
  workflow: workflowDefinitionSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
}) satisfies z.ZodType<WorkflowGraphReview>;
export const workflowGraphEndpoints = {
  publish: operation<
    WithBody<PostAdminWorkflowsIdPublishData, WorkflowGraphPublishRequest>,
    WorkflowPublishResult
  >()(
    "POST",
    "/admin/workflows/{id}/publish",
    z.object({
      workflow_id: z.string(),
      version: z.number().int().positive(),
      enabled: z.boolean(),
      published: z.boolean(),
    }),
  ),
  review: operation<WithQuery<GetAdminWorkflowsData, { view: "review"; id: string }>, WorkflowGraphReview>()(
    "GET",
    "/admin/workflows",
    workflowGraphReviewSchema,
    z.object({ view: z.literal("review"), id: z.string().min(1) }),
  ),
  save: operation<
    WithQuery<WithBody<PostAdminWorkflowsData, WorkflowGraphWriteRequest>, { review: "graph" }>,
    WorkflowGraphReview
  >()("POST", "/admin/workflows", workflowGraphReviewSchema, z.object({ review: z.literal("graph") })),
};
