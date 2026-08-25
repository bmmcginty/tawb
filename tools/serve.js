'use strict';

// Serves tools/testpage.html on the loopback address, so the test page is
// reached over http like any other page rather than over file://.
//
//   npm run testpage            # prints the URL and stays up
//   npm run testpage -- 8123    # on a port of your choosing
//
// http rather than file:// because the reader's own paths differ there —
// a file:// document has an opaque origin, its frames behave differently,
// and the point of a test page is to be as ordinary as possible.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, 'testpage.html');
const HOST = '127.0.0.1';

function start(port = 0) {
  const server = http.createServer((req, res) => {
    const body = fs.readFileSync(PAGE);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // The page is edited while it is being read; a cached copy would hide
      // exactly the change under test.
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((resolve) => {
    server.listen(port, HOST, () => resolve({ server, url: `http://${HOST}:${server.address().port}/` }));
  });
}

if (require.main === module) {
  start(Number(process.argv[2]) || 0).then(({ url }) => {
    process.stdout.write(`${url}\n`);
  });
}

module.exports = { start };
