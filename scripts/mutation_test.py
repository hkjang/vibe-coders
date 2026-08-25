#!/usr/bin/env python3
"""Find tests that pass while the code they cover is broken.

Every operator in a target file is flipped, one at a time, and the given tests are run
against the result. A mutation the tests still pass is a change to production code that
nothing noticed, which is either a gap in the tests or code that does not matter. Both are
worth knowing, and the two are told apart by reading the survivor — not by the tool.

    scripts/mutation_test.py internal/proxy/quota.go ./internal/proxy/ 'TestQuota|TestReserv'

Survivors are not automatically defects. Several kinds are expected:

  - equivalent mutants, where the flipped operator produces the same result anyway
    (`if d <= 0 { return 1 }` followed by `return int(d.Seconds()) + 1` is the same at zero);
  - unreachable guards, where the condition cannot hold given the callers;
  - branches that only change a log line.

What is worth acting on is a survivor that changes what the gateway does to a request.
Applied to the quota and governance paths this found: the cost limit's boundary untested
while the token limit's was, reservations still written after being switched off, approval
ids not checked against the user or team they were issued to, and a pending approval being
marked expired by the requester retrying.

Runs one `go test` per mutation, so scope the test filter to the area under test.
"""
import os
import subprocess
import sys

# Operator swaps that move a boundary or change a branch. Each is applied on its own.
SWAPS = [
    (">=", ">"), ("<=", "<"), (">", ">="), ("<", "<="),
    ("&&", "||"), ("||", "&&"),
    ("!= nil", "== nil"), ("== nil", "!= nil"),
]


def sites(text):
    """Every place an operator can be flipped, as (index, old, new)."""
    found = []
    for old, new in SWAPS:
        start = 0
        while True:
            i = text.find(old, start)
            if i < 0:
                break
            start = i + 1
            line_start = text.rfind("\n", 0, i) + 1
            line_end = text.find("\n", i)
            stripped = text[line_start:line_end].lstrip()
            if stripped.startswith("//") or stripped.startswith("*"):
                continue
            if old in (">", "<"):
                # Not part of >=, <=, <-, ->, or a shift.
                if text[i - 1] in "<>=!-" or text[i + 1] in "=-<>":
                    continue
            found.append((i, old, new))
    return found


def run(pkg, filter_):
    proc = subprocess.run(["go", "test", pkg, "-run", filter_, "-count=1"],
                          capture_output=True, text=True, timeout=1800)
    output = proc.stdout + proc.stderr
    if "build failed" in output or "cannot use" in output:
        return "BUILD"
    return "PASS" if proc.returncode == 0 else "FAIL"


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    targets, pkg, filter_ = sys.argv[1].split(","), sys.argv[2], sys.argv[3]

    survived, killed, uncompilable = [], 0, 0
    for path in targets:
        original = open(path, "rb").read()
        text = original.decode()
        for idx, old, new in sites(text):
            open(path, "wb").write((text[:idx] + new + text[idx + len(old):]).encode())
            try:
                verdict = run(pkg, filter_)
            finally:
                # Restored before anything else runs, including on Ctrl-C, so a killed
                # run never leaves mutated code behind.
                open(path, "wb").write(original)
            line_no = text.count("\n", 0, idx) + 1
            line = text[text.rfind("\n", 0, idx) + 1: text.find("\n", idx)].strip()
            if verdict == "BUILD":
                uncompilable += 1
            elif verdict == "FAIL":
                killed += 1
            else:
                survived.append((path, line_no, old, new, line[:110]))
            print(f"  {verdict:5s} {os.path.basename(path)}:{line_no} {old!r}->{new!r}", flush=True)

    print(f"\nkilled={killed} survived={len(survived)} uncompilable={uncompilable}")
    for path, line_no, old, new, line in survived:
        print(f"SURVIVED {path}:{line_no}  {old} -> {new}\n    {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
