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
# be reached by is where it lives: every process a run starts carries the run's
# temporary directory — the browser on its command line as a profile, the rest
# in the environment — so giving the run a temporary directory of its own turns
# that into a handle on the whole tree, whatever group any part of it chose.
#
# SIGKILL cannot be caught, so this shell cannot do that cleanup for every way
# a run ends. A second process that is not in the killed set can, so one is
# started before the run: a detached guardian that waits for the shell to go
# and then finishes the job. It is told the shell is gone by a pipe whose
# writing end only the shell holds, so the shell closing it — on a clean exit,
# on a signal, or on a SIGKILL nothing could handle — wakes the guardian. See
# `--guardian` below.
#
# The stronger form, a process namespace whose init reaps everything when it
# exits, needs unshare(CLONE_NEWPID), which is refused in the ordinary
# unprivileged case.
set -eu

# Kill every process belonging to the run, then remove the directory it lived
# in. A process is the run's if its command line names the run directory (a
# browser's profile, the accessibility bus's socket) or its environment has
# TMPDIR set to it (the readers and test workers, which name no path). The
# guardian is the one exception, because it is the process doing this.
#
# A process group is only signalled when it is not this shell's own. A browser
# leads one and its negative pid is what reaches its renderers and the X server
# beside it; a reader the test spawned does not lead one and is reached by pid
# alone, so a group shared with this shell is never signalled.
reaped=0
reap() {
  [ "$reaped" = 1 ] && return 0
  reaped=1
  set +e
  mine=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
  for entry in /proc/[0-9]*; do
    pid=${entry#/proc/}
    [ "$pid" = "$$" ] && continue
    cmd=$(tr '\0' ' ' < "$entry/cmdline" 2>/dev/null)
    case $cmd in
      *--tawb-guardian*) continue ;;
    esac
    matched=0
    { printf '%s' "$cmd" | grep -qF -- "$run_root"; } 2>/dev/null && matched=1
    if [ "$matched" = 0 ]; then
      { tr '\0' '\n' < "$entry/environ" 2>/dev/null | grep -qxF -- "TMPDIR=$run_root"; } 2>/dev/null && matched=1
    fi
    [ "$matched" = 1 ] || continue
    group=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ -n "$group" ] && [ "$group" != "$mine" ]; then
      kill -9 -"$group" 2>/dev/null
    fi
    kill -9 "$pid" 2>/dev/null
  done
  rm -rf "$run_root"
}

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

# Stop the run, then clear what it left. The run's process tree is taken down
# from its root first: the test runner's per-file worker is what starts readers
# and browsers, and a worker whose browser has just been killed starts another.
# The reap is what covers anything that had already been reparented away.
finished=0
finish() {
  [ "$finished" = 1 ] && return 0
  finished=1
  set +e
  if [ -n "${child:-}" ]; then
    kill_tree "$child"
  fi
  reap
}

# The guardian is this same script in a mode that outlives the shell.
if [ "${1:-}" = "--tawb-guardian" ]; then
  run_root=$TMPDIR
  # The shell holds the only writing end of this pipe. Its close — on exit, or
  # on the SIGKILL nothing could handle — is what ends the wait.
  read _ < "$run_root/guardian" 2>/dev/null || true
  child=$(cat "$run_root/child.pid" 2>/dev/null) || child=
  finish
  exit 0
fi

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

run_root=$(mktemp -d "${TMPDIR:-/tmp}/tawb-run-XXXXXXXX") || exit 1
export TMPDIR="$run_root"
mkfifo "$run_root/guardian" || exit 1

# The shell's own end of the liveness pipe. The guardian and the command are
# given it closed, so neither keeps it from reporting this shell's death.
exec 9<>"$run_root/guardian"

trap finish EXIT
trap 'finish; exit 130' HUP INT TERM

# Detached into a session of its own, which is what lets it survive a SIGKILL
# aimed at this process or at its group. Started before the run so it is
# already watching before anything can outlive this shell.
setsid "$0" --tawb-guardian 9>&- </dev/null >/dev/null 2>&1 &

# The command runs in the background and is waited on, rather than replacing
# this shell. A shell does not run a signal handler while a foreground child is
# still running — it waits for the child first — so a foreground command would
# defer the cleanup until the very run being cut short had finished. `wait` is
# interrupted by a signal, which is what lets the handler run while there is
# still something to clean up.
"$@" 9>&- &
child=$!
echo "$child" > "$run_root/child.pid"

status=0
wait "$child" || status=$?
exit "$status"
