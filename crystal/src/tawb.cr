require "./tawb/engine"
require "./tawb/cli"
require "./tawb/conformance"

if ARGV[0]? == "--conformance"
  operation = ARGV[1]? || raise ArgumentError.new("--conformance needs an operation")
  Tawb::Conformance.run(operation)
elsif ARGV[0]? == Tawb::Broker::INTERNAL_BROKER_ARG
  Tawb::Broker.run_process(ARGV[1..])
else
  Tawb::Cli.run
end
