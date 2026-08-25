package store

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func seedTeam(t *testing.T, db *SQLStore, id, name string) {
	t.Helper()
	now := time.Now().UTC()
	if err := db.UpsertAuthTeam(context.Background(), AuthTeam{ID: id, Name: name, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("upsert %s: %v", id, err)
	}
}

// teamByQuery is what AuthTeamByIDOrName did before it was cached: the same predicate,
// straight to the database. The cache has to keep answering exactly this.
func teamByQuery(t *testing.T, db *SQLStore, value string) (AuthTeam, bool) {
	t.Helper()
	if value == "" {
		return AuthTeam{}, false
	}
	var team AuthTeam
	var createdAt, updatedAt string
	err := db.db.QueryRowContext(context.Background(), db.bind(`SELECT id, name, created_at, updated_at
		FROM teams
		WHERE id = ? OR LOWER(name) = LOWER(?)
		ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
		LIMIT 1`), value, value, value).Scan(&team.ID, &team.Name, &createdAt, &updatedAt)
	if err != nil {
		return AuthTeam{}, false
	}
	team.CreatedAt = parseOptionalTime(createdAt)
	team.UpdatedAt = parseOptionalTime(updatedAt)
	return team, true
}

// The cache answers by id first and by name second, case-insensitively — the precedence the
// query it replaced had. Resolving to the wrong team here changes which team a request is
// attributed to.
func TestAuthTeamLookupMatchesTheQueryItReplaced(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()

	seedTeam(t, db, "t_alpha", "Alpha")
	seedTeam(t, db, "t_beta", "beta")
	// A team whose *name* is another team's id: the id match has to win.
	seedTeam(t, db, "t_shadow", "t_alpha")

	for _, value := range []string{
		"t_alpha", "t_beta", "t_shadow",
		"Alpha", "alpha", "ALPHA", "beta", "BETA",
		"nobody", "", "t_gamma",
	} {
		wantTeam, wantFound := teamByQuery(t, db, value)
		gotTeam, gotFound, err := db.AuthTeamByIDOrName(context.Background(), value)
		if err != nil {
			t.Fatalf("%q: %v", value, err)
		}
		if gotFound != wantFound || gotTeam.ID != wantTeam.ID || gotTeam.Name != wantTeam.Name {
			t.Errorf("%q: cache gave (%q/%q found=%v), the query gives (%q/%q found=%v)",
				value, gotTeam.ID, gotTeam.Name, gotFound, wantTeam.ID, wantTeam.Name, wantFound)
		}
	}
}

// Proving the cache caches: change a name behind the store's back and expect the old one.
func TestAuthTeamLookupServesFromCache(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedTeam(t, db, "t1", "first")
	if got, ok, _ := db.AuthTeamByIDOrName(ctx, "t1"); !ok || got.Name != "first" {
		t.Fatalf("first read: %+v %v", got, ok)
	}
	if _, err := db.db.ExecContext(ctx, db.bind(`UPDATE teams SET name = ? WHERE id = ?`), "behind-its-back", "t1"); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := db.AuthTeamByIDOrName(ctx, "t1"); got.Name != "first" {
		t.Fatalf("second read went to the database instead of the cache: %q", got.Name)
	}
}

// A rename has to be visible at once: the name feeds governance rule conditions, so a stale
// one evaluates a policy against a team that no longer goes by it.
func TestTeamWritesTakeEffectImmediately(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedTeam(t, db, "t1", "first")
	if _, _, err := db.AuthTeamByIDOrName(ctx, "t1"); err != nil { // prime
		t.Fatal(err)
	}

	seedTeam(t, db, "t1", "renamed")
	got, ok, _ := db.AuthTeamByIDOrName(ctx, "t1")
	if !ok || got.Name != "renamed" {
		t.Fatalf("rename not visible: %+v", got)
	}
	if _, found, _ := db.AuthTeamByIDOrName(ctx, "renamed"); !found {
		t.Fatal("the new name does not resolve")
	}
	if _, found, _ := db.AuthTeamByIDOrName(ctx, "first"); found {
		t.Fatal("the old name still resolves")
	}

	seedTeam(t, db, "t2", "second")
	if _, found, _ := db.AuthTeamByIDOrName(ctx, "second"); !found {
		t.Fatal("a newly created team does not resolve")
	}
}

// Two teams sharing a name differing only in case: the query had no rule for which wins, so
// the cache picks the lowest id. What matters is that it is the same answer every time.
func TestDuplicateTeamNamesResolveStably(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedTeam(t, db, "t_b", "Dup")
	seedTeam(t, db, "t_a", "dup")

	first, _, _ := db.AuthTeamByIDOrName(ctx, "dup")
	if first.ID != "t_a" {
		t.Fatalf("expected the lowest id, got %q", first.ID)
	}
	for i := 0; i < 5; i++ {
		db.teams.invalidate()
		again, _, _ := db.AuthTeamByIDOrName(ctx, "DUP")
		if again.ID != first.ID {
			t.Fatalf("reload %d resolved to %q, first resolved to %q", i, again.ID, first.ID)
		}
	}
}

func TestAuthTeamLookupWithManyTeams(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	for i := 0; i < 50; i++ {
		seedTeam(t, db, fmt.Sprintf("t_%02d", i), fmt.Sprintf("team-%02d", i))
	}
	for i := 0; i < 50; i++ {
		byID, ok, _ := db.AuthTeamByIDOrName(ctx, fmt.Sprintf("t_%02d", i))
		if !ok || byID.Name != fmt.Sprintf("team-%02d", i) {
			t.Fatalf("id lookup %d: %+v %v", i, byID, ok)
		}
		byName, ok, _ := db.AuthTeamByIDOrName(ctx, fmt.Sprintf("TEAM-%02d", i))
		if !ok || byName.ID != fmt.Sprintf("t_%02d", i) {
			t.Fatalf("name lookup %d: %+v %v", i, byName, ok)
		}
	}
}
