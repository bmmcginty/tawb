'use strict';

// The browser's password prompt, answered here instead.
//
// A site that returns 401 with a WWW-Authenticate header does not produce a
// page. It produces a dialog drawn by browser chrome — outside the document,
// and so outside everything a reader of the accessibility tree can see. The
// engines let a client take that dialog over: Chromium through Fetch, Firefox
// through BiDi's authRequired phase. The drivers do that part; what is here
// is everything that is the same either way.
//
// One thing decides the shape of all of it: we hand over a *username and
// password*, never an Authorization header. The engine performs the scheme.
// Basic would be a base64 of the pair, but digest is a nonce, a client nonce,
// a request counter and two rounds of hashing per request (RFC 7616), and
// stale nonces restart it. Letting the network stack do that is why digest
// costs nothing here, and why NTLM and Negotiate work wherever the platform
// can do them at all.

// How many times one request may be refused before we stop answering it.
// Nothing stops the browser retrying on its own: given a password the server
// refuses, Chromium tries about thirty times and gives up with
// ERR_TOO_MANY_RETRIES, and Firefox goes round for ever. Both are a prompt
// loop the reader cannot escape unless the count is kept here.
const MAX_ATTEMPTS = 3;

// After this long, a request id is treated as naming a new request rather
// than a retry of the old one. Chromium's interception ids are a per-target
// counter — "interception-job-1.0" — so they do come round again on a tab
// that has been open a while, and a stale entry would otherwise make a fresh
// challenge look like a refusal.
const ROUND_MS = 30000;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return String(url || '');
  }
}

// The two protocols describe a challenge differently — Chromium names the
// source and the origin, BiDi gives a status and the request — so both are
// brought to one shape here and nothing downstream has to know which engine
// it is reading.
function normaliseChallenge(raw = {}) {
  const source = String(raw.source || 'server').toLowerCase() === 'proxy' ? 'proxy' : 'server';
  return {
    source,
    origin: raw.origin || originOf(raw.url),
    realm: raw.realm || '',
    scheme: String(raw.scheme || '').toLowerCase(),
    url: raw.url || '',
  };
}

// What a credential belongs to. A realm is the server's own name for a set of
// pages that share a password, so it belongs in the key: one site can protect
// two areas with two passwords, and answering the second with the first would
// be a failed sign-in the reader never asked for.
function challengeKey(challenge) {
  return `${challenge.source}|${challenge.origin}|${challenge.realm}`;
}

// The same, for a credential given for a whole origin rather than for a realm
// the reader was told about — which is what a url with a password in it is,
// since that form has no way to name a realm.
function originKey(challenge) {
  return `${challenge.source}|${challenge.origin}|`;
}

// Who is asking, in the words the reader needs.
//
// The origin, not the page: a challenge can come from an image or a frame
// belonging to somewhere else entirely, and telling someone they must sign in
// to the site they can see when the password is going somewhere else is the
// shape of every credential-phishing trick there is.
function describeChallenge(challenge) {
  const where = challenge.source === 'proxy'
    ? `the proxy at ${challenge.origin}`
    : challenge.origin;
  const realm = challenge.realm ? ` — "${challenge.realm}"` : '';
  const scheme = challenge.scheme ? ` (${challenge.scheme})` : '';
  return `${where}${realm}${scheme}`;
}

// A url may carry the credentials in it. Chrome strips that form from
// subresources and Firefox interrupts it with a confirmation of its own, so
// passing one through to the engine is unreliable; taking the pair out here
// and answering the challenge with it works everywhere, and keeps the
// password out of the address the session then goes on holding.
function splitCredentials(text) {
  const raw = String(text || '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { url: raw, username: null, password: null };
  }
  if (!url.username && !url.password) return { url: raw, username: null, password: null };
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  return { url: url.toString(), username, password };
}

// Holds what the reader has said, for as long as the session lasts and no
// longer. Nothing here is written to disk: a password that outlives the
// process is a decision for the person whose password it is, and this program
// has not been given anywhere to keep one.
class Credentials {
  constructor({ ask = null, log = () => {} } = {}) {
    // ask(challenge) resolves to { username, password }, or null for "the
    // reader declined". The front end supplies it: a prompt on the status
    // line for the reader, a form for edbrowse.
    this.ask = ask;
    this.log = log;
    this.known = new Map();
    this.denied = new Set();
    this.tries = new Map();
    // Prompts are asked one at a time. A page with several protected images
    // produces several challenges at once, and three prompts fighting over
    // one status line is not a thing a reader can answer.
    this.asking = Promise.resolve();
  }

  remember(raw, credentials) {
    const challenge = normaliseChallenge(raw);
    const key = challengeKey(challenge);
    this.known.set(key, credentials);
    this.denied.delete(key);
    return key;
  }

  forget(raw) {
    this.known.delete(challengeKey(normaliseChallenge(raw)));
  }

  // A deliberate navigation is the reader saying "try again": it is the only
  // way back for someone who escaped a prompt and then thought better of it.
  reconsider() {
    this.denied.clear();
  }

  #countTry(id) {
    const now = Date.now();
    const entry = this.tries.get(id);
    if (!entry || now - entry.at > ROUND_MS) {
      this.tries.set(id, { count: 1, at: now });
      return 1;
    }
    entry.count += 1;
    entry.at = now;
    return entry.count;
  }

  #prune() {
    if (this.tries.size < 64) return;
    const cutoff = Date.now() - ROUND_MS;
    for (const [id, entry] of this.tries) {
      if (entry.at < cutoff) this.tries.delete(id);
    }
  }

  // The answer to one challenge: credentials to hand the engine, or null to
  // cancel. Cancelling is not the same as failing — the 401's own body then
  // loads, which is frequently a page explaining what the realm is and how to
  // get an account.
  //
  // `id` names the request the browser is asking about, and is how a refusal
  // is told from a fresh request to the same realm: the engine retries the
  // same request id after a password it did not like, where a second image
  // from the same protected directory is a new one.
  async answer(raw, id = null) {
    const challenge = normaliseChallenge(raw);
    const key = challengeKey(challenge);

    const attempt = id == null ? 1 : this.#countTry(id);
    this.#prune();
    const refused = attempt > 1;

    if (refused) {
      // What we last gave for this realm is what the server just rejected.
      this.known.delete(key);
      this.known.delete(originKey(challenge));
      if (attempt > MAX_ATTEMPTS) {
        this.log('auth.giveup', { key, attempts: attempt - 1 });
        this.denied.add(key);
        return null;
      }
    }

    if (!refused) {
      const known = this.known.get(key) || this.known.get(originKey(challenge));
      if (known) return known;
      if (this.denied.has(key)) return null;
    }

    if (!this.ask) return null;

    // Serialised, and re-checked afterwards: while this prompt was on screen
    // the reader may have answered the same realm for another request, and
    // asking twice for one password is exactly what the queue is for.
    const answered = this.asking.then(async () => {
      if (!refused && this.known.has(key)) return this.known.get(key);
      const given = await this.ask(challenge, { refused, attempt });
      if (!given || !given.username) {
        this.denied.add(key);
        this.log('auth.declined', { key });
        return null;
      }
      this.known.set(key, { username: given.username, password: given.password || '' });
      this.log('auth.answered', { key, scheme: challenge.scheme, attempt });
      return this.known.get(key);
    });
    // The queue must survive a prompt that threw, or every later challenge
    // in the session inherits the rejection.
    this.asking = answered.catch(() => {});
    return answered;
  }
}

module.exports = {
  Credentials, normaliseChallenge, challengeKey, originKey, describeChallenge, splitCredentials,
  MAX_ATTEMPTS,
};
