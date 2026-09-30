package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

const maxProviderImpactRows = 1024

// ProviderImpactRead describes a bounded configuration scan, not a total count.
// Truncated also covers legacy fields too large or malformed to assess safely.
type ProviderImpactRead[T any] struct {
	Rows      []T
	Scanned   int
	Truncated bool
}

type ProviderImpactConfig struct {
	Name, FailoverGroup string
	Enabled             bool
}

type ProviderImpactReference struct {
	ID, Label, Provider, Model string
	Enabled                    bool
}

type ProviderImpactKey struct {
	Team                              string
	Status                            string
	AllowedProviders, DeniedProviders []string
	ExpiresAt, RevokedAt              time.Time
}

func impactText(column string, limit int) string {
	// Only compile-time column expressions are passed by the queries below.
	return fmt.Sprintf("SUBSTR(COALESCE(%s, ''), 1, %d)", column, limit+1)
}

func impactStringsWithin(limit int, values ...string) bool {
	for _, value := range values {
		if len(value) > limit || !utf8.ValidString(value) {
			return false
		}
	}
	return true
}

func readProviderImpact[T any](ctx context.Context, s *SQLStore, query string, args []any, limit int, scan func(*sql.Rows) (T, bool, error)) (ProviderImpactRead[T], error) {
	result := ProviderImpactRead[T]{Rows: []T{}}
	if limit < 1 || limit > maxProviderImpactRows {
		limit = maxProviderImpactRows
	}
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, s.bind(query+" LIMIT ?"), args...)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return ProviderImpactRead[T]{Rows: []T{}}, err
		}
		if result.Scanned == limit {
			result.Truncated = true
			break
		}
		result.Scanned++
		item, valid, err := scan(rows)
		if err != nil {
			return ProviderImpactRead[T]{Rows: []T{}}, err
		}
		if !valid {
			result.Truncated = true
			continue
		}
		result.Rows = append(result.Rows, item)
	}
	return result, rows.Err()
}

// ProviderImpactConfigs deliberately excludes URL, credentials and model catalogues.
// exactName restricts a target lookup; an empty name scans bounded peer configuration.
func (s *SQLStore) ProviderImpactConfigs(ctx context.Context, exactName string, limit int) (ProviderImpactRead[ProviderImpactConfig], error) {
	query := "SELECT " + impactText("name", 256) + ", " + impactText("failover_group", 256) + ", enabled FROM provider_configs"
	var args []any
	if exactName != "" {
		query += " WHERE name = ?"
		args = append(args, exactName)
	}
	query += " ORDER BY name ASC"
	return readProviderImpact(ctx, s, query, args, limit, func(rows *sql.Rows) (ProviderImpactConfig, bool, error) {
		var item ProviderImpactConfig
		var enabled int
		err := rows.Scan(&item.Name, &item.FailoverGroup, &enabled)
		item.Enabled = enabled == 1
		return item, impactStringsWithin(256, item.Name, item.FailoverGroup), err
	})
}

// ProviderImpactRoutingReferences reads bindings only, never rule notes or prompts.
// Matching uses the server's strings.TrimSpace semantics after this bounded scan;
// SQL TRIM/LOWER would not preserve the same Unicode behavior on both databases.
func (s *SQLStore) ProviderImpactRoutingReferences(ctx context.Context, limit int) (ProviderImpactRead[ProviderImpactReference], error) {
	query := "SELECT " + impactText("id", 256) + ", " + impactText("target_provider", 256) + ", " + impactText("target_model", 256) + ", enabled FROM routing_rules ORDER BY id ASC"
	return readProviderImpact(ctx, s, query, nil, limit, func(rows *sql.Rows) (ProviderImpactReference, bool, error) {
		var item ProviderImpactReference
		var enabled int
		err := rows.Scan(&item.ID, &item.Provider, &item.Model, &enabled)
		item.Enabled, item.Label = enabled == 1, item.ID
		return item, impactStringsWithin(256, item.ID, item.Provider, item.Model), err
	})
}

// ProviderImpactAgentReferences excludes system_prompt, tools and ownership data.
func (s *SQLStore) ProviderImpactAgentReferences(ctx context.Context, limit int) (ProviderImpactRead[ProviderImpactReference], error) {
	query := "SELECT " + impactText("id", 256) + ", " + impactText("virtual_model", 256) + ", " + impactText("provider", 256) + ", " + impactText("backing_model", 256) + ", enabled FROM agent_routes ORDER BY id ASC"
	return readProviderImpact(ctx, s, query, nil, limit, func(rows *sql.Rows) (ProviderImpactReference, bool, error) {
		var item ProviderImpactReference
		var enabled int
		err := rows.Scan(&item.ID, &item.Label, &item.Provider, &item.Model, &enabled)
		item.Enabled = enabled == 1
		return item, impactStringsWithin(256, item.ID, item.Label, item.Provider, item.Model), err
	})
}

func impactProviderPatterns(raw string) ([]string, bool) {
	var patterns []string
	if !impactStringsWithin(8192, raw) || json.Unmarshal([]byte(raw), &patterns) != nil || len(patterns) > 64 {
		return nil, false
	}
	if !impactStringsWithin(256, patterns...) {
		return nil, false
	}
	return patterns, true
}

func impactOptionalTime(raw string) (time.Time, bool) {
	parsed := parseOptionalTime(raw)
	return parsed, raw == "" || !parsed.IsZero()
}

// ProviderImpactKeys returns only the provider-access configuration required for
// candidate counts, not key IDs, names, hashes, secrets, IPs, owners or model lists.
func (s *SQLStore) ProviderImpactKeys(ctx context.Context, limit int) (ProviderImpactRead[ProviderImpactKey], error) {
	query := "SELECT " + strings.Join([]string{
		impactText("team", 256), impactText("status", 32), impactText("allowed_providers", 8192),
		impactText("denied_providers", 8192), impactText("expires_at", 64), impactText("revoked_at", 64),
	}, ", ") + " FROM api_keys ORDER BY id ASC"
	return readProviderImpact(ctx, s, query, nil, limit, func(rows *sql.Rows) (ProviderImpactKey, bool, error) {
		var item ProviderImpactKey
		var allowed, denied, expires, revoked string
		err := rows.Scan(&item.Team, &item.Status, &allowed, &denied, &expires, &revoked)
		// Legacy NULL/empty lists have the same unrestricted meaning as decodeStringList.
		if allowed == "" {
			allowed = "[]"
		}
		if denied == "" {
			denied = "[]"
		}
		var allowedOK, deniedOK, expiresOK, revokedOK bool
		item.AllowedProviders, allowedOK = impactProviderPatterns(allowed)
		item.DeniedProviders, deniedOK = impactProviderPatterns(denied)
		item.ExpiresAt, expiresOK = impactOptionalTime(expires)
		item.RevokedAt, revokedOK = impactOptionalTime(revoked)
		valid := impactStringsWithin(256, item.Team) && impactStringsWithin(32, item.Status) &&
			impactStringsWithin(64, expires, revoked) && allowedOK && deniedOK && expiresOK && revokedOK
		return item, valid, err
	})
}

// ProviderImpactTeams uses the existing ambiguity-aware team identity resolver
// against a bounded, read-only team snapshot. Unknown/ambiguous identities do not
// turn into new teams. A truncated team table cannot establish unique ownership.
func (s *SQLStore) ProviderImpactTeams(ctx context.Context, identities []string, limit int) (int, bool, error) {
	query := "SELECT " + impactText("id", 256) + ", " + impactText("name", 256) + " FROM teams ORDER BY id ASC"
	read, err := readProviderImpact(ctx, s, query, nil, limit, func(rows *sql.Rows) (AuthTeam, bool, error) {
		var team AuthTeam
		err := rows.Scan(&team.ID, &team.Name)
		return team, impactStringsWithin(256, team.ID, team.Name), err
	})
	if err != nil || read.Truncated {
		return 0, read.Truncated, err
	}
	index := teamIndex{byID: map[string]AuthTeam{}, all: read.Rows}
	for _, team := range read.Rows {
		if err := ctx.Err(); err != nil {
			return 0, false, err
		}
		index.byID[team.ID] = team
	}
	confirmed := map[string]struct{}{}
	partial := false
	seen := map[string]struct{}{}
	for _, identity := range identities {
		if err := ctx.Err(); err != nil {
			return 0, false, err
		}
		if _, found := seen[identity]; found {
			continue
		}
		seen[identity] = struct{}{}
		if identity == "" {
			continue
		} // unassigned keys are not a team
		if strings.TrimSpace(identity) != identity {
			partial = true
			continue
		}
		owners := teamIdentityOwners(index, identity)
		if len(owners) != 1 {
			partial = true
			continue
		}
		for id := range owners {
			confirmed[id] = struct{}{}
		}
	}
	return len(confirmed), partial, nil
}
