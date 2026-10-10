// Generated from src/core.js readFieldStateInPage; update with tools/update_crystal_assets.js.
function readFieldStateInPage(el) {
  if ('value' in el && typeof el.value === 'string') {
    return {
      text: el.value,
      caret: el.selectionStart != null ? el.selectionStart : el.value.length,
      native: true,
    };
  }

  if (el && el.isContentEditable) {
    const selection = el.ownerDocument.getSelection();
    const pointNode = selection && selection.focusNode && el.contains(selection.focusNode)
      ? selection.focusNode : null;
    const pointOffset = pointNode ? selection.focusOffset : 0;
    let text = '';
    let caret = null;

    const appendBreak = () => {
      if (text && !text.endsWith('\n')) text += '\n';
    };
    const walk = (node, root = false) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node === pointNode) {
          caret = text.length + Math.min(Math.max(pointOffset, 0), node.data.length);
        }
        text += node.data;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === 'BR') {
        if (node === pointNode) caret = text.length;
        text += '\n';
        return;
      }

      const display = root ? '' : getComputedStyle(node).display;
      const block = !root && (display === 'block' || display === 'flex'
        || display === 'grid' || display === 'list-item' || display.startsWith('table'));
      if (block) appendBreak();
      const children = Array.from(node.childNodes);
      for (let i = 0; i <= children.length; i += 1) {
        if (node === pointNode && pointOffset === i) caret = text.length;
        if (i < children.length) walk(children[i]);
      }
      if (block && text && !text.endsWith('\n')) text += '\n';
    };

    walk(el, true);
    // A block's closing boundary separates it from a following block; it is
    // not part of the editor's value when that block is the final child.
    if (text.endsWith('\n') && (!el.lastChild || el.lastChild.tagName !== 'BR')) {
      text = text.slice(0, -1);
    }
    return {
      text,
      caret: caret == null ? text.length : Math.min(caret, text.length),
      native: true,
    };
  }

  const text = el.textContent || '';
  return { text, caret: text.length, native: false };
}
