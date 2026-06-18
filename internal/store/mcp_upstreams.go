package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

// MCPUpstream is a registered upstream MCP server that the gateway aggregates and
// routes to. EncryptedAuth holds an optional bearer token (encrypted at rest).
type MCPUpstream struct {
	ID            string              `json:"id"`   // slug, also the tool namespace prefix
	Name          string              `json:"name"` // display name
	URL           string              `json:"url"`  // Streamable HTTP MCP endpoint
	EncryptedAuth string              `json:"-"`
	HasAuth       bool                `json:"has_auth"`
	Enabled       bool                `json:"enabled"`
	CreatedAt     string              `json:"created_at"`
	Metadata      MCPUpstreamMetadata `json:"metadata"`
	MetadataJSON  string              `json:"-"`
}

// MCPUpstreamMetadata gives the model-name discovery router enough information
// to select relevant MCP servers without blindly calling every registered tool.
type MCPUpstreamMetadata struct {
	Description      string   `json:"description,omitempty"`
	Domains          []string `json:"domains,omitempty"`
	RiskLevel        string   `json:"risk_level,omitempty"` // low | medium | high | critical
	AllowedModels    []string `json:"allowed_models,omitempty"`
	DefaultTool      string   `json:"default_tool,omitempty"`
	TimeoutMS        int      `json:"timeout_ms,omitempty"`
	MaxResults       int      `json:"max_results,omitempty"`
	RequiresApproval bool     `json:"requires_approval,omitempty"`
	FallbackAllowed  bool     `json:"fallback_allowed,omitempty"`
}

func (s *SQLStore) ListMCPUpstreams(ctx context.Context) ([]MCPUpstream, error) {
	return s.queryMCPUpstreams(ctx, "")
}

func (s *SQLStore) ActiveMCPUpstreams(ctx context.Context) ([]MCPUpstream, error) {
	return s.queryMCPUpstreams(ctx, "WHERE enabled = 1")
}

func (s *SQLStore) queryMCPUpstreams(ctx context.Context, where string) ([]MCPUpstream, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, url, COALESCE(encrypted_auth, ''), enabled, created_at, COALESCE(metadata_json, '{}')
		FROM mcp_upstreams `+where+` ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MCPUpstream{}
	for rows.Next() {
		var u MCPUpstream
		var enabled int
		if err := rows.Scan(&u.ID, &u.Name, &u.URL, &u.EncryptedAuth, &enabled, &u.CreatedAt, &u.MetadataJSON); err != nil {
			return nil, err
		}
		u.Enabled = enabled == 1
		u.HasAuth = u.EncryptedAuth != ""
		u.Metadata = decodeMCPUpstreamMetadata(u.MetadataJSON)
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetMCPUpstream(ctx context.Context, id string) (MCPUpstream, bool, error) {
	var u MCPUpstream
	var enabled int
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, name, url, COALESCE(encrypted_auth, ''), enabled, created_at, COALESCE(metadata_json, '{}')
		FROM mcp_upstreams WHERE id = ?`), id).Scan(&u.ID, &u.Name, &u.URL, &u.EncryptedAuth, &enabled, &u.CreatedAt, &u.MetadataJSON)
	if err == sql.ErrNoRows {
		return MCPUpstream{}, false, nil
	}
	if err != nil {
		return MCPUpstream{}, false, err
	}
	u.Enabled = enabled == 1
	u.HasAuth = u.EncryptedAuth != ""
	u.Metadata = decodeMCPUpstreamMetadata(u.MetadataJSON)
	return u, true, nil
}

func (s *SQLStore) UpsertMCPUpstream(ctx context.Context, u MCPUpstream) error {
	if u.CreatedAt == "" {
		u.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	u.Metadata = normalizeMCPUpstreamMetadata(u.Metadata)
	if u.MetadataJSON == "" {
		u.MetadataJSON = encodeMCPUpstreamMetadata(u.Metadata)
	}
	enabled := 0
	if u.Enabled {
		enabled = 1
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO mcp_upstreams (id, name, url, encrypted_auth, enabled, created_at, metadata_json)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, encrypted_auth = excluded.encrypted_auth, enabled = excluded.enabled, metadata_json = excluded.metadata_json`),
		u.ID, u.Name, u.URL, u.EncryptedAuth, enabled, u.CreatedAt, u.MetadataJSON)
	return err
}

func (s *SQLStore) DeleteMCPUpstream(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM mcp_upstreams WHERE id = ?`), id)
	return err
}

func encodeMCPUpstreamMetadata(meta MCPUpstreamMetadata) string {
	b, _ := json.Marshal(normalizeMCPUpstreamMetadata(meta))
	if len(b) == 0 {
		return "{}"
	}
	return string(b)
}

func decodeMCPUpstreamMetadata(raw string) MCPUpstreamMetadata {
	if raw == "" {
		return MCPUpstreamMetadata{}
	}
	var meta MCPUpstreamMetadata
	_ = json.Unmarshal([]byte(raw), &meta)
	return normalizeMCPUpstreamMetadata(meta)
}

func normalizeMCPUpstreamMetadata(meta MCPUpstreamMetadata) MCPUpstreamMetadata {
	meta.Domains = cleanStringList(meta.Domains)
	meta.AllowedModels = cleanStringList(meta.AllowedModels)
	meta.RiskLevel = normalizeMCPRiskLevel(meta.RiskLevel)
	if meta.TimeoutMS < 0 {
		meta.TimeoutMS = 0
	}
	if meta.MaxResults < 0 {
		meta.MaxResults = 0
	}
	return meta
}

func cleanStringList(values []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func normalizeMCPRiskLevel(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "medium", "high", "critical":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "low"
	}
}
