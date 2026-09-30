package proxy

import (
	"encoding/json"
	"errors"
	"io"
	"slices"

	"vibe-coders/internal/store"
)

type requestNoteWrite struct {
	Tags         []string `json:"tags"`
	Note         string   `json:"note"`
	PreserveNote bool     `json:"-"`
	PreserveTags bool     `json:"-"`
}

// Legacy callers still ignore unknown fields and replace omitted/null values.
// Only the app may explicitly preserve a field, without resubmitting a masked
// display value. A simultaneous replacement (even null) is ambiguous and fails.
func decodeRequestNoteWrite(reader io.Reader, app, requirePreserve bool) (requestNoteWrite, error) {
	var value requestNoteWrite
	if !app {
		err := json.NewDecoder(reader).Decode(&value)
		return value, err
	}
	var raw struct {
		Tags           json.RawMessage `json:"tags"`
		Note           json.RawMessage `json:"note"`
		PreserveFields json.RawMessage `json:"preserve_fields"`
	}
	if err := json.NewDecoder(reader).Decode(&raw); err != nil {
		return value, err
	}
	if len(raw.Tags) > 0 {
		if err := json.Unmarshal(raw.Tags, &value.Tags); err != nil {
			return value, err
		}
	}
	if len(raw.Note) > 0 {
		if err := json.Unmarshal(raw.Note, &value.Note); err != nil {
			return value, err
		}
	}
	if len(raw.PreserveFields) == 0 {
		if requirePreserve {
			return value, errors.New("preserve_fields is required")
		}
		return value, nil
	}
	var fields []string
	if err := json.Unmarshal(raw.PreserveFields, &fields); err != nil {
		return value, err
	}
	if fields == nil {
		return value, errors.New("invalid preserve_fields")
	}
	for _, field := range fields {
		switch field {
		case "note":
			if value.PreserveNote || len(raw.Note) > 0 {
				return value, errors.New("invalid preserve_fields")
			}
			value.PreserveNote = true
		case "tags":
			if value.PreserveTags || len(raw.Tags) > 0 {
				return value, errors.New("invalid preserve_fields")
			}
			value.PreserveTags = true
		default:
			return value, errors.New("invalid preserve_fields")
		}
	}
	return value, nil
}

type requestNoteAppResponse struct {
	store.RequestNote
	Exists         bool     `json:"exists"`
	RedactedFields []string `json:"redacted_fields"`
}

func projectRequestNoteForApp(note store.RequestNote, exists, showRaw bool, rawProviders ...string) requestNoteAppResponse {
	projected := note
	// maskRequestNoteForExternal mutates the slice; never mutate the stored
	// snapshot while comparing it with the projection, including colliding tags.
	projected.Tags = append([]string{}, note.Tags...)
	maskRequestNoteForExternal(&projected, showRaw, rawProviders...)
	fields := []string{}
	if projected.Note != note.Note {
		fields = append(fields, "note")
	}
	if !slices.Equal(projected.Tags, note.Tags) {
		fields = append(fields, "tags")
	}
	return requestNoteAppResponse{RequestNote: projected, Exists: exists, RedactedFields: fields}
}
