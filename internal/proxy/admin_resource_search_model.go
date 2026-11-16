package proxy

import (
	"context"
	"sort"
	"strings"
	"unicode/utf8"
)

func (s *Server) searchModelNavigation(ctx context.Context, query string, refs providerReferences) resourceSearchGroup {
	group := resourceSearchGroup{Kind: "model", Items: []resourceSearchItem{}, Status: "unavailable"}
	if ctx.Err() != nil {
		return group
	}
	catalog, err := s.collectAdminModels(ctx, "", "", refs)
	if err != nil {
		return group
	}
	group.Status = "ok"
	if len(catalog.PartialFailures) > 0 || ctx.Err() != nil {
		group.Status = "partial"
	}
	for _, provider := range catalog.Providers {
		if provider.Stale || provider.Status != "ok" {
			group.Status = "partial"
		}
	}
	for _, failure := range catalog.PartialFailures {
		if strings.Contains(failure.Code, "limit_exceeded") {
			group.Limited = true
		}
	}
	query = strings.ToLower(query)
	matches := make([]resourceSearchItem, 0)
	seen := make(map[string]bool)
	for _, model := range catalog.Models {
		// Only complete safe model IDs and provider labels leave the collector.
		// Do not search owners, endpoint URLs, deprecation notes or raw metadata.
		if utf8.RuneCountInString(model.ID) > 256 || len(model.ID) > 1024 ||
			!s.safeResourceSearchText(model.ID) || !strings.Contains(strings.ToLower(model.ID), query) ||
			!s.modelsProviderLabelSafeForConfig(model.Provider) || !s.safeResourceSearchText(model.Provider) ||
			utf8.RuneCountInString(model.Provider) > 256 {
			continue
		}
		ref := model.ProviderRef
		if ref == "" {
			ref = refs.physical(model.Provider)
		}
		key := ref + "\x00" + model.ID
		if seen[key] {
			continue
		}
		seen[key] = true
		matches = append(matches, resourceSearchItem{Kind: "model", ID: model.ID, Title: model.ID, ProviderRef: ref, ProviderLabel: model.Provider, Virtual: model.Virtual})
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].Title != matches[j].Title {
			return matches[i].Title < matches[j].Title
		}
		if matches[i].ProviderLabel != matches[j].ProviderLabel {
			return matches[i].ProviderLabel < matches[j].ProviderLabel
		}
		return matches[i].ProviderRef < matches[j].ProviderRef
	})
	if len(matches) > 10 {
		matches = matches[:10]
		group.Limited = true
	}
	group.Items = append(group.Items, matches...)
	return group
}
