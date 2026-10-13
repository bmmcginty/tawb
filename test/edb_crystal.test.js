'use strict';

// What the edbrowse server puts on edbrowse's screen, differenced between the
// JavaScript original and the Crystal port.
//
// This is the half that needs no browser: given tokens, what html comes out.
// That is most of the contract, because everything edbrowse can do with a page
// — g, i=, i*, ib, A, rf — depends on the markup being shaped the way edbrowse
// expects rather than the way the original page was. So the two
// implementations are compared on the html itself, byte for byte: a difference
// of one attribute is a difference in what the reader can do.

const test = require('node:test');
const assert = require('node:assert');

const { edbImplementations } = require('./crystal_impl');

const implementations = edbImplementations(require('../src/edb_server'));

const desc = (path, tag = 'a', name = '') => ({ tag, path, name });

// Every implementation renders the same tokens, and the html must match.
// Answered back so a test can also say what the html has to contain.
function render(what, tokens, { within = null, base = 'BASE', tab = 1 } = {}) {
  const extracted = { url: 'https://example.com/', title: 'T', tokens };
  const written = implementations.map((implementation) => ({
    name: implementation.name,
    html: implementation.tokensToHtml(extracted, base, tab, within),
  }));
  for (const other of written.slice(1)) {
    assert.equal(other.html, written[0].html, `${other.name} wrote ${what} differently`);
  }
  return written[0].html;
}

test('markup in page text cannot become markup in ours', () => {
  for (const implementation of implementations) {
    assert.equal(implementation.escapeHtml('<script>&"x"'), '&lt;script&gt;&amp;&quot;x&quot;');
  }
  const html = render('escaped text', [{ kind: 'text', text: '<b>not bold</b>' }]);
  assert.match(html, /&lt;b&gt;not bold/);
  assert.doesNotMatch(html, /<b>not bold/);
});

test('the address bar is one line, one field, one button', () => {
  // edbrowse numbers input fields within the current line, so on line 1 of any
  // tweb page `i=example.com` then `i*` works with no number to count out.
  const written = implementations.map((implementation) => ({
    name: implementation.name,
    bar: implementation.openBar('../open', false, 'https://example.com/'),
    withBack: implementation.openBar('open', true, ''),
  }));
  for (const other of written.slice(1)) {
    assert.equal(other.bar, written[0].bar, `${other.name} wrote the address bar differently`);
    assert.equal(other.withBack, written[0].withBack, `${other.name} wrote Back differently`);
  }
  assert.match(written[0].bar, /<input name="url" value="https:\/\/example\.com\/">/);
  assert.match(written[0].bar, /<input type="submit" name="go" value="Go">/);
  // Back is a link rather than a second submit button: a second button would
  // turn the address field's `i*` into `i2*`.
  assert.match(written[0].withBack, /<a href="back">Back<\/a>/);
  assert.doesNotMatch(written[0].bar, /Back/);
});

test('an ordinary link becomes an anchor naming its id', () => {
  const html = render('a link', [
    { kind: 'link', desc: desc('/a[0]'), name: 'Next', navigational: true },
  ]);
  assert.match(html, /<a href="e1">Next<\/a>/);
});

test('a non-navigational control inside a form becomes a submit button', () => {
  // Left as a link, edbrowse's g would activate it with the old field values
  // still in the page; as a submit, i* sends what was just typed.
  const html = render('a control inside a form', [
    { kind: 'form-open', desc: desc('/form[0]', 'form') },
    { kind: 'field', tag: 'input', type: 'text', desc: desc('/input[0]', 'input'), label: 'Q', value: '' },
    { kind: 'link', desc: desc('/div[1]', 'div'), name: 'Search', navigational: false },
    { kind: 'form-close' },
  ]);
  assert.match(html, /<input type="submit" name="e\d+" value="Search">/);
  assert.doesNotMatch(html, /<a href="e\d+">Search/);
});

test('a navigational link inside a form stays a link', () => {
  const html = render('a navigation inside a form', [
    { kind: 'form-open', desc: desc('/form[0]', 'form') },
    { kind: 'link', desc: desc('/a[0]'), name: 'Help', navigational: true },
    { kind: 'form-close' },
  ]);
  assert.match(html, /<a href="e\d+">Help<\/a>/);
});

test('a control behind a closed shadow root is pressed rather than followed', () => {
  // Following a link runs the element's own default action, which is useless
  // for a challenge: it is not a person pressing anything, and telling the
  // difference is the whole job of the thing behind a closed shadow root.
  const html = render('a pierced control', [
    { kind: 'link', desc: desc('/div[0]', 'div'), name: 'Verify', navigational: false, pierced: true },
  ]);
  assert.match(html, /<a href="e\d+\/click">Verify<\/a>/);
});

test('every control on a frame\'s own page is pressed rather than followed', () => {
  // A form on a frame's own page is not a form on the page edbrowse is
  // reading, so submitting it from there has nowhere to send the values.
  const html = render('a frame rendered on its own', [
    { kind: 'link', desc: desc('/div[0]', 'div'), name: 'Verify', navigational: false },
  ], { within: 7 });
  assert.match(html, /\/click">Verify<\/a>/);
});

test('a form with nothing to press is given something to press', () => {
  // Common on an application, where the page submits in script and the reader
  // is expected to press Enter.
  const html = render('a form with no submit', [
    { kind: 'form-open', desc: desc('/form[0]', 'form') },
    { kind: 'field', tag: 'input', type: 'text', desc: desc('/input[0]', 'input'), label: 'Q', value: '' },
    { kind: 'form-close' },
  ]);
  assert.match(html, /<input type="submit" name="e\d+" value="Submit">/);
});

test('a field with no form around it gets one of its own', () => {
  // edbrowse can only submit fields that are in a form, and a loose field is
  // the normal case on an application: the site collects it in script.
  const html = render('a loose field', [
    { kind: 'field', tag: 'input', type: 'text', desc: desc('/input[0]', 'input'), label: 'Search', value: 'cats' },
  ]);
  assert.match(html, /<form action="submit\/e\d+" method="post">/);
  assert.match(html, /<input type="submit" name="enter" value="Enter"><\/form>/);
  assert.match(html, /Search: <input type="text" name="e\d+" value="cats">/);
});

test('every kind of field is written the way edbrowse fills it in', () => {
  const html = render('one of each field', [
    { kind: 'form-open', desc: desc('/form[0]', 'form') },
    { kind: 'field', tag: 'input', type: 'text', desc: desc('/i[0]', 'input'), label: 'Name', value: 'a&b' },
    { kind: 'field', tag: 'input', type: 'password', desc: desc('/i[1]', 'input'), label: 'Pass', value: '' },
    { kind: 'field', tag: 'input', type: 'checkbox', desc: desc('/i[2]', 'input'), label: 'Keep', checked: true },
    { kind: 'field', tag: 'input', type: 'radio', desc: desc('/i[3]', 'input'), label: 'One', checked: false },
    { kind: 'field', tag: 'input', type: 'hidden', desc: desc('/i[4]', 'input'), label: 'csrf', value: 'x' },
    { kind: 'field', tag: 'textarea', type: 'textarea', desc: desc('/t[0]', 'textarea'), label: 'Body', value: 'hi' },
    {
      kind: 'field',
      tag: 'select',
      type: 'select',
      desc: desc('/s[0]', 'select'),
      label: 'Where',
      options: [
        { text: 'Here', selected: true, disabled: false },
        { text: 'There', selected: false, disabled: true },
      ],
    },
    { kind: 'field', tag: 'input', type: 'submit', desc: desc('/i[5]', 'input'), label: 'Go', value: 'Send' },
    { kind: 'form-close' },
  ]);
  assert.match(html, /Name: <input type="text" name="e\d+" value="a&amp;b">/);
  assert.match(html, /Pass: <input type="password" name="e\d+" value="">/);
  assert.match(html, /Keep: <input type="checkbox" name="e\d+" checked>/);
  assert.match(html, /One: <input type="radio" name="e\d+">/);
  assert.match(html, /Body: <textarea name="e\d+">hi<\/textarea>/);
  assert.match(html, /Where: <select name="e\d+"><option selected>Here<\/option><option disabled>There<\/option><\/select>/);
  assert.match(html, /<input type="submit" name="e\d+" value="Send">/);
  // A hidden field is nothing a reader can fill in, so it is nothing in the
  // buffer either.
  assert.doesNotMatch(html, /csrf/);
});

test('a checkbox behind a closed shadow root is offered a real press', () => {
  const html = render('a pierced checkbox', [
    {
      kind: 'field', tag: 'input', type: 'checkbox', desc: desc('/i[0]', 'input'),
      label: 'Verify', checked: false, pierced: true,
    },
  ]);
  assert.match(html, /<a href="e\d+\/click">press Verify<\/a>/);
});

test('a frame is a line that can be followed to a page of its own', () => {
  const html = render('a frame', [
    { kind: 'frame', desc: desc('/iframe[0]', 'iframe'), name: 'comments' },
  ]);
  assert.match(html, /<p><a href="f\d+">\[frame: comments\]<\/a><\/p>/);
});

test('a frame already given an id keeps it', () => {
  // The walk hands out a frame's id before descending, because the id is what
  // the frame's contents are recorded as living in.
  const html = render('a frame with an id', [
    { kind: 'frame', desc: desc('/iframe[0]', 'iframe'), name: 'comments', frameId: 42 },
  ]);
  assert.match(html, /<a href="f42">/);
});

test('the header names the page and the other four representations', () => {
  const html = render('the header', [{ kind: 'text', text: 'hello' }]);
  // edbrowse's own fu would only show the loopback address this server answers
  // on, so the page says which page it really is.
  assert.match(html, /<p>tweb 1: https:\/\/example\.com\//);
  for (const view of ['ax', 'render', 'inspect', 'source']) {
    assert.ok(html.includes(`<a href="${view}">`), `the header does not reach ${view}`);
  }
  assert.match(html, /<a href="\.\.\/tabs">tabs<\/a>/);
  assert.match(html, /<base href="BASE">/);
});

test('the open and close tokens edbrowse renders well are kept as they are', () => {
  const html = render('structure', [
    { kind: 'open', tag: 'ul' },
    { kind: 'open', tag: 'li' },
    { kind: 'text', text: 'one' },
    { kind: 'close', tag: 'li' },
    { kind: 'close', tag: 'ul' },
    { kind: 'image', text: 'a cat' },
  ]);
  assert.match(html, /<ul>\n<li>\none\n<\/li>\n<\/ul>/);
  assert.match(html, /<img alt="a cat">/);
});

test('the four line lists are preformatted so edbrowse leaves them alone', () => {
  const written = implementations.map((implementation) => ({
    name: implementation.name,
    html: implementation.linesToHtml('Accessibility tree — tab 1', 'BASE',
      'Accessibility tree', ['heading Example', 'link <Next>'], 'https://example.com/'),
  }));
  for (const other of written.slice(1)) {
    assert.equal(other.html, written[0].html, `${other.name} wrote a line list differently`);
  }
  assert.match(written[0].html, /<pre>\nheading Example\nlink &lt;Next&gt;\n<\/pre>/);
  assert.match(written[0].html, /<a href="\.\/">the page<\/a>/);
});

test('what the reader typed becomes an address, a search, or an admission', () => {
  const cases = [
    'example.com',
    'https://example.com/path',
    'localhost:8080',
    '127.0.0.1',
    'something.local',
    'two words here',
    'nothostlike',
    '',
    null,
  ];
  for (const typed of cases) {
    const answers = implementations.map((implementation) => ({
      name: implementation.name,
      target: implementation.normaliseTarget(typed),
    }));
    for (const other of answers.slice(1)) {
      assert.deepEqual(
        other.target,
        answers[0].target,
        `${other.name} read "${typed}" differently`,
      );
    }
  }
  const [first] = implementations;
  // A page is a place a reader can leave and come back to, and a redirect they
  // did not ask for is one they cannot undo — so something that is not an
  // address is offered as a search rather than searched for.
  assert.equal(first.normaliseTarget('example.com').url, 'https://example.com');
  assert.equal(first.normaliseTarget('two words here').search, 'two words here');
  assert.ok(first.normaliseTarget('').error);
});

test('a failure is explained in the sentence a person would say', () => {
  const cases = [
    'Target page, context or browser has been closed',
    'Cannot navigate to invalid URL',
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_CONNECTION_REFUSED',
    'Timeout 30000ms exceeded',
    'something nobody anticipated',
  ];
  for (const message of cases) {
    const said = implementations.map((implementation) => ({
      name: implementation.name,
      text: implementation.explain(message),
    }));
    for (const other of said.slice(1)) {
      assert.equal(other.text, said[0].text, `${other.name} explained "${message}" differently`);
    }
  }
  // Anything not recognised is passed through unchanged: a message that was
  // not anticipated is still better than one that was invented.
  assert.equal(implementations[0].explain('something nobody anticipated'),
    'something nobody anticipated');
});
