//go:build windows

package datadir

import (
	"errors"
	"io/fs"
)

func processIdentity() (int, int) {
	return -1, -1
}

func ownerIDs(fs.FileInfo) (int, int, bool) {
	return 0, 0, false
}

func ownerOf(fs.FileInfo) string {
	return ""
}

func platformSupportsRepair() error {
	return errors.New("repair-data-dir changes POSIX ownership and is only meaningful inside the Linux container image")
}
