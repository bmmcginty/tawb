'use strict';

const { Transform } = require('node:stream');

// Node's test runner exits successfully when tests skip. That is useful for
// the ordinary cross-environment suite, but a parity gate must not silently
// turn missing browsers or tools into a green run. Use this as a second
// reporter so the primary reporter still owns normal test output.
module.exports = class FailOnSkipsReporter extends Transform {
  constructor() {
    super({ writableObjectMode: true });
    this.skips = [];
  }

  _transform(event, encoding, callback) {
    if ((event.type === 'test:pass' || event.type === 'test:fail') && event.data.skip) {
      this.skips.push(event.data.name);
    }
    callback();
  }

  _flush(callback) {
    if (this.skips.length > 0) {
      process.exitCode = 1;
      this.push(`Unexpected skipped tests (${this.skips.length}):\n`);
      for (const name of this.skips) this.push(`- ${name}\n`);
    }
    callback();
  }
};
