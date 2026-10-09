module Tawb
  module FirefoxLaunch
    def self.profile_last_version(profile_dir : String) : String?
      text = File.read(File.join(profile_dir, "compatibility.ini"))
      /^LastVersion=([^\s_\/]+)/m.match(text).try(&.[1]?)
    rescue
      nil
    end

    def self.installed_version(executable : String) : String?
      begin
        app_dir = File.dirname(File.real_path(executable))
        text = File.read(File.join(app_dir, "platform.ini"))
        if found = /^Milestone=(\S+)/m.match(text)
          return found[1]
        end
      rescue
        # Ask the executable when its installation metadata is unavailable.
      end

      output = IO::Memory.new
      status = Process.run(executable, ["--version"],
        input: Process::Redirect::Close, output: output, error: Process::Redirect::Close)
      return nil unless status.success?
      /(\d+(?:\.\d+)+[^\s]*)/.match(output.to_s).try(&.[1]?)
    rescue
      nil
    end

    def self.require_compatible_profile(executable : String, name : String, profile_dir : String) : Nil
      wrote_it_last = profile_last_version(profile_dir)
      return unless wrote_it_last
      installed = installed_version(executable)
      return unless installed
      return unless first_version_is_newer(wrote_it_last, installed)

      raise IO::Error.new(
        "#{name} #{installed} at #{executable} cannot open #{profile_dir}: Firefox #{wrote_it_last} " +
        "used that profile last, and Firefox refuses to open a profile a newer Firefox has " +
        "written. It shows a warning on a screen nobody can see here and waits there, which is " +
        "why the launch times out with no output from the browser. " +
        "Install Firefox #{wrote_it_last} again, or move #{profile_dir} aside and let this session " +
        "make a new profile, or run `#{executable} --allow-downgrade -profile #{profile_dir}` " +
        "once yourself — which lets Firefox #{installed} keep the profile, and can lose what " +
        "Firefox #{wrote_it_last} saved in it."
      )
    end

    private def self.version_parts(text : String) : Array(Int32)?
      found = /^\d+(?:\.\d+)*/.match(text.strip)
      found.try(&.[0].split('.').map(&.to_i))
    end

    private def self.first_version_is_newer(candidate : String, against : String) : Bool
      left = version_parts(candidate)
      right = version_parts(against)
      return false unless left && right
      {left.size, right.size}.max.times do |index|
        mine = left[index]? || 0
        theirs = right[index]? || 0
        return true if mine > theirs
        return false if mine < theirs
      end
      false
    end
  end
end
