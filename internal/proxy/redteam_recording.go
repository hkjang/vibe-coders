package proxy

// Confirmation describes database acknowledgements, not exactly-once execution,
// crash recovery, or an all-or-nothing rollback of already dispatched calls.
type redTeamRecording struct {
	Confirmed bool   `json:"confirmed"`
	Stage     string `json:"stage"`
	Results   int    `json:"results"`
}

func (recording *redTeamRecording) fail(stage string, stopped *string) {
	recording.Confirmed = false
	if recording.Stage == "" {
		recording.Stage = stage
	}
	if *stopped == "" {
		*stopped = "recording_failed"
	}
}
