package proxy

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"strings"
	"time"

	"vibe-coders/internal/config"
)

// A pool's driver and identity must describe the same connection for its entire
// lifetime. No plaintext DSN is retained in the cache metadata.
type text2sqlDBPool struct {
	db          *sql.DB
	driver      string
	fingerprint [32]byte
}

func (p *text2sqlDBPool) Close() error { return p.db.Close() }
func text2sqlPoolFingerprint(driver, dsn string) [32]byte {
	return sha256.Sum256([]byte(normalizeExecDriver(driver) + "\x00" + dsn))
}
func retireText2SQLPool(pool *text2sqlDBPool) {
	// Close prevents new use and releases idle connections. Existing operations
	// may finish; waiting for those must not hold the configuration mutex.
	if pool != nil {
		go func() { _ = pool.Close() }()
	}
}

// Read current stored configuration before using a named pool. This also sees
// changes made by other pods; cached credentials never bypass deletion/disable.
func (s *Server) text2sqlResolveDB(ctx context.Context, id string, validation bool) (*text2sqlDBPool, config.Text2SQLConfig, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	id = strings.TrimSpace(id)
	s.t2sPoolMu.Lock()
	var retired *text2sqlDBPool
	defer func() { s.t2sPoolMu.Unlock(); retireText2SQLPool(retired) }()
	cfg := s.t2sConf()
	if err := ctx.Err(); err != nil {
		return nil, cfg, err
	}
	driver, dsn := cfg.ExecDriver, cfg.ExecDSN
	named := id != "" && id != "default" && !validation
	cache := &s.t2sExec
	if validation && strings.TrimSpace(cfg.TwinDSN) != "" {
		driver, dsn = cfg.TwinDriver, cfg.TwinDSN
		cache = &s.t2sTwin
	}
	if named {
		conn, found, err := s.db.GetText2SQLExecConnection(ctx, id)
		if err != nil || !found || !conn.Enabled {
			retired = s.t2sExecConns[id]
			delete(s.t2sExecConns, id)
			return nil, cfg, errors.New("사용 가능한 실행 DB 연결 설정을 확인하지 못했습니다")
		}
		driver = conn.Driver
		dsn, err = s.secrets.Load().Decrypt(conn.EncryptedDSN)
		if err != nil {
			retired = s.t2sExecConns[id]
			delete(s.t2sExecConns, id)
			return nil, cfg, errors.New("실행 DB 자격 증명을 읽지 못했습니다")
		}
	}
	driver = normalizeExecDriver(driver)
	if strings.TrimSpace(dsn) == "" {
		if named {
			retired = s.t2sExecConns[id]
			delete(s.t2sExecConns, id)
		} else {
			retired = cache.Swap(nil)
		}
		return nil, cfg, errors.New("실행 DB 연결이 설정되지 않았습니다")
	}
	fingerprint := text2sqlPoolFingerprint(driver, dsn)
	pool := cache.Load()
	if named {
		pool = s.t2sExecConns[id]
	}
	if pool != nil && pool.fingerprint == fingerprint {
		return pool, cfg, nil
	}
	// Remove stale handles even if opening the replacement fails.
	retired = pool
	if named {
		delete(s.t2sExecConns, id)
	} else {
		cache.Store(nil)
	}
	db, err := openText2SQLPool(driver, dsn)
	if err != nil {
		return nil, cfg, errors.New("실행 DB 연결을 준비하지 못했습니다")
	}
	db.SetMaxOpenConns(4)
	pool = &text2sqlDBPool{db: db, driver: driver, fingerprint: fingerprint}
	if named {
		if s.t2sExecConns == nil {
			s.t2sExecConns = make(map[string]*text2sqlDBPool)
		}
		s.t2sExecConns[id] = pool
	} else {
		cache.Store(pool)
	}
	return pool, cfg, nil
}

func (s *Server) text2sqlExecDBByID(ctx context.Context, id string) (*sql.DB, error) {
	pool, _, err := s.text2sqlResolveDB(ctx, id, false)
	if err != nil {
		return nil, err
	}
	return pool.db, nil
}
func (s *Server) text2sqlExecDB() (*sql.DB, error) {
	return s.text2sqlExecDBByID(context.Background(), "")
}
func (s *Server) text2sqlValidationDB() (*sql.DB, string, error) {
	pool, _, err := s.text2sqlResolveDB(context.Background(), "", true)
	if err != nil {
		return nil, "", err
	}
	return pool.db, pool.driver, nil
}

// Local writes and cache publication share a lock. Remote writes are detected
// by the fresh registry read and connection fingerprint on every resolution.
func (s *Server) mutateText2SQLConnection(id string, change func() error) error {
	s.t2sPoolMu.Lock()
	err := change()
	var retired *text2sqlDBPool
	if err == nil {
		retired = s.t2sExecConns[id]
		delete(s.t2sExecConns, id)
	}
	s.t2sPoolMu.Unlock()
	retireText2SQLPool(retired)
	return err
}
func (s *Server) applyText2SQLRuntime(cfg config.Text2SQLConfig) {
	s.t2sPoolMu.Lock()
	s.t2sRuntime.Store(&cfg)
	var oldExec, oldTwin *text2sqlDBPool
	if p := s.t2sExec.Load(); p != nil && p.fingerprint != text2sqlPoolFingerprint(cfg.ExecDriver, cfg.ExecDSN) {
		oldExec = s.t2sExec.Swap(nil)
	}
	if p := s.t2sTwin.Load(); p != nil && p.fingerprint != text2sqlPoolFingerprint(cfg.TwinDriver, cfg.TwinDSN) {
		oldTwin = s.t2sTwin.Swap(nil)
	}
	s.t2sPoolMu.Unlock()
	retireText2SQLPool(oldExec)
	retireText2SQLPool(oldTwin)
}
