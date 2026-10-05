'use strict';

// Serves a checked-in test page on the loopback address, so it is reached over
// http like any other page rather than over file://.
//
//   npm run testpage            # tests dropdowns, menus and live regions
//   npm run testpage -- 8123    # on a port of your choosing
//   npm run coverage            # every supported kind of content and ARIA role
//   npm run coverage -- 8123
//
// http rather than file:// because the reader's own paths differ there —
// a file:// document has an opaque origin, its frames behave differently,
// and the point of a test page is to be as ordinary as possible.

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';

// The pages a name selects. A caller may also pass an absolute path, which is
// what lets a test serve a fixture of its own through this same server.
const PAGES = {
  testpage: path.join(__dirname, 'testpage.html'),
  coverage: path.join(__dirname, 'content-coverage.html'),
};

function pagePath(page) {
  if (!page) return PAGES.testpage;
  if (PAGES[page]) return PAGES[page];
  return page;
}

function start(port = 0, page = PAGES.testpage) {
  const file = pagePath(page);
  const server = http.createServer((req, res) => {
    let body = null;
    try {
      body = fs.readFileSync(file);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`cannot read ${file}: ${err.message}`);
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // The pages are edited while they are being read; a cached copy would
      // hide exactly the change under test.
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((resolve) => {
    server.listen(port, HOST, () => resolve({ server, url: `http://${HOST}:${server.address().port}/` }));
  });
}

// `--page` takes a checked-in name or a path; a bare number stays the port, so
// the existing `npm run testpage -- 8123` keeps working.
function parseArgs(argv) {
  const options = { port: 0, page: PAGES.testpage };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--page') { options.page = pagePath(argv[i + 1]); i += 1; }
    else if (arg.startsWith('--page=')) options.page = pagePath(arg.slice('--page='.length));
    else if (/^\d+$/.test(arg)) options.port = Number(arg);
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  start(options.port, options.page).then(({ url }) => {
    process.stdout.write(`${url}\n`);
  });
}

module.exports = { start, PAGES, pagePath, parseArgs };
