package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/proxy"
	"vibe-coders/internal/store"
)

// runSetUserRole restores a local account's role straight from the data volume:
//
//	docker run --rm --mount source=proxy-gateway-data,target=/data --env-file gateway.env \
//	    IMAGE set-user-role --email admin@example.com --role super_admin
//
// It exists for the lock-out case where no administrator is left who could change the
// role in the console. Database settings come from the same DB_DRIVER/DB_DSN the gateway
// itself uses, so the env file that runs the gateway also runs this command.
func runSetUserRole(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("set-user-role", flag.ContinueOnError)
	fs.SetOutput(stderr)
	email := fs.String("email", "", "email of the local account to change")
	role := fs.String("role", "", "role to assign (built-in such as super_admin, or a custom role)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 0 {
		fmt.Fprintf(stderr, "unexpected arguments: %v\n", fs.Args())
		return 2
	}
	if *email == "" || *role == "" {
		fmt.Fprintln(stderr, "--email and --role are required")
		fs.PrintDefaults()
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dbCfg := config.DatabaseFromEnv()
	db, err := store.Open(ctx, dbCfg)
	if err != nil {
		fmt.Fprintf(stderr, "open database (%s): %v\n", dbCfg.Driver, err)
		return 1
	}
	defer db.Close()
	user, err := proxy.AssignUserRole(ctx, db, *email, *role)
	if err != nil {
		fmt.Fprintln(stderr, err)
		if errors.Is(err, proxy.ErrUnknownUser) {
			return 1
		}
		return 1
	}
	fmt.Fprintf(stdout, "role of %s (%s) is now %s; existing sessions were revoked, sign in again\n", user.Email, user.ID, user.Role)
	return 0
}
