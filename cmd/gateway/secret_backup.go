package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"vibe-coders/internal/secretbackup"
)

// This command deliberately ignores GATEWAY_SECRET and DB_DSN so an operator
// cannot accidentally inspect the live configuration instead of a backup.
func runVerifySecretBackup(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("verify-secret-backup", flag.ContinueOnError)
	fs.SetOutput(io.Discard) // Flag parsing errors may contain a pasted secret.
	sqlite := fs.String("sqlite", "", "standalone SQLite backup file")
	postgres := fs.Bool("postgres", false, "isolated restore from SECRET_BACKUP_POSTGRES_DSN")
	keyFile := fs.String("key-file", "", "file containing exact key bytes, without a newline")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || *keyFile == "" || (*sqlite != "") == *postgres {
		fmt.Fprintln(stderr, "사용법: gateway verify-secret-backup (--sqlite 백업파일 | --postgres) --key-file 키파일")
		fmt.Fprintln(stderr, "PostgreSQL은 격리 복원본의 SECRET_BACKUP_POSTGRES_DSN을 지정하세요. 키 파일은 줄바꿈 없이 원래 키의 바이트만 담아야 합니다.")
		return 2
	}
	key, err := readBackupKey(*keyFile)
	if err != nil {
		fmt.Fprintln(stderr, "키 파일을 읽을 수 없습니다. 비어 있지 않은 64KiB 이하의 일반 파일과 읽기 권한을 확인하세요.")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var report secretbackup.Report
	if *postgres {
		report, err = secretbackup.PostgreSQL(ctx, os.Getenv("SECRET_BACKUP_POSTGRES_DSN"), key)
	} else {
		report, err = secretbackup.SQLite(ctx, *sqlite, key)
	}
	if err != nil {
		fmt.Fprintln(stderr, "검사를 완료하지 못했습니다. 격리된 일관 백업, 스키마, 읽기 권한과 연결을 확인하세요. SQLite의 비어 있지 않은 WAL·저널은 허용하지 않습니다. 키가 맞는지는 판정하지 않았습니다.")
		return 3
	}
	if err := json.NewEncoder(stdout).Encode(report); err != nil {
		fmt.Fprintln(stderr, "검사 결과를 출력하지 못했습니다.")
		return 3
	}
	switch report.Status {
	case "matched":
		return 0
	case "mismatch":
		return 1
	default:
		return 3 // Empty stores cannot establish that this is the correct key.
	}
}

func readBackupKey(path string) (string, error) {
	before, err := os.Stat(path)
	if err != nil || !before.Mode().IsRegular() {
		return "", secretbackup.ErrBackup
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(before, info) || info.Size() <= 0 || info.Size() > 65536 {
		return "", secretbackup.ErrBackup
	}
	value, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil || len(value) == 0 || len(value) > 65536 {
		return "", secretbackup.ErrBackup
	}
	return string(value), nil
}
