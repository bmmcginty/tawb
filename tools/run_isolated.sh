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
# The strong form is a PID namespace of the run's own. The kernel destroys
# every process in a namespace when its init exits, whether init left by
# choice, by a catchable signal or by SIGKILL, so nothing has to be found and
# signalled: a browser that detached itself, the renderers under it, and any
# helper a session bus started inside the namespace are all gone together.
# `--kill-child` carries that through when this wrapper is killed rather than
# exiting, and `--map-current-user` keeps the real user id, so no path,
# permission or /run/user lookup changes and no passwd entry is needed. See
# `can_unshare` below; TAWB_NO_NAMESPACE=1 skips it.
#
# The namespace takes down processes, not files. The run's temporary directory
# still has to go, and the process that would remove it is the one being
# killed. So a guardian is started before the run in every case, outside the
# namespace: it waits on a pipe whose writing end only the run's shell holds,
# and when that close wakes it — on a clean exit, on a signal, or on a SIGKILL
# nothing could handle — it removes the directory. In the fallback it also
# finishes what the shell could not.
#
# The fallback is for a kernel or container that refuses the nested namespace.
# Nothing can clean up from inside the process that is being killed, and a
# process that detached itself cannot be reached by group at all. What it can
# be reached by is where it lives: every process a run starts carries the run's
# temporary directory — the browser on its command line as a profile, the rest
# in the environment — so the directory is a handle on the whole tree,
# whatever group any part of it chose. The guardian sweeps by that handle. It
# cannot see a helper that carries none of the run's environment, which is the
# reason the namespace is preferred; the guardian's retries close the race
# where a worker starts something as the run goes down.
set -eu

# Kill every process belonging to the run. A process is the run's if its
# command line names the run directory (a browser's profile, the accessibility
# bus's socket) or its environment has TMPDIR set to it (the readers and test
# workers, which name no path). The guardian is the one exception, because it
# is the process doing this.
#
# A process group is only signalled when it is not this shell's own. A browser
# leads one and its negative pid is what reaches its renderers and the X server
# beside it; a reader the test spawned does not lead one and is reached by pid
# alone, so a group shared with this shell is never signalled.
#
# `cat` opens the files rather than the shell redirecting them in: a process
# that is gone between the listing and the read is ordinary here, and the
# shell reports a failed `<` redirection to its own (unredirected) stderr,
# where `2>/dev/null` on the command does suppress `cat`'s.
sweep() {
  mine=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
  for entry in /proc/[0-9]*; do
    pid=${entry#/proc/}
    [ "$pid" = "$$" ] && continue
    cmd=$(cat "$entry/cmdline" 2>/dev/null | tr '\0' ' ')
    case $cmd in
      *--tawb-guardian*) continue ;;
    esac
    matched=0
    { printf '%s' "$cmd" | grep -qF -- "$run_root"; } 2>/dev/null && matched=1
    if [ "$matched" = 0 ]; then
      if cat "$entry/environ" 2>/dev/null | tr '\0' '\n' | grep -qxF -- "TMPDIR=$run_root"; then
        matched=1
      fi
    fi
    [ "$matched" = 1 ] || continue
    group=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ -n "$group" ] && [ "$group" != "$mine" ]; then
      kill -9 -"$group" 2>/dev/null
    fi
    kill -9 "$pid" 2>/dev/null
  done
}

# Sweep once, then remove the directory everything was tagged with. The guard
# keeps a clean exit and a signal from doing it twice.
reaped=0
reap() {
  [ "$reaped" = 1 ] && return 0
  reaped=1
  set +e
  sweep
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
# The sweep is what covers anything that had already been reparented away.
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

MODE=normal
case "${1:-}" in
  --tawb-guardian) MODE=guardian; shift ;;
  --tawb-inside)   MODE=inside; shift ;;
esac

# The guardian is this same script in a mode that outlives the run. It is
# started outside the namespace, so the namespace going down does not take it
# with it.
if [ "$MODE" = guardian ]; then
  run_root=$TMPDIR
  # The run's shell holds the only writing end of this pipe. Its close — on
  # exit, or on the SIGKILL nothing could handle — is what ends the wait.
  read _ < "$run_root/guardian" 2>/dev/null || true
  # Written by the fallback shell only. Inside the namespace the pids belong
  # to the namespace and mean nothing here, so there is no file and no tree to
  # walk; the namespace has already taken those processes down.
  child=$(cat "$run_root/child.pid" 2>/dev/null) || child=
  finish
  # The sweep above can miss a process a worker started in the same instant:
  # it was not there to be found, and the worker that would have started it is
  # already gone. The run directory is removed from the command lines by then,
  # but a process that already named it is still findable by its environment,
  # so a few more passes catch the ones that appeared as the run went down.
  tries=0
  while [ "$tries" -lt 6 ]; do
    sleep 0.5
    sweep
    tries=$((tries + 1))
  done
  rm -rf "$run_root"
  exit 0
fi

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

# Inside the namespace the namespace is the cleanup, whatever group a process
# chose. The run directory and the guardian pipe came from the shell that
# entered the namespace, so nothing is created here.
if [ "$MODE" = inside ]; then
  run_root=$TMPDIR
  trap finish EXIT
  trap 'finish; exit 130' HUP INT TERM
  "$@" 9>&- &
  child=$!
  status=0
  wait "$child" || status=$?
  exit "$status"
fi

# The namespace the kernel will give us, if it will give us one. The probe is
# the real thing — a user and PID namespace with a fresh proc — so a kernel or
# container that refuses the nested namespace is found here rather than after
# the run has already started.
can_unshare() {
  [ -z "${TAWB_NO_NAMESPACE:-}" ] || return 1
  command -v unshare >/dev/null 2>&1 || return 1
  unshare --map-current-user --pid --fork --mount-proc --kill-child=SIGKILL true >/dev/null 2>&1
}

run_root=$(mktemp -d "${TMPDIR:-/tmp}/tawb-run-XXXXXXXX") || exit 1
export TMPDIR="$run_root"
mkfifo "$run_root/guardian" || exit 1

# The shell's own end of the liveness pipe. The guardian and the command are
# given it closed, so neither keeps it from reporting this shell's death. It
# stays open across the `exec unshare` below and is inherited by the namespace's
# init, so the pipe closes when that init goes — by any means.
exec 9<>"$run_root/guardian"

trap finish EXIT
trap 'finish; exit 130' HUP INT TERM

# Detached into a session of its own and double-forked, so it is reparented to
# init: a harness that walks and kills its own descendants cannot take the
# guardian out before it has done its work. Started before the run so it is
# already watching before anything can outlive this shell.
( setsid "$0" --tawb-guardian 9>&- </dev/null >/dev/null 2>&1 & ) &

if can_unshare; then
  exec unshare --map-current-user --pid --fork --mount-proc --kill-child=SIGKILL \
    "$0" --tawb-inside "$@"
fi

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
