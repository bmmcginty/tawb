#!/usr/bin/env node
'use strict';

// The compiled executable has one filesystem entry point, but Firefox needs a
// broker process that can outlive the terminal reader. The parent restarts
// this executable with the private argument below; dispatch it before loading
// index.js, whose public option parser quite rightly rejects private options.
const { INTERNAL_BROKER_ARG, runBrokerProcess } = require('./broker');

if (process.argv[2] === INTERNAL_BROKER_ARG) {
  runBrokerProcess(process.argv.slice(3));
} else {
  require('./index').runCli();
}
