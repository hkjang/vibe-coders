package proxy

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

const redTeamProbeCSVFormatColumn = "vibe_probe_csv_format"
const redTeamProbeCSVFormat = "probe-v1"
const redTeamProbeCSVTextPrefix = "vibe-text-v1:"
const redTeamProbeCSVListPrefix = "vibe-list-v1:"

// Ordinary cells stay editable. Reserved, formula-sensitive or whitespace/control
// text has an explicit, reversible representation that starts with an ASCII letter.
// Unlike an apostrophe escape, this never guesses whether an apostrophe was data.
func redTeamProbeCSVText(value string) string {
	needsEncoding := csvTextCell(value) != value || strings.TrimSpace(value) != value ||
		strings.HasPrefix(value, "'") || strings.HasPrefix(value, redTeamProbeCSVTextPrefix) ||
		strings.ContainsFunc(value, func(r rune) bool { return unicode.IsControl(r) || r == '\ufeff' })
	if !needsEncoding {
		return value
	}
	encoded, _ := json.Marshal(value)
	return redTeamProbeCSVTextPrefix + string(encoded)
}

// Keep familiar pipe-separated lists where they are lossless. JSON distinguishes
// a literal pipe, empty element or edge whitespace from a list separator.
func redTeamProbeCSVList(values []string) string {
	joined := strings.Join(values, "|")
	if slices.Equal(values, redTeamSplitPipe(joined)) && !strings.HasPrefix(joined, redTeamProbeCSVListPrefix) {
		return joined
	}
	encoded, _ := json.Marshal(values)
	return redTeamProbeCSVListPrefix + string(encoded)
}

func redTeamProbeCSVString(encoded string) (string, error) {
	if !utf8.ValidString(encoded) || len(encoded) == 0 || encoded[0] != '"' {
		return "", fmt.Errorf("expected a UTF-8 JSON string")
	}
	var value string
	if err := json.Unmarshal([]byte(encoded), &value); err != nil {
		return "", err
	}
	if strings.ContainsRune(value, 0) {
		return "", fmt.Errorf("NUL text is not supported")
	}
	return value, nil
}

func redTeamProbeCSVReadList(value string, versioned bool) ([]string, error) {
	if !versioned || !strings.HasPrefix(value, redTeamProbeCSVListPrefix) {
		return redTeamSplitPipe(value), nil
	}
	encoded := strings.TrimPrefix(value, redTeamProbeCSVListPrefix)
	if len(encoded) == 0 || encoded[0] != '[' {
		return nil, fmt.Errorf("expected a JSON string array")
	}
	var raw []json.RawMessage
	if err := json.Unmarshal([]byte(encoded), &raw); err != nil {
		return nil, err
	}
	values := make([]string, len(raw))
	for i, item := range raw {
		value, err := redTeamProbeCSVString(string(item))
		if err != nil {
			return nil, err
		}
		values[i] = value
	}
	return values, nil
}

type redTeamProbeCSVTable struct {
	columns   map[string]int
	rows      [][]string
	versioned bool
}

func (table redTeamProbeCSVTable) value(row []string, name string) string {
	i, exists := table.columns[name]
	if !exists || i >= len(row) {
		return ""
	}
	value := row[i]
	// IDs, lookup codes, booleans and severity retain their established normalization.
	// Pack names and the actual prompt are free text in the marked format.
	if !table.versioned || (name != "pack_name" && name != "input_template" && name != "target_types" && name != "risk_tags") {
		value = strings.TrimSpace(value)
	}
	return value
}

// Validate the complete marked format before the import loop can write anything.
// Reuse the bounded CSV reader's rows instead of allocating a map for each row.
// Unmarked files retain permissive headers, trimming and skipped-row behavior,
// including literal apostrophes and strings resembling encoding markers.
func redTeamProbeCSVRows(records [][]string) (redTeamProbeCSVTable, error) {
	table := redTeamProbeCSVTable{columns: map[string]int{}, rows: records[1:]}
	for i, name := range records[0] {
		table.columns[strings.TrimSpace(strings.ToLower(name))] = i
	}
	_, table.versioned = table.columns[redTeamProbeCSVFormatColumn]
	if !table.versioned {
		return table, nil
	}
	if len(table.columns) != len(records[0]) || len(table.columns) != len(redTeamProbeCSVHeader)+1 {
		return table, fmt.Errorf("probe-v1 requires each declared column exactly once")
	}
	for _, name := range redTeamProbeCSVHeader {
		if _, exists := table.columns[name]; !exists {
			return table, fmt.Errorf("probe-v1 is missing column %s", name)
		}
	}
	for n, row := range table.rows {
		if len(row) != len(records[0]) || row[table.columns[redTeamProbeCSVFormatColumn]] != redTeamProbeCSVFormat {
			return table, fmt.Errorf("row %d: invalid probe CSV version or column count", n+2)
		}
		for name, i := range table.columns {
			value := row[i]
			if !utf8.ValidString(value) || strings.ContainsRune(value, 0) {
				return table, fmt.Errorf("row %d: unsupported text in %s", n+2, name)
			}
			if strings.HasPrefix(value, redTeamProbeCSVTextPrefix) {
				var err error
				value, err = redTeamProbeCSVString(strings.TrimPrefix(value, redTeamProbeCSVTextPrefix))
				if err != nil {
					return table, fmt.Errorf("row %d: invalid text encoding in %s", n+2, name)
				}
			}
			row[i] = value
		}
		for _, name := range []string{"target_types", "risk_tags"} {
			value := table.value(row, name)
			if strings.HasPrefix(value, redTeamProbeCSVListPrefix) {
				if _, err := redTeamProbeCSVReadList(value, true); err != nil {
					return table, fmt.Errorf("row %d: invalid %s encoding", n+2, name)
				}
			}
		}
	}
	return table, nil
}
