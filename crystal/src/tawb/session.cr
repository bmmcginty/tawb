# The native port of src/session.js: which tab each running session is
# reading.
#
# Rejoining a browser adopts the tab it is already showing. That is right for
# one session and wrong for a second: it would take over the page the first
# session is reading, and the two would then fight — a navigation in one
# yanks the other out of whatever it was in the middle of.
#
# So every session records the tab it holds, keyed by the debugging port of
# the browser it holds it in, and a joining session skips tabs that another
# session still has. A record is only as good as the process that wrote it:
# a session killed outright leaves its claim behind, so claims are believed
# only while their process is still alive rather than trusted outright.

require "json"

module Tawb
  module Session
    # One record in a claims file: the reader that wrote it, the tab it held,
    # and when it said so.
    record Claim, pid : Int64, target_id : String, at : Int64

    def self.state_dir : String
      base = ENV["XDG_DATA_HOME"]?
      # JavaScript's `||` also rejects the empty string, not only an unset
      # variable; so does this.
      base = nil if base && base.empty?
      File.join(base || Path.home.join(".local", "share").to_s, "tawb")
    end

    def self.claims_path(port : Int32) : String
      File.join(state_dir, "tabs-#{port}.json")
    end

    # Whether a process id recorded earlier still belongs to a running
    # process.
    #
    # Signal 0 performs the permission and existence checks without
    # delivering anything. EPERM means the process is there and simply is not
    # ours, which still counts as running — only ESRCH means it is gone.
    #
    # This is src/proc.js's processAlive. It lives here, as the same file's
    # killProcessGroup lives in firefox_launch.cr and its detached spawn in
    # detach.cr, until a second consumer calls for a proc.cr of its own.
    private def self.process_alive?(pid : Int64) : Bool
      return false unless pid.in?(1..Int32::MAX)
      LibC.kill(pid.to_i32, 0) == 0 || Errno.value == Errno::EPERM
    end

    def self.read_claims(port : Int32) : Array(Claim)
      claims = [] of Claim
      raw = JSON.parse(File.read(claims_path(port)))
      return claims unless array = raw.as_a?
      array.each do |entry|
        next unless object = entry.as_h?
        next unless target_id = object["targetId"]?.try(&.as_s?)
        next unless pid = object["pid"]?.try(&.as_i64?)
        next unless process_alive?(pid)
        claims << Claim.new(
          pid: pid,
          target_id: target_id,
          at: object["at"]?.try(&.as_i64?) || 0_i64,
        )
      end
      claims
    rescue
      # A missing or unreadable file is a browser with no claims in it.
      [] of Claim
    end

    def self.write_claims(port : Int32, claims : Array(Claim)) : Nil
      Dir.mkdir_p(state_dir)
      File.write(claims_path(port), claims_json(claims), perm: File::Permissions.new(0o666))
    rescue
      # a lost claim costs a tab collision, not a crash
    end

    # The bytes JSON.stringify would write: records in file order, keys in
    # the order pid, targetId, at.
    private def self.claims_json(claims : Array(Claim)) : String
      JSON.build do |json|
        json.array do
          claims.each do |claim|
            json.object do
              json.field "pid", claim.pid
              json.field "targetId", claim.target_id
              json.field "at", claim.at
            end
          end
        end
      end
    end

    # The tabs other live sessions are reading, in file order. JavaScript
    # answered with a Set because its callers ask `has`; an array answers
    # `includes?` the same way, and keeps the two runtimes' answers comparable
    # in the differential suite.
    def self.claimed_targets(port : Int32) : Array(String)
      mine = Process.pid.to_i64
      read_claims(port).reject { |claim| claim.pid == mine }.map(&.target_id)
    end

    # Whether another live session is reading this browser.
    #
    # A browser this process started is not therefore this process's to shut
    # down: the reader who launched it is its first user, not its owner, and by
    # the time they quit there may be readers in it who never had a browser of
    # their own to lose. The claims say who is still there, and they are believed
    # exactly as far as the processes that wrote them.
    def self.other_readers_on(port : Int32) : Bool
      return false if port.zero?
      mine = Process.pid.to_i64
      read_claims(port).any? { |claim| claim.pid != mine }
    end

    def self.claim_tab(port : Int32, target_id : String) : Nil
      return if port.zero? || target_id.empty?
      mine = Process.pid.to_i64
      others = read_claims(port).reject { |claim| claim.pid == mine }
      others << Claim.new(pid: mine, target_id: target_id, at: Time.utc.to_unix_ms)
      write_claims(port, others)
    end

    def self.release_tab(port : Int32) : Nil
      return if port.zero?
      mine = Process.pid.to_i64
      write_claims(port, read_claims(port).reject { |claim| claim.pid == mine })
    end
  end
end
