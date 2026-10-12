package proxy

import (
	"database/sql"
	"os"
	"testing"
)

func TestImpactFailureSQLiteConnectionUsesBusyTimeout(t *testing.T) {
	if os.Getenv("TEST_POSTGRES_DSN") != "" {
		t.Skip("SQLite connection policy; PostgreSQL does not use PRAGMA busy_timeout")
	}
	_, raw := impactFailureStore(t)
	first, err := raw.Conn(t.Context())
	if err != nil {
		t.Fatal("first fixture connection unavailable")
	}
	defer first.Close()
	second, err := raw.Conn(t.Context())
	if err != nil {
		t.Fatal("second fixture connection unavailable")
	}
	defer second.Close()
	for index, conn := range []*sql.Conn{first, second} {
		var timeout int
		if err := conn.QueryRowContext(t.Context(), "PRAGMA busy_timeout").Scan(&timeout); err != nil {
			t.Fatal("fixture lock policy unavailable")
		}
		if timeout != 10000 {
			t.Errorf("fixture connection %d has busy_timeout=%d, want SQLStore policy 10000", index, timeout)
		}
	}
}
