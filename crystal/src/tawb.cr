require "./tawb/cli"
require "./tawb/conformance"

if ARGV[0]? == "--conformance"
  operation = ARGV[1]? || raise ArgumentError.new("--conformance needs an operation")
  Tawb::Conformance.run(operation)
else
  Tawb::Cli.run
end
