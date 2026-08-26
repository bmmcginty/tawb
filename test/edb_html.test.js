'use strict';

// What the edbrowse server promises to put on edbrowse's screen.
//
// These are the parts that need no browser: given tokens, what html comes
// out. That is most of the contract, because everything edbrowse can do with
// a page — g, i=, i*, ib, A, rf — depends on the markup being shaped the way
// edbrowse expects rather than the way the original page was.

const test = require('node:test');
const assert = require('node:assert');

const {
  tokensToHtml, linesToHtml, Registry, escapeHtml, normaliseTarget, explain, openBar,
} = require('../src/edb_server');

const desc = (path, tag = 'a', name = '') => ({ tag, path, name });
const render = (tokens, registry = new Registry()) =>
  tokensToHtml({ url: 'https://example.com/', title: 'T', tokens }, registry, 'BASE', 1);

test('escaping', async (t) => {
  await t.test('markup in page text cannot become markup in ours', () => {
    assert.equal(escapeHtml('<script>&"x"'), '&lt;script&gt;&amp;&quot;x&quot;');
  });

  await t.test('text tokens are escaped', () => {
    const html = render([{ kind: 'text', text: '<b>not bold</b>' }]);
    assert.match(html, /&lt;b&gt;not bold/);
    assert.doesNotMatch(html, /<b>not bold/);
  });
});

test('links', async (t) => {
  await t.test('an ordinary link becomes an anchor naming its id', () => {
    const html = render([{ kind: 'link', desc: desc('/a[0]'), name: 'Next', navigational: true }]);
    assert.match(html, /<a href="e1">Next<\/a>/);
  });

  await t.test('a non-navigational control inside a form becomes a submit button', () => {
    // Left as a link, edbrowse's g would activate it with the old field
    // values still in the page; as a submit, i* sends what was just typed.
    const html = render([
      { kind: 'form-open', desc: desc('/form[0]', 'form') },
      { kind: 'field', tag: 'input', type: 'text', desc: desc('/input[0]', 'input'), label: 'Q', value: '' },
      { kind: 'link', desc: desc('/div[1]', 'div'), name: 'Search', navigational: false },
      { kind: 'form-close' },
    ]);
    assert.match(html, /<input type="submit" name="e\d+" value="Search">/);
    assert.doesNotMatch(html, /<a href="e\d+">Search/);
  });

  await t.test('a navigational link inside a form stays a link', () => {
    const html = render([
      { kind: 'form-open', desc: desc('/form[0]', 'form') },
      { kind: 'link', desc: desc('/a[0]'), name: 'Help', navigational: true },
      { kind: 'form-close' },
    ]);
    assert.match(html, /<a href="e\d+">Help<\/a>/);
  });
});

test('fields', async (t) => {
  await t.test('a select carries every option, and marks the chosen one', () => {
    const html = render([{
      kind: 'field', tag: 'select', desc: desc('/select[0]', 'select'), label: 'Country', value: '',
      options: [
        { text: 'Ukraine', selected: false, disabled: false },
        { text: 'United States', selected: true, disabled: false },
        { text: 'Uruguay', selected: false, disabled: true },
      ],
    }]);
    assert.match(html, /<select name="e1">/);
    assert.match(html, /<option>Ukraine<\/option>/);
    assert.match(html, /<option selected>United States<\/option>/);
    assert.match(html, /<option disabled>Uruguay<\/option>/);
  });

  await t.test('a field with no form around it gets one of its own', () => {
    // The normal case on an application: the site collects the value in
    // script. edbrowse can only submit fields that are inside a form.
    const html = render([{
      kind: 'field', tag: 'input', type: 'text', desc: desc('/input[0]', 'input'),
      label: 'Search', value: '',
    }]);
    assert.match(html, /<form action="submit\/e\d+" method="post">/);
    assert.match(html, /<input type="submit" name="enter" value="Enter"><\/form>/);
  });

  await t.test('a form with no submit button of its own is given one', () => {
    const html = render([
      { kind: 'form-open', desc: desc('/form[0]', 'form') },
      { kind: 'field', tag: 'input', type: 'text', desc: desc('/input[0]', 'input'), label: 'Q', value: '' },
      { kind: 'form-close' },
    ]);
    assert.match(html, /<input type="submit" name="e\d+" value="Submit">/);
  });

  await t.test('checkbox state survives', () => {
    const html = render([{
      kind: 'field', tag: 'input', type: 'checkbox', desc: desc('/input[0]', 'input'),
      label: 'Agree', value: '', checked: true,
    }]);
    assert.match(html, /<input type="checkbox" name="e1" checked>/);
  });

  await t.test('a password field stays a password field', () => {
    const html = render([{
      kind: 'field', tag: 'input', type: 'password', desc: desc('/input[0]', 'input'),
      label: 'Pass', value: 'hunter2',
    }]);
    assert.match(html, /type="password"/);
  });

  await t.test('a hidden field contributes nothing to read', () => {
    const html = render([{
      kind: 'field', tag: 'input', type: 'hidden', desc: desc('/input[0]', 'input'),
      label: '', value: 'token',
    }]);
    assert.doesNotMatch(html, /token/);
  });
});

test('what edbrowse cannot work by filling in a form', async (t) => {
  // A control behind a closed shadow root cannot be ticked by setting a
  // property on it — a bot check ignores that, because it can see nobody
  // pressed anything — and a form on a frame's own page has nowhere to send
  // its values. Both get a plain link as well, which edbrowse can follow.
  const checkbox = (extra = {}) => ({
    kind: 'field', tag: 'input', type: 'checkbox', desc: desc('/input[0]', 'input'),
    label: 'Verify you are human', value: '', ...extra,
  });

  await t.test('an ordinary checkbox is left as a checkbox', () => {
    const html = render([checkbox()]);
    assert.doesNotMatch(html, /press/);
  });

  await t.test('one behind a closed shadow root gets a link that presses it', () => {
    const html = render([checkbox({ pierced: true })]);
    assert.match(html, /<a href="e1\/click">press Verify you are human<\/a>/);
  });

  await t.test('every control on a frame page gets one', () => {
    const registry = new Registry();
    const html = tokensToHtml(
      { url: 'x', title: 'x', tokens: [checkbox()] }, registry, 'BASE', 1, 7,
    );
    assert.match(html, /<a href="e1\/click">press/);
  });

  await t.test('a link behind a closed shadow root really presses what it names', () => {
    // The default action is not a person pressing anything, and the thing
    // behind a closed shadow root is usually there to tell the difference.
    const html = render([
      { kind: 'link', desc: desc('/div[0]', 'div'), name: 'Verify you are human', navigational: false, pierced: true },
    ]);
    assert.match(html, /<a href="e1\/click">Verify you are human<\/a>/);
  });

  await t.test('an ordinary link is left alone', () => {
    const html = render([{ kind: 'link', desc: desc('/a[0]'), name: 'Next', navigational: true }]);
    assert.match(html, /<a href="e1">Next<\/a>/);
  });

  await t.test('a form that cannot be submitted from here offers its own control', () => {
    const html = render([
      { kind: 'form-open', desc: desc('/form[0]', 'form'), pierced: true },
      { kind: 'field', tag: 'input', type: 'text', desc: desc('/input[0]', 'input'), label: 'Q', value: '' },
      { kind: 'field', tag: 'input', type: 'submit', desc: desc('/input[1]', 'input'), label: '', value: 'Go' },
      { kind: 'form-close' },
    ]);
    assert.match(html, /<a href="e\d+\/click">press Go<\/a>/);
  });
});

test('an id says which document its element is in', async (t) => {
  await t.test('the same path in two documents is not the same element', () => {
    const registry = new Registry();
    const one = registry.idFor(desc('/input[0]', 'input', 'Q'), 'field', null);
    const other = registry.idFor(desc('/input[0]', 'input', 'Q'), 'field', 7);
    assert.notEqual(one, other);
  });

  await t.test('and the record remembers which', () => {
    const registry = new Registry();
    const id = registry.idFor(desc('/input[0]', 'input', 'Q'), 'field', 7);
    assert.equal(registry.get(id).within, 7);
  });
});

test('frames become links rather than being dropped', () => {
  const html = render([{ kind: 'frame', desc: desc('/iframe[0]', 'iframe'), name: 'challenges.cloudflare.com' }]);
  assert.match(html, /<a href="f1">\[frame: challenges\.cloudflare\.com\]<\/a>/);
});

test('every page says which page it really is', () => {
  // edbrowse's own fu would only ever show the loopback address.
  const html = render([{ kind: 'text', text: 'hello' }]);
  assert.match(html, /https:\/\/example\.com\//);
  assert.match(html, /<a href="ax">ax<\/a>/);
  assert.match(html, /<a href="render">text<\/a>/);
  assert.match(html, /<a href="inspect">inspect<\/a>/);
  assert.match(html, /<a href="source">source<\/a>/);
  assert.match(html, /<a href="\.\.\/tabs">tabs<\/a>/);
  assert.match(html, /<base href="BASE">/);
});

test('the address bar is on our own pages too', () => {
  assert.match(openBar(), /<form action="\.\.\/open" method="post">/);
});

test('the other views are handed over untidied', () => {
  const html = linesToHtml('Title', 'BASE', 'Accessibility tree', ['a < b', '  indented']);
  assert.match(html, /<pre>/);
  assert.match(html, /a &lt; b/);
});

test('identity', async (t) => {
  await t.test('the same element keeps its id across renders', () => {
    // A link in a buffer from ten minutes ago still means what it said.
    const registry = new Registry();
    const one = registry.idFor(desc('/a[0]', 'a', 'Next'), 'control');
    const again = registry.idFor(desc('/a[0]', 'a', 'Next'), 'control');
    assert.equal(one, again);
  });

  await t.test('different elements get different ids', () => {
    const registry = new Registry();
    assert.notEqual(
      registry.idFor(desc('/a[0]', 'a', 'Next'), 'control'),
      registry.idFor(desc('/a[1]', 'a', 'Back'), 'control'),
    );
  });

  await t.test('an id remembers what it is for', () => {
    // A form submission arrives as names and values with nothing to say
    // which was a field and which a button.
    const registry = new Registry();
    const id = registry.idFor(desc('/input[0]', 'input', 'Q'), 'field');
    assert.equal(registry.get(id).kind, 'field');
  });
});

test('what the address bar accepts', async (t) => {
  const cases = [
    ['https://example.com/x', { url: 'https://example.com/x' }],
    ['example.com', { url: 'https://example.com' }],
    ['localhost:8080', { url: 'http://localhost:8080' }],
    ['127.0.0.1:3000', { url: 'http://127.0.0.1:3000' }],
    ['mailto:a@b.c', { url: 'mailto:a@b.c' }],
    ['how tall is everest', { search: 'how tall is everest' }],
    ['', { error: 'nothing to open' }],
  ];
  for (const [input, expected] of cases) {
    await t.test(JSON.stringify(input), () => {
      assert.deepEqual(normaliseTarget(input), expected);
    });
  }
});

test('failures are explained in words a reader can act on', () => {
  assert.equal(typeof explain('some unmatched thing'), 'string');
  assert.equal(explain('some unmatched thing'), 'some unmatched thing');
});
