package proxy

import (
	"context"
	"sort"
	"strings"
	"unicode/utf8"
)

// Only definition metadata is used. In particular, never evaluate envValue or
// look up effective/stored values, including for non-secret settings.
func (s *Server) searchSettingNavigation(ctx context.Context, query string, defs []settingDef, descriptions map[string]string) resourceSearchGroup {
	group := resourceSearchGroup{Kind: "setting", Status: "ok", Items: []resourceSearchItem{}}
	needle := strings.ToLower(query)
	for _, def := range defs {
		if ctx.Err() != nil {
			return resourceSearchGroup{Kind: "setting", Status: "unavailable", Items: []resourceSearchItem{}}
		}
		description := descriptions[def.Key]
		if !strings.Contains(strings.ToLower(def.Key), needle) && !strings.Contains(strings.ToLower(def.Category), needle) && !strings.Contains(strings.ToLower(description), needle) {
			continue
		}
		if len(def.Key) > 256 || !s.safeResourceSearchText(def.Key) {
			continue
		}
		title := description
		if utf8.RuneCountInString(title) > 256 || !s.safeResourceSearchText(title) {
			title = def.Key
		}
		group.Items = append(group.Items, resourceSearchItem{Kind: "setting", ID: def.Key, Title: title})
	}
	sort.Slice(group.Items, func(i, j int) bool { return group.Items[i].ID < group.Items[j].ID })
	if len(group.Items) > 10 {
		group.Limited = true
		group.Items = group.Items[:10]
	}
	return group
}
