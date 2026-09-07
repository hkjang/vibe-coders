//go:build !windows

package datadir

import (
	"fmt"
	"io/fs"
	"os"
	"syscall"
)

func processIdentity() (int, int) {
	return os.Geteuid(), os.Getegid()
}

func ownerIDs(info fs.FileInfo) (int, int, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, false
	}
	return int(st.Uid), int(st.Gid), true
}

func ownerOf(info fs.FileInfo) string {
	uid, gid, ok := ownerIDs(info)
	if !ok {
		return ""
	}
	return fmt.Sprintf("%d:%d", uid, gid)
}

func platformSupportsRepair() error {
	return nil
}
