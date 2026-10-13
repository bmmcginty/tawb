#!/bin/sh
# Run a command with nothing it starts left behind.
#
# A browser is launched detached — in a session and process group of its own —
# because it has to outlive the reader that asked to keep it. That is right for
# the product and wrong for a test run that is cut short: the browser has left
# the harness's process group, so signalling the group does not reach it, and
# the reader that would have closed it never got the chance. A run killed
# outright therefore leaves a browser, its renderers and its X server running,
# and the next run's rejoin cases fail against the leftovers.
#
# Nothing can clean up from inside the process that is being killed, and a
# process that detached itself cannot be reached by group at all. What it can
# be reached by is where it lives: every process a run starts names its
# temporary directory on its command line — the browser its profile, the
# private accessibility bus its socket. Giving the run a temporary directory of
# its own turns that into a handle on the whole tree, whatever group any part
# of it chose.
#
# So this runs the command with TMPDIR set to a directory of its own and, on
# the way out, kills every process that names it and every process group those
# processes lead. The directory is removed with them.
#
# The alternative, a process namespace whose init reaps everything when it
# exits, is stronger but needs privileges this does not: unshare(CLONE_NEWPID)
# is refused in the ordinary unprivileged case.
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

run_root=$(mktemp -d "${TMPDIR:-/tmp}/tawb-run-XXXXXXXX") || exit 1
export TMPDIR="$run_root"

# Kill everything the run left, then the directory it lived in.
#
# A process group is only signalled when it is not this shell's own. A browser
# leads one and its negative pid is what reaches its renderers and the X server
# beside it; a reader the test spawned does not lead one and is reached by pid
# alone, so a group shared with the harness is never signalled.
reaped=0
reap() {
  [ "$reaped" = 1 ] && return 0
  reaped=1
  set +e
  mine=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
  for entry in /proc/[0-9]*; do
    pid=${entry#/proc/}
    [ "$pid" = "$$" ] && continue
    [ -r "$entry/cmdline" ] || continue
    { tr '\0' '\n' < "$entry/cmdline" 2>/dev/null | grep -qF -- "$run_root"; } 2>/dev/null || continue
    group=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ -n "$group" ] && [ "$group" != "$mine" ]; then
      kill -9 -"$group" 2>/dev/null
    fi
    kill -9 "$pid" 2>/dev/null
  done
  rm -rf "$run_root"
}

# A signal has to stop the run, not just the process it was sent to. The test
# runner forks a worker per file, and that worker is what starts readers and
# browsers; killing the runner alone leaves the worker running, and a worker
# whose browser has just been taken out from under it starts another one. So
# the child's whole subtree goes first — the browsers that were detached from
# it are still its children in the process tree, whatever session they chose —
# and the reap then covers anything that had already been reparented away.
# The body is a subshell so each level has its own variables: a plain function
# would share `_target` with the recursive call, which would then kill the
# wrong process on the way back up and leave the top of the tree running.
kill_tree() (
  _target=$1
  for _child in $(pgrep -P "$_target" 2>/dev/null); do
    kill_tree "$_child"
  done
  kill -9 "$_target" 2>/dev/null || true
)

child=
interrupt() {
  # The signal handler must reach the end whatever individual kills report: a
  # process that has already exited makes `kill` fail, and `set -e` would then
  # skip the reap that is the whole point of being here.
  set +e
  [ -n "$child" ] && kill_tree "$child"
  reap
  exit 130
}

trap reap EXIT
trap interrupt HUP INT TERM

# The command runs in the background and is waited on, rather than replacing
# this shell. A shell does not run a signal handler while a foreground child is
# still running — it waits for the child first — so a foreground command would
# defer the reap until the very run being cut short had finished. `wait` is
# interrupted by a signal, which is what lets the handler run while there is
# still something to reap.
"$@" &
child=$!
status=0
wait "$child" || status=$?
exit "$status"
