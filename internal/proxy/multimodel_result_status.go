package proxy

// successfulStoredMultiModelStatus accepts the current run status and the
// legacy persisted spelling. It does not normalize or rewrite either value.
func successfulStoredMultiModelStatus(status string) bool {
	return status == "success" || status == "ok"
}
