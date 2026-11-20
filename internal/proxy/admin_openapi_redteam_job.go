package proxy

func enrichRedTeamJobOpenAPI(method string, op, responses map[string]any) {
	for _, status := range []string{"400", "401", "403", "404", "409", "500", "503"} {
		responses[status] = map[string]any{"description": "Invalid job request, current authorization denied, foreign owner, missing job, stale review, active campaign job or unconfirmed admission. Never automatically repeat paid work.", "content": jsonContent(schemaRef("AppError"))}
	}
	parameters, _ := op["parameters"].([]any)
	if method == "get" {
		op["description"] = "Read an admitted reviewed-campaign job using existing admin:read authentication and exact actor ownership. Status is durable and readable across server processes, even after campaign deletion. A stale worker lease is reported interrupted without dispatching or mutating the job. No credential, review capability, prompt, raw response, worker token or lease is returned. All responses are no-store."
		op["parameters"] = append(parameters, map[string]any{"name": "job_id", "in": "query", "required": true, "schema": map[string]any{"type": "string", "pattern": "^rtj_[a-f0-9]{64}$"}, "description": "Sole query parameter; use the job_id supplied in the review before submission."})
		responses["200"] = successResponse("RedTeamExecutionJob")
		return
	}
	op["parameters"] = append(parameters, map[string]any{"name": "job", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"1"}}, "description": "Sole optional query parameter. Without it, the existing synchronous response is unchanged."})
	op["description"] = op["description"].(string) + " Optional job=1 acknowledges an actor-owned durable operation with202 after atomic job/admission-audit commit. A duplicate accepted capability returns the same job with200 and never invokes again. Job IDs are safe recovery references, not credentials. Only this job mode excludes active jobs for the same campaign across DB pools; synchronous Legacy/scheduled/replay executions retain their existing behavior. The shared runner outlives browser cancellation but is bounded by server lifecycle and the same120s maximum. Its sole proxy key remains in worker memory and is never stored. Progress and completion are conditional on a live worker lease; final job state and its audit commit together. Restart/expired lease/uncertain storage never automatically redispatches. This is not exactly-once provider invocation or a cross-system transaction. GET with job_id reads the same operation; do not submit another run to recover a lost reply."
	responses["200"] = successResponse("RedTeamReviewedWriteResponse")
	responses["202"] = successResponse("RedTeamExecutionJob")
}
