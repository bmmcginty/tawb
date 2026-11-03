require "json"

module Tawb
  # Identifies the source that produced this executable. Release builds can
  # inject a revision without carrying a checkout; source builds record Git at
  # compile time, and TAWB_COMMIT remains a runtime override for packagers.
  module Revision
    @@current : String? = nil

    # What `--version` says, decided when the executable is built because the
    # executable is what carries it: the version alone on the commit that was
    # released, and the version plus that commit and when it was made anywhere
    # else. `tools/version.py revision` is the one implementation of that rule;
    # `tools/build_crystal.sh` has no part in it, so a bare `crystal build`
    # records the same thing a release build does.
    SUMMARY = {{ `python3 #{__DIR__}/../../../tools/version.py revision 2>/dev/null || true`.strip.stringify }}
    VERSION_FILE = {{ read_file("#{__DIR__}/../../../version.yml").stringify }}

    HASH = /^[0-9a-f]{7,64}$/i
    BUILT_REVISION = {{ (env("TAWB_BUILD_COMMIT") || "").stringify }}
    GIT_REVISION   = {{ `git rev-parse --verify HEAD 2>/dev/null`.strip.stringify }}
    PACKAGE = {{ read_file("#{__DIR__}/../../../package.json").stringify }}

    def self.resolve(env : Hash(String, String) = ENV.to_h,
                     built_revision : String = BUILT_REVISION,
                     git_revision : String = GIT_REVISION,
                     package_text : String = PACKAGE) : String
      supplied = env["TAWB_COMMIT"]?.try(&.strip) || ""
      return supplied if HASH.matches?(supplied)

      built = built_revision.strip
      return built if HASH.matches?(built)

      git = git_revision.strip
      return git if HASH.matches?(git)

      package_revision = begin
        JSON.parse(package_text).as_h["gitHead"]?.try(&.as_s?).try(&.strip) || ""
      rescue
        ""
      end
      return package_revision if HASH.matches?(package_revision)
      "unknown"
    end

    def self.current : String
      @@current ||= resolve
    end

    # The version, with the commit when this build is not the release itself.
    # Git answers while the tree is there to be asked; without it — an unpacked
    # source archive, a package — version.yml still says which version this is.
    def self.summary : String
      baked = SUMMARY.strip
      return baked unless baked.empty? || baked == "unknown"
      line = VERSION_FILE.lines.find(&.starts_with?("version:"))
      line.try(&.split(':', 2).last.strip) || "unknown"
    end

    # The release number alone, without the commit suffix a development build
    # carries. The update check compares this with the latest release tag.
    def self.version : String
      summary.split.first? || "unknown"
    end
  end
end
