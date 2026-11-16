package proxy

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
)

// database/sql and some registered drivers defer DSN parsing until Connect.
// Sanitize that boundary while preserving useful SQL execution errors and the
// standard driver's cancellation/invalid-connection semantics.
type text2sqlSafeConnector struct{ inner driver.Connector }

func (c text2sqlSafeConnector) Driver() driver.Driver { return c.inner.Driver() }
func (c text2sqlSafeConnector) Close() error {
	if closer, ok := c.inner.(io.Closer); ok {
		if err := closer.Close(); err != nil {
			return errors.New("실행 DB 연결 자원을 정리하지 못했습니다")
		}
	}
	return nil
}
func (c text2sqlSafeConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.inner.Connect(ctx)
	if err == nil {
		return conn, nil
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if errors.Is(err, context.Canceled) {
		return nil, context.Canceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return nil, context.DeadlineExceeded
	}
	if errors.Is(err, driver.ErrBadConn) {
		return nil, driver.ErrBadConn
	}
	return nil, errors.New("실행 DB에 연결하지 못했습니다. 연결 설정과 자격 증명을 확인하세요")
}

type text2sqlDSNConnector struct {
	inner driver.Driver
	dsn   string
}

func (c text2sqlDSNConnector) Driver() driver.Driver { return c.inner }
func (c text2sqlDSNConnector) Connect(ctx context.Context) (driver.Conn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return c.inner.Open(c.dsn)
}
func openText2SQLPool(driverName, dsn string) (*sql.DB, error) {
	// Use the standard registry to obtain the configured driver without opening
	// a network connection. The temporary sql.DB owns no live connections.
	probe, err := sql.Open(driverName, dsn)
	if err != nil {
		return nil, errors.New("실행 DB 연결을 준비하지 못했습니다")
	}
	registered := probe.Driver()
	_ = probe.Close()
	var connector driver.Connector = text2sqlDSNConnector{inner: registered, dsn: dsn}
	if contextual, ok := registered.(driver.DriverContext); ok {
		connector, err = contextual.OpenConnector(dsn)
		if err != nil {
			return nil, errors.New("실행 DB 연결을 준비하지 못했습니다")
		}
	}
	return sql.OpenDB(text2sqlSafeConnector{inner: connector}), nil
}
