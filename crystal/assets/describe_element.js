// Generated from src/place.js describeElement; update with tools/update_crystal_assets.js.
function describeElement(el) {
  if (!el || !el.tagName) return null;
  const attr = (name) => (el.getAttribute && el.getAttribute(name)) || '';
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const all = el.ownerDocument.getElementsByTagName('*');
  const ordinal = Array.prototype.indexOf.call(all, el);
  return {
    label: attr('aria-label') || attr('alt') || attr('title') || text.slice(0, 200)
      || attr('placeholder') || attr('name') || '',
    ordinal: ordinal >= 0 ? ordinal : null,
    total: all.length,
  };
}
