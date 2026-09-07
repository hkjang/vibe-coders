package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

var ErrAuthIdentityUserConflict = errors.New("auth identity is linked to another user")

// AuthIdentity links an external SSO identity (provider + issuer + subject) to an internal
// user, so repeat logins resolve to the same account.
type AuthIdentity struct {
	ID                string `json:"id"`
	UserID            string `json:"user_id"`
	Provider          string `json:"provider"`
	Issuer            string `json:"issuer"`
	Subject           string `json:"subject"`
	Email             string `json:"email"`
	PreferredUsername string `json:"preferred_username"`
	CreatedAt         string `json:"created_at"`
	LastLoginAt       string `json:"last_login_at"`
	// IdPRole is the internal role an explicit claim mapping granted at the last login
	// ("" when the configured default applied). IdPTeam is the team the groups claim
	// granted then. Together they let a later login tell "the IdP withdrew this" from
	// "the IdP never said anything and an administrator assigned it locally".
	IdPRole string `json:"idp_role"`
	IdPTeam string `json:"idp_team"`
}

// AuthIdentityBySubject finds the internal linkage for an external (provider,issuer,subject).
func (s *SQLStore) AuthIdentityBySubject(ctx context.Context, provider, issuer, subject string) (AuthIdentity, bool, error) {
	var a AuthIdentity
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, user_id, provider, issuer, subject, email, preferred_username, created_at, COALESCE(last_login_at,''),
			COALESCE(idp_role,''), COALESCE(idp_team,'')
		FROM auth_identities WHERE provider = ? AND issuer = ? AND subject = ?`), provider, issuer, subject).
		Scan(&a.ID, &a.UserID, &a.Provider, &a.Issuer, &a.Subject, &a.Email, &a.PreferredUsername, &a.CreatedAt, &a.LastLoginAt, &a.IdPRole, &a.IdPTeam)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthIdentity{}, false, nil
	}
	if err != nil {
		return AuthIdentity{}, false, err
	}
	return a, true, nil
}

// UpsertAuthIdentity inserts or updates an identity by (provider,issuer,subject), refreshing
// email/username/last_login and preserving created_at + user_id.
func (s *SQLStore) UpsertAuthIdentity(ctx context.Context, a AuthIdentity) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if a.CreatedAt == "" {
		a.CreatedAt = now
	}
	if a.LastLoginAt == "" {
		a.LastLoginAt = now
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO auth_identities
		(id, user_id, provider, issuer, subject, email, preferred_username, created_at, last_login_at, idp_role, idp_team)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(provider, issuer, subject) DO UPDATE SET
			email = excluded.email, preferred_username = excluded.preferred_username, last_login_at = excluded.last_login_at,
			idp_role = excluded.idp_role, idp_team = excluded.idp_team`),
		a.ID, a.UserID, a.Provider, a.Issuer, a.Subject, a.Email, a.PreferredUsername, a.CreatedAt, a.LastLoginAt, a.IdPRole, a.IdPTeam)
	return err
}

// ProvisionAuthIdentity atomically creates or updates an SSO user, links the external
// identity, and — when syncTeam is set — replaces the user's team membership with teamID
// ("" removes it). A login whose groups claim never granted the current team passes
// syncTeam=false so a locally assigned team survives. Keeping these writes in one
// transaction prevents a failed team/identity write from leaving an unlinked user that can
// no longer complete a later login.
func (s *SQLStore) ProvisionAuthIdentity(ctx context.Context, user AuthUser, createUser bool, identity AuthIdentity, teamID string, syncTeam bool) error {
	now := time.Now().UTC()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if createUser {
		if user.CreatedAt.IsZero() {
			user.CreatedAt = now
		}
		if user.UpdatedAt.IsZero() {
			user.UpdatedAt = user.CreatedAt
		}
		if user.Status == "" {
			user.Status = "active"
		}
		if user.Role == "" {
			user.Role = "developer"
		}
		if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO users
			(id, email, password_hash, name, role, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
			user.ID, user.Email, user.PasswordHash, user.Name, user.Role, user.Status,
			formatTime(user.CreatedAt), formatTime(user.UpdatedAt)); err != nil {
			return err
		}
	} else {
		result, err := tx.ExecContext(ctx, s.bind(`UPDATE users SET
				role = CASE WHEN ? = '' THEN role ELSE ? END,
				status = CASE WHEN ? = '' THEN status ELSE ? END,
				updated_at = ?
			WHERE id = ?`), user.Role, user.Role, user.Status, user.Status, formatTime(now), user.ID)
		if err != nil {
			return err
		}
		if affected, err := result.RowsAffected(); err != nil {
			return err
		} else if affected != 1 {
			return ErrNotFound
		}
	}

	identity.UserID = user.ID
	if identity.CreatedAt == "" {
		identity.CreatedAt = now.Format(time.RFC3339Nano)
	}
	if identity.LastLoginAt == "" {
		identity.LastLoginAt = now.Format(time.RFC3339Nano)
	}
	result, err := tx.ExecContext(ctx, s.bind(`INSERT INTO auth_identities
		(id, user_id, provider, issuer, subject, email, preferred_username, created_at, last_login_at, idp_role, idp_team)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(provider, issuer, subject) DO UPDATE SET
			email = excluded.email,
			preferred_username = excluded.preferred_username,
			last_login_at = excluded.last_login_at,
			idp_role = excluded.idp_role,
			idp_team = excluded.idp_team
		WHERE auth_identities.user_id = excluded.user_id`),
		identity.ID, identity.UserID, identity.Provider, identity.Issuer, identity.Subject,
		identity.Email, identity.PreferredUsername, identity.CreatedAt, identity.LastLoginAt,
		identity.IdPRole, identity.IdPTeam)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return err
	} else if affected != 1 {
		return ErrAuthIdentityUserConflict
	}

	if !syncTeam {
		return tx.Commit()
	}
	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM user_team_memberships WHERE user_id = ?`), user.ID); err != nil {
		return err
	}
	if teamID != "" {
		if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO user_team_memberships (user_id, team_id, role, created_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(user_id, team_id) DO UPDATE SET role = excluded.role`),
			user.ID, teamID, "", formatTime(now)); err != nil {
			return err
		}
	}

	return tx.Commit()
}
