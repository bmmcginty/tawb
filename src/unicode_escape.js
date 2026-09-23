'use strict';

// A physical Linux console can reliably retain only the glyphs in its small
// loaded font. Speakup can receive BMP text while it is being written, but
// later screen review sees that font's fallback glyph, and its internal u16
// buffers cannot represent supplementary code points at all. Representing
// non-ASCII page text with ASCII escapes keeps the value stable both when it
// is first spoken and when the reader comes back to it.
function escapeNonAscii(value) {
  let out = '';
  for (const character of String(value ?? '')) {
    const codepoint = character.codePointAt(0);
    if (codepoint <= 0x7f) {
      out += character;
    } else if (codepoint <= 0xffff) {
      out += `\\u${codepoint.toString(16).toUpperCase().padStart(4, '0')}`;
    } else {
      out += `\\U${codepoint.toString(16).toUpperCase().padStart(8, '0')}`;
    }
  }
  return out;
}

// Browser carets are UTF-16 offsets into the original field value. Once page
// text is escaped, the terminal cursor instead needs the width of the escaped
// prefix. Browser APIs do not normally put a caret between a surrogate pair;
// slicing here nevertheless gives a deterministic representation if one does.
function escapedOffset(value, offset) {
  return escapeNonAscii(String(value ?? '').slice(0, offset)).length;
}

module.exports = { escapeNonAscii, escapedOffset };
