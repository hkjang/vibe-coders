package store

import (
	"context"
	"sort"
	"strings"
	"time"
)

// Caching the teams table.
//
// Authentication resolves every request's team to its canonical id and name, so the table
// is read once per request. It is operator-sized and changes when somebody creates or
// renames a team.
//
// See ttl_cache.go for how invalidation and the TTL divide the work. UpsertAuthTeam is the
// only write, and there is no delete.
//
// The lookup accepts either an id or a name, case-insensitively, with an id match winning.
// The cache keeps that precedence by consulting the id index first. Where two teams share a
// name in different cases the query's choice was unspecified — it had no ORDER BY beyond
// the id preference — and the cache resolves it to the lowest id, which is at least the
// same answer every time.
type teamCache struct {
	byKey cachedValue[teamIndex]
}

type teamIndex struct {
	byID   map[string]AuthTeam
	byName map[string]AuthTeam
	all    []AuthTeam
}

func (c *teamCache) invalidate() { c.byKey.clear() }

// AuthTeamByIDOrName resolves a team by its id or its name.
func (s *SQLStore) AuthTeamByIDOrName(ctx context.Context, value string) (AuthTeam, bool, error) {
	if value == "" {
		return AuthTeam{}, false, nil
	}
	index, err := s.authTeamIndex(ctx)
	if err != nil {
		return AuthTeam{}, false, err
	}
	if team, found := index.byID[value]; found {
		return team, true, nil
	}
	if team, found := index.byName[strings.ToLower(value)]; found {
		return team, true, nil
	}
	return AuthTeam{}, false, nil
}

// AuthTeamScopeIdentities returns exact api_keys.team values that unambiguously belong to
// the same team as value. A team's id may equal another team's display name because those
// columns are unique only independently; such an identity is unsafe for authorization and
// is omitted. An ambiguous or unknown caller identity fails closed.
func (s *SQLStore) AuthTeamScopeIdentities(ctx context.Context, value string) ([]string, bool, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, false, nil
	}
	index, err := s.authTeamIndex(ctx)
	if err != nil {
		return nil, false, err
	}
	callerOwners := teamIdentityOwners(index, value)
	if len(callerOwners) != 1 {
		return nil, false, nil
	}
	var target AuthTeam
	for _, team := range callerOwners {
		target = team
	}

	identities := make([]string, 0, 3)
	seen := make(map[string]struct{}, 3)
	for _, candidate := range []string{value, target.ID, target.Name} {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if _, exists := seen[candidate]; exists {
			continue
		}
		owners := teamIdentityOwners(index, candidate)
		if len(owners) != 1 {
			continue
		}
		if owner, ok := owners[target.ID]; !ok || owner.ID != target.ID {
			continue
		}
		seen[candidate] = struct{}{}
		identities = append(identities, candidate)
	}
	if len(identities) == 0 {
		return nil, false, nil
	}
	return identities, true, nil
}

func (s *SQLStore) authTeamIndex(ctx context.Context) (teamIndex, error) {
	now := time.Now()
	index, ok := s.teams.byKey.get(now)
	if !ok {
		gen := s.teams.byKey.begin()
		built, err := s.loadTeamIndex(ctx)
		if err != nil {
			return teamIndex{}, err
		}
		s.teams.byKey.putIfCurrent(built, gen, now)
		index = built
	}
	return index, nil
}

func teamIdentityOwners(index teamIndex, value string) map[string]AuthTeam {
	owners := make(map[string]AuthTeam, 2)
	if team, found := index.byID[value]; found {
		owners[team.ID] = team
	}
	for _, team := range index.all {
		if strings.EqualFold(team.Name, value) {
			owners[team.ID] = team
		}
	}
	return owners
}

func (s *SQLStore) loadTeamIndex(ctx context.Context) (teamIndex, error) {
	teams, err := s.ListAuthTeams(ctx)
	if err != nil {
		return teamIndex{}, err
	}
	// Sorted by id so a duplicated name resolves the same way on every instance and every
	// reload, rather than to whichever row the database happened to return first.
	sort.Slice(teams, func(i, j int) bool { return teams[i].ID < teams[j].ID })
	index := teamIndex{
		byID:   make(map[string]AuthTeam, len(teams)),
		byName: make(map[string]AuthTeam, len(teams)),
		all:    append([]AuthTeam(nil), teams...),
	}
	for _, team := range teams {
		index.byID[team.ID] = team
		lower := strings.ToLower(team.Name)
		if _, taken := index.byName[lower]; !taken {
			index.byName[lower] = team
		}
	}
	return index, nil
}
