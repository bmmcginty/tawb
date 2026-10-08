require "./tawb/conformance"

if ARGV[0]? == "--conformance"
  operation = ARGV[1]? || raise ArgumentError.new("--conformance needs an operation")
  Tawb::Conformance.run(operation)
else
  STDERR.puts "The native Crystal reader is being ported incrementally and is not yet a runnable TAWB."
  exit 2
end
