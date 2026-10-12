package store

import "context"

// Rotation is credential replacement, not a new spending allowance. All keys
// connected by durable rotation lineage share key-scoped quota definitions,
// committed usage and in-flight usage. UNION deduplicates both directions and
// terminates even if an imported lineage contains a cycle. Both edges use the
// old-key primary key / new-key unique index; no audit or key row is required.
const apiKeyQuotaFamilyCTE = `WITH RECURSIVE key_family(id) AS (
	SELECT CAST(? AS TEXT)
	UNION
	SELECT CASE WHEN r.old_key_id = f.id THEN r.new_key_id ELSE r.old_key_id END
	FROM api_key_rotations r JOIN key_family f ON r.old_key_id = f.id OR r.new_key_id = f.id
) `

func (s *SQLStore) apiKeyQuotaFamily(ctx context.Context, id string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(apiKeyQuotaFamilyCTE+`SELECT id FROM key_family ORDER BY id`), id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var family []string
	for rows.Next() {
		var member string
		if err := rows.Scan(&member); err != nil {
			return nil, err
		}
		family = append(family, member)
	}
	return family, rows.Err()
}
