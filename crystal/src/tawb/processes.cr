module Tawb
  # The two things this program needs to know about somebody else's process:
  # whether it is still there, and how to take it and everything it brought
  # with it down.
  #
  # This is `src/proc.js`, minus the parts only the test tooling uses. It was
  # written out in `session.cr` when there was one consumer; the browser
  # registry is the second, which is what that note said would bring this
  # file into being.
  module Processes
    # Whether a process id recorded earlier still belongs to a running
    # process.
    #
    # Signal 0 performs the permission and existence checks without
    # delivering anything. EPERM means the process is there and simply is not
    # ours, which still counts as running — only ESRCH means it is gone.
    def self.alive?(pid : Int64?) : Bool
      return false unless pid && pid.in?(1..Int32::MAX)
      LibC.kill(pid.to_i32, 0) == 0 || Errno.value == Errno::EPERM
    end

    # Take down a browser and everything it brought with it.
    #
    # A browser is not one process. Chromium is a main process, a zygote, a
    # GPU process and one per tab; Firefox is a parent and a content process
    # per site; and with no display either is under an xvfb-run wrapper as
    # well. They are all in the process group the launch made for them, which
    # is what is signalled here.
    def self.kill_group(pid : Int64?, signal : Signal = Signal::TERM) : Bool
      return false unless pid && pid.in?(1..Int32::MAX)
      return true if LibC.kill(-pid.to_i32, signal.value) == 0
      return false if Errno.value == Errno::ESRCH
      # Not a group leader after all — spawned without a session of its own,
      # or already reaped. The process itself is still worth the signal.
      LibC.kill(pid.to_i32, signal.value) == 0
    end
  end
end
