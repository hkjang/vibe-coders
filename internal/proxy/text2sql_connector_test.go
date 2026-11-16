package proxy

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"strings"
	"testing"
)

type text2sqlErrorConnector struct {
	err    error
	closed bool
}

func (c *text2sqlErrorConnector) Connect(context.Context) (driver.Conn, error) { return nil, c.err }
func (c *text2sqlErrorConnector) Driver() driver.Driver                        { return nil }
func (c *text2sqlErrorConnector) Close() error {
	c.closed = true
	return c.err
}

func TestText2SQLSafeConnectorRedactsConnectionAndCleanupErrors(t *testing.T) {
	const secret = "private-connector-sentinel"
	inner := &text2sqlErrorConnector{err: errors.New("password=" + secret)}
	db := sql.OpenDB(text2sqlSafeConnector{inner: inner})
	err := db.PingContext(t.Context())
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatal("connection failure must be reported without credentials")
	}
	err = db.Close()
	if !inner.closed || err == nil || strings.Contains(err.Error(), secret) {
		t.Fatal("pool closure must release connector resources without exposing credentials")
	}
}

func TestText2SQLSafeConnectorPreservesControlErrors(t *testing.T) {
	for _, cause := range []error{context.Canceled, context.DeadlineExceeded, driver.ErrBadConn} {
		t.Run(cause.Error(), func(t *testing.T) {
			inner := &text2sqlErrorConnector{err: fmt.Errorf("private-connector-sentinel: %w", cause)}
			_, err := (text2sqlSafeConnector{inner: inner}).Connect(t.Context())
			if err != cause {
				t.Fatal("control error identity must survive without the driver's message")
			}
		})
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := (text2sqlSafeConnector{inner: &text2sqlErrorConnector{err: errors.New("driver failure")}}).Connect(ctx)
	if err != context.Canceled {
		t.Fatal("request cancellation must survive opaque driver errors")
	}
}

func TestText2SQLSafeConnectorPreservesQueryErrors(t *testing.T) {
	db, err := openText2SQLPool("sqlite", ":memory:")
	if err != nil {
		t.Fatal("open SQLite fixture")
	}
	defer db.Close()
	_, err = db.ExecContext(t.Context(), "SELECT * FROM nonexistent_target_table")
	if err == nil || !strings.Contains(err.Error(), "nonexistent_target_table") {
		t.Fatal("SQL diagnostics must remain available after a successful connection")
	}
}
