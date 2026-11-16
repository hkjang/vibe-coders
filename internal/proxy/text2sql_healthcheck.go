package proxy

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"
)

// Null means not checked, never a failed check or a confirmed safeguard.
// Database/driver errors are deliberately not part of this response.
type text2SQLHealthcheck struct {
	Status                 string `json:"status"`
	Detail                 string `json:"detail"`
	DetailCode             string `json:"detail_code"`
	Configured             bool   `json:"configured"`
	Driver                 string `json:"driver"`
	StatementTimeout       string `json:"statement_timeout"`
	ConnectionID           string `json:"connection_id"`
	Reachable              *bool  `json:"reachable"`
	QueryOK                *bool  `json:"query_ok"`
	ReadOnlyTxOK           *bool  `json:"read_only_tx_ok"`
	StatementTimeoutOK     *bool  `json:"statement_timeout_ok"`
	AccountWriteRestricted *bool  `json:"account_write_restricted"`
	ProbeTimeout           string `json:"probe_timeout"`
}

func healthcheckBool(value bool) *bool { return &value }

// GET /admin/text2sql/healthcheck[?connection_id=ID]. Each explicit check opens
// the currently configured connection, independently of cached execution pools.
// It performs no DDL/DML and cannot establish account-wide write restrictions.
func (s *Server) handleText2SQLHealthcheck(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	cfg := s.t2sConf()
	id := strings.TrimSpace(r.URL.Query().Get("connection_id"))
	result := text2SQLHealthcheck{ConnectionID: id, StatementTimeout: cfg.StatementTimeout.String()}
	respond := func(status, code, detail string) {
		result.Status, result.DetailCode, result.Detail = status, code, detail
		writeJSON(w, http.StatusOK, result)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	driver, dsn := cfg.ExecDriver, cfg.ExecDSN
	if id != "" && id != "default" {
		connection, found, err := s.db.GetText2SQLExecConnection(ctx, id)
		if err != nil || !found || !connection.Enabled {
			respond("error", "connection_unavailable", "사용 가능한 연결 설정을 확인하지 못했습니다. 연결 등록과 활성 상태를 확인하세요.")
			return
		}
		driver = connection.Driver
		dsn, err = s.secrets.Load().Decrypt(connection.EncryptedDSN)
		if err != nil {
			respond("error", "connection_unavailable", "연결 설정을 읽지 못했습니다. 저장된 자격 증명과 암호화 설정을 확인하세요.")
			return
		}
	}
	driver = normalizeExecDriver(driver)
	switch driver {
	case "pgx":
		result.Driver = "postgres"
	case "sqlite", "mysql", "oracle":
		result.Driver = driver
	default:
		result.Driver = "unsupported"
		respond("error", "unsupported_driver", "지원하지 않는 연결 드라이버입니다. 연결 설정을 확인하세요.")
		return
	}
	result.Configured = strings.TrimSpace(dsn) != ""
	if !result.Configured {
		respond("preview_only", "not_configured", "실행 DB가 설정되지 않았습니다. SQL 미리보기만 사용할 수 있습니다.")
		return
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		respond("error", "connection_unavailable", "연결을 준비하지 못했습니다. 연결 문자열 형식과 자격 증명을 확인하세요.")
		return
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if err = db.PingContext(ctx); err != nil {
		result.Reachable = healthcheckBool(false)
		respond("error", "connection_failed", "DB에 연결하지 못했습니다. 주소, 네트워크와 자격 증명을 확인하세요.")
		return
	}
	result.Reachable = healthcheckBool(true)
	if driver != "pgx" {
		ok := text2SQLCheckBasicQuery(ctx, db, driver)
		result.QueryOK = healthcheckBool(ok)
		if !ok {
			respond("error", "query_failed", "연결은 되었지만 기본 조회에 실패했습니다. 조회 권한과 DB 상태를 확인하세요.")
			return
		}
		respond("warn", "partial_check", "연결과 기본 조회를 확인했습니다. 이 드라이버의 읽기 전용 트랜잭션, 서버 제한 시간과 계정 쓰기 권한은 확인하지 않았습니다.")
		return
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		result.ReadOnlyTxOK = healthcheckBool(false)
		respond("error", "read_only_failed", "읽기 전용 트랜잭션을 시작하지 못했습니다. DB 설정과 연결 권한을 확인하세요.")
		return
	}
	defer tx.Rollback()
	var readOnly string
	if err = tx.QueryRowContext(ctx, "SHOW transaction_read_only").Scan(&readOnly); err != nil || readOnly != "on" {
		result.ReadOnlyTxOK = healthcheckBool(false)
		respond("error", "read_only_failed", "읽기 전용 트랜잭션 상태를 확인하지 못했습니다. DB 설정을 확인하세요.")
		return
	}
	result.ReadOnlyTxOK = healthcheckBool(true)
	// This is the diagnostic transaction's limit, not the configured execution limit.
	result.ProbeTimeout = "1s"
	_, err = tx.ExecContext(ctx, "SET LOCAL statement_timeout = 1000")
	var timeout string
	timeoutOK := err == nil && tx.QueryRowContext(ctx, "SHOW statement_timeout").Scan(&timeout) == nil && (timeout == "1s" || timeout == "1000ms")
	result.StatementTimeoutOK = healthcheckBool(timeoutOK)
	if !timeoutOK {
		respond("error", "timeout_failed", "점검 트랜잭션의 제한 시간을 확인하지 못했습니다. DB 설정을 확인하세요.")
		return
	}
	var one int
	ok := tx.QueryRowContext(ctx, "SELECT 1").Scan(&one) == nil && one == 1
	result.QueryOK = healthcheckBool(ok)
	if !ok {
		respond("error", "query_failed", "읽기 전용 트랜잭션에서 기본 조회에 실패했습니다. 조회 권한과 DB 상태를 확인하세요.")
		return
	}
	respond("ok", "checks_passed", "연결, 읽기 전용 트랜잭션과 점검 제한 시간을 확인했습니다. 계정 전체의 쓰기 권한은 별도로 확인해야 합니다.")
}

// Oracle versions supported by the registered driver require a FROM clause for
// a constant expression. Other supported drivers accept the simple SELECT.
func text2SQLCheckBasicQuery(ctx context.Context, db *sql.DB, driver string) bool {
	query := "SELECT 1"
	if driver == "oracle" {
		query = "SELECT 1 FROM DUAL"
	}
	var one int
	return db.QueryRowContext(ctx, query).Scan(&one) == nil && one == 1
}
