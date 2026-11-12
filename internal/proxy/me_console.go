package proxy

// Personal summaries are independent reads. Report failed components explicitly
// so consumers do not interpret a failed query's zero value as a measurement.
func personalReadFailed(failures *[]string, component string, err error) bool {
	if err == nil {
		return false
	}
	for _, existing := range *failures {
		if existing == component {
			return true
		}
	}
	*failures = append(*failures, component)
	return true
}
