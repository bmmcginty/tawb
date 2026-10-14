require "json"

module Tawb
  # Identifies the source that produced this executable. Release builds can
  # inject a revision without carrying a checkout; source builds record Git at
  # compile time, and TAWB_COMMIT remains a runtime override for packagers.
  module Revision
    @@current : String? = nil

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
  end
end
