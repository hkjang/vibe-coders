package proxy

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// ErrUnknownUser reports that no local account has the requested email.
var ErrUnknownUser = errors.New("no user with that email")

// AssignUserRole sets a local user's role from a maintenance command run against the
// data volume, for the case where no remaining administrator can do it from the console:
// for example every super_admin was demoted by an SSO login before v0.83.2. Existing
// sessions are revoked because their access tokens carry the old scopes, and the change
// is written to the auth audit trail like a console edit would be.
func AssignUserRole(ctx context.Context, db *store.SQLStore, email, role string) (store.AuthUser, error) {
	email = strings.TrimSpace(email)
	role = strings.TrimSpace(role)
	if email == "" {
		return store.AuthUser{}, errors.New("email is required")
	}
	if role == "" {
		return store.AuthUser{}, errors.New("role is required")
	}
	if !validRole(role) {
		if _, found, err := db.GetCustomRole(ctx, role); err != nil {
			return store.AuthUser{}, fmt.Errorf("look up custom role %q: %w", role, err)
		} else if !found {
			return store.AuthUser{}, fmt.Errorf("unknown role %q (built-in roles: %s)", role, strings.Join(builtinRoleNames(), ", "))
		}
	}
	user, found, err := db.AuthUserByEmail(ctx, email)
	if err != nil {
		return store.AuthUser{}, err
	}
	if !found {
		return store.AuthUser{}, fmt.Errorf("%w: %s", ErrUnknownUser, email)
	}
	if err := db.UpdateAuthUserRoleStatus(ctx, user.ID, role, ""); err != nil {
		return store.AuthUser{}, err
	}
	if err := db.RevokeAuthSessionsForUser(ctx, user.ID); err != nil {
		return store.AuthUser{}, fmt.Errorf("role updated but revoking sessions failed: %w", err)
	}
	_ = db.InsertAuditEvent(ctx, store.AuthEvent{
		ID:          newID("ae"),
		EventType:   "role_repaired",
		ActorUserID: user.ID,
		Detail:      "maintenance set-user-role: " + user.Role + " -> " + role + " for " + email,
		CreatedAt:   time.Now().UTC(),
	})
	user.Role = role
	return user, nil
}

func builtinRoleNames() []string {
	names := make([]string, 0, len(roleScopes))
	for name := range roleScopes {
		names = append(names, name)
	}
	sortStrings(names)
	return names
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
