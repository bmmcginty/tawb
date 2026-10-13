// Generated from src/edb_page.js applyFieldValues; update with tools/update_crystal_assets.js.
function applyFieldValues(entries) {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const byPath = (path) => {
    let node = document.documentElement;
    for (const part of String(path).split('/')) {
      if (!node) return null;
      if (part === '') continue;
      if (part[0] === 's') {
        const root = node.shadowRoot;
        node = root ? root.children[Number(part.slice(1))] : null;
      } else {
        node = node.children[Number(part)];
      }
    }
    return node || null;
  };

  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const applied = [];
  const missed = [];

  for (const entry of entries) {
    const el = byPath(entry.path);
    if (!el || el.tagName.toLowerCase() !== entry.tag) { missed.push(entry.path); continue; }
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (type === 'checkbox' || type === 'radio') {
      const on = entry.value === 'on' || entry.value === 'true' || entry.value === '1';
      if (el.checked !== on) { el.checked = on; fire(el, 'input'); fire(el, 'change'); }
    } else if (el.tagName.toLowerCase() === 'select') {
      let matched = false;
      for (const option of el.options) {
        const want = clean(entry.value);
        const is = clean(option.textContent) === want || option.value === entry.value;
        if (el.multiple) option.selected = is && !matched ? true : (is || false);
        else if (is && !matched) { el.value = option.value; matched = true; }
        if (is) matched = true;
      }
      fire(el, 'input');
      fire(el, 'change');
    } else {
      el.value = entry.value;
      fire(el, 'input');
      fire(el, 'change');
    }
    applied.push(entry.path);
  }

  return { applied: applied.length, missed };
}
