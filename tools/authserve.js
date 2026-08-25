'use strict';

// A server that asks for a password, so the auth path can be exercised
// against a real browser rather than described.
//
//     npm run authpage             # prints the URL and stays up
//     npm run authpage -- 8124     # on a port of your choosing
//
// Three protected places, because they are three different problems:
//
//   /basic       Basic, the easy one.
//   /digest      Digest, which is the reason we hand credentials to the
//                engine rather than building an Authorization header: the
//                response below is a nonce/cnonce/nc/qop computation, and
//                anything that gets it wrong is refused here exactly as a
//                real server refuses it.
//   /page-with-image   a public document whose <img> is protected. The
//                challenge then belongs to a subresource, and the reader has
//                to be told which origin is asking rather than which page
//                they were on.
//
// The credentials are fixed and printed on the index page; there is nothing
// here worth protecting, only a challenge worth answering.

const crypto = require('crypto');
const http = require('http');

const HOST = '127.0.0.1';
const USER = process.env.TWEB_AUTH_USER || 'reader';
const PASSWORD = process.env.TWEB_AUTH_PASSWORD || 'opensesame';
const REALM = 'Staff area';

const md5 = (text) => crypto.createHash('md5').update(text).digest('hex');

// A 1x1 gif, so /page-with-image has something real to fetch.
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64',
);

// Digest's parameters arrive as a comma-separated list of key=value, where
// the value may or may not be quoted. Splitting on commas is wrong for a
// quoted value containing one, so this walks the pairs instead.
function parseAuthParams(header) {
  const params = {};
  const pattern = /(\w+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
  let match = pattern.exec(header);
  while (match) {
    params[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
    match = pattern.exec(header);
  }
  return params;
}

function basicOk(header) {
  if (!/^Basic /i.test(header || '')) return false;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const at = decoded.indexOf(':');
  return at > 0 && decoded.slice(0, at) === USER && decoded.slice(at + 1) === PASSWORD;
}

// The nonce is signed with a per-process key rather than remembered, so the
// server holds no state and restarting it does not strand a browser holding a
// nonce we have forgotten.
const NONCE_KEY = crypto.randomBytes(16);
function makeNonce() {
  const stamp = Date.now().toString(16);
  return `${stamp}:${crypto.createHmac('sha256', NONCE_KEY).update(stamp).digest('hex').slice(0, 24)}`;
}
function nonceIsOurs(nonce) {
  const [stamp, signature] = String(nonce).split(':');
  if (!stamp || !signature) return false;
  return crypto.createHmac('sha256', NONCE_KEY).update(stamp).digest('hex').slice(0, 24) === signature;
}

function digestOk(header, method) {
  if (!/^Digest /i.test(header || '')) return false;
  const p = parseAuthParams(header.slice(7));
  if (p.username !== USER || p.realm !== REALM || !nonceIsOurs(p.nonce)) return false;
  const ha1 = md5(`${USER}:${REALM}:${PASSWORD}`);
  const ha2 = md5(`${method}:${p.uri}`);
  const expected = p.qop
    ? md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`)
    : md5(`${ha1}:${p.nonce}:${ha2}`);
  return p.response === expected;
}

function challenge(res, scheme) {
  const header = scheme === 'digest'
    ? `Digest realm="${REALM}", qop="auth", nonce="${makeNonce()}", opaque="${md5(REALM)}", algorithm=MD5`
    : `Basic realm="${REALM}", charset="UTF-8"`;
  res.writeHead(401, {
    'www-authenticate': header,
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end('<!doctype html><meta charset="utf-8"><title>401</title>'
    + '<h1>Unauthorized</h1><p>This is the body the server sends with its challenge. '
    + 'A reader who cancels the prompt should end up reading this.</p>');
}

function html(res, title, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>${body}`);
}

function start(port = 0) {
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    const header = req.headers.authorization || '';

    if (path === '/basic') {
      if (!basicOk(header)) return challenge(res, 'basic');
      return html(res, 'basic', `<h1>Basic area</h1><p>Signed in as ${USER}.</p>`);
    }

    if (path === '/digest') {
      if (!digestOk(header, req.method)) return challenge(res, 'digest');
      return html(res, 'digest', `<h1>Digest area</h1><p>Signed in as ${USER}.</p>`);
    }

    if (path === '/pixel.gif') {
      if (!basicOk(header)) return challenge(res, 'basic');
      res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
      return res.end(PIXEL);
    }

    if (path === '/page-with-image') {
      return html(res, 'page with a protected image',
        '<h1>Public page</h1><p>The image below is not public.</p>'
        + '<img src="/pixel.gif" alt="protected pixel">');
    }

    return html(res, 'auth test server',
      `<h1>Auth test server</h1><p>User <b>${USER}</b>, password <b>${PASSWORD}</b>.</p>`
      + '<ul><li><a href="/basic">basic</a></li>'
      + '<li><a href="/digest">digest</a></li>'
      + '<li><a href="/page-with-image">a page whose image is protected</a></li></ul>');
  });

  return new Promise((resolve) => {
    server.listen(port, HOST, () => resolve({
      server, url: `http://${HOST}:${server.address().port}/`, user: USER, password: PASSWORD, realm: REALM,
    }));
  });
}

if (require.main === module) {
  start(Number(process.argv[2]) || 0).then(({ url }) => process.stdout.write(`${url}\n`));
}

module.exports = { start, USER, PASSWORD, REALM };
