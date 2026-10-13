# Spawning something that has to outlive the terminal the reader was using.
#
# Two things the reader starts are not the reader's to take down with it: the
# browser, which `--keep-browser` leaves for the next session to rejoin, and
# the broker holding that browser's session. A terminal closing hangs up on
# everything that still has it as a controlling terminal, and a process group
# of one's own does not help: a group is still inside the session the pty
# belongs to. A session of one's own is what does, which is what JavaScript's
# `detached: true` arranges through setsid(2).
#
# Crystal's `Process.new` has no hook between the fork and the exec, and
# `Process.fork` is refused in a multithreaded build, so setsid(1) is the
# wrapper. It execs the program in place when its caller is not already a
# process group leader — which a child of `Process.new` never is — so the pid
# stays the one spawned here, and `kill(-pid)` still reaches the browser's
# whole group. Where setsid is not installed the child is merely put in its
# own process group, which still spares it a terminal's Ctrl+C.

module Tawb
  module Detach
    lib ProcessGroup
      fun setpgid(pid : LibC::PidT, pgid : LibC::PidT) : LibC::Int
    end

    # The spawned process, and whether it leads a process group of its own —
    # which is what a caller needs to know before signalling the group.
    record Spawned, process : Process, grouped : Bool

    # `env` is added to what this process already has, which is what a browser
    # needs: the accessibility bus is named in three variables and everything
    # else about the environment has to come through unchanged.
    def self.spawn(command : String, arguments : Array(String),
                   path : String = ENV["PATH"]? || "",
                   env : Hash(String, String)? = nil) : Spawned
      if setsid = which("setsid", path)
        process = Process.new(setsid, [command] + arguments,
          env: env,
          input: Process::Redirect::Close,
          output: Process::Redirect::Close,
          error: Process::Redirect::Close)
        # setsid(1) makes the child the leader of a new session and of a new
        # process group whose id is its pid, both before the exec.
        return Spawned.new(process, true)
      end

      process = Process.new(command, arguments,
        env: env,
        input: Process::Redirect::Close,
        output: Process::Redirect::Close,
        error: Process::Redirect::Close)
      # The group is won or lost in the race between this call and the child's
      # exec, so the answer is reported rather than assumed.
      Spawned.new(process, ProcessGroup.setpgid(process.pid, process.pid) == 0)
    end

    def self.which(command : String, path : String = ENV["PATH"]? || "") : String?
      path.split(':').each do |directory|
        next if directory.empty?
        candidate = File.join(directory, command)
        info = File.info?(candidate)
        return candidate if info && info.file? && File::Info.executable?(candidate)
      end
      nil
    end
  end
end
