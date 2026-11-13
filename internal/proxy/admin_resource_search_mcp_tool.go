package proxy

import "context"

func (s *Server) searchMCPToolNavigation(ctx context.Context, query string) resourceSearchGroup {
	group := resourceSearchGroup{Kind: "mcp_tool", Items: []resourceSearchItem{}, Status: "ok"}
	rows, more, err := s.db.SearchMCPToolMetadata(ctx, query, 10)
	if err != nil {
		group.Status = "unavailable"
		return group
	}
	group.Limited = more
	for _, row := range rows {
		if !s.safeResourceSearchText(row.ServerLabel) || !s.safeResourceSearchText(row.ToolName) {
			continue
		}
		group.Items = append(group.Items, resourceSearchItem{
			Kind: "mcp_tool", ID: row.ToolName, Title: row.ToolName, ServerLabel: row.ServerLabel,
		})
	}
	return group
}
