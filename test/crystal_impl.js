'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const binary = process.env.TAWB_CRYSTAL_BIN
  || path.join(__dirname, '..', 'dist', 'tawb-crystal');

function call(operation, payload) {
  const child = spawnSync(binary, ['--conformance', operation], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
  });
  if (child.error) throw child.error;
  let response;
  try {
    response = JSON.parse(String(child.stdout || '').trim());
  } catch {
    throw new Error(`Crystal conformance call ${operation} returned no JSON: ${child.stderr}`);
  }
  if (child.status !== 0 || !response.ok) {
    throw new Error(response.error || child.stderr || `Crystal conformance call ${operation} failed`);
  }
  return response.value;
}

function ariaImplementations(javascript) {
  const implementations = [{ name: 'JavaScript', ...javascript }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    renderLine(item) {
      return call('aria.render_line', { item });
    },
  });
  return implementations;
}

function addressImplementations(javascript) {
  const implementations = [{ name: 'JavaScript', ...javascript }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    DEFAULT_SEARCH: javascript.DEFAULT_SEARCH,
    resolveAddress(typed, { search = javascript.DEFAULT_SEARCH } = {}) {
      return call('address.resolve', { typed, search });
    },
    searchUrl(words, template = javascript.DEFAULT_SEARCH) {
      return call('address.search_url', { words, template });
    },
  });
  return implementations;
}

function bidiImplementations(javascript) {
  const implementations = [{ name: 'JavaScript', ...javascript }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    fromRemoteValue(value) {
      return call('bidi.from_remote', { value });
    },
  });
  return implementations;
}

function blockImplementations(blocks, aria) {
  const implementations = [{ name: 'JavaScript', ...blocks, renderLine: aria.renderLine }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    buildBlocks(items) {
      return call('blocks.build', { items });
    },
    foldSeparatorBlocks(values) {
      return call('blocks.fold', { blocks: values });
    },
    renderLine(item) {
      return call('aria.render_line', { item });
    },
  });
  return implementations;
}

function dumpImplementations(javascript) {
  const implementations = [{ name: 'JavaScript', ...javascript }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    resolveDumpTarget(input, { cwd = process.cwd(), exists = () => false, search } = {}) {
      // Existing tests use a finite fake filesystem; enumerate the only path
      // they ask the callback about rather than giving Crystal host access.
      const candidate = path.resolve(cwd, String(input || '').trim());
      const existing = exists(candidate) ? [candidate] : [];
      return call('dump.resolve_target', { input, cwd, existing, search });
    },
    formatAxBlocks(blocks, { escapeUnicode = false } = {}) {
      return call('dump.format_ax_blocks', { blocks, escape_unicode: escapeUnicode });
    },
  });
  return implementations;
}

function layoutImplementations(javascript) {
  const implementations = [{ name: 'JavaScript', ...javascript }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    wrapWithOffsets(text, width) {
      return call('layout.wrap_with_offsets', { text, width });
    },
    spansWithin(spans, start, end) {
      return call('layout.spans_within', { spans, start, end });
    },
    layoutLines(blocks, width) {
      return call('layout.lines', { blocks, width });
    },
  });
  return implementations;
}

function lynxDisplayImplementations(javascript) {
  const implementations = [{ name: 'JavaScript', ...javascript }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    lynxBlocks(blocks, preferences = {}) {
      return call('lynx_display.blocks', { blocks, preferences });
    },
    renderLynxItem(item, fallback = '') {
      return call('lynx_display.render_item', { item, fallback });
    },
    renderLynxBlock(block) {
      return call('lynx_display.render_block', { block });
    },
    numberLynxBlocks(blocks, preferences = {}) {
      return call('lynx_display.number_blocks', { blocks, preferences });
    },
    groupLynxFlows(blocks) {
      return call('lynx_display.group_flows', { blocks });
    },
    groupLynxTableRows(blocks) {
      return call('lynx_display.group_table_rows', { blocks });
    },
    lynxRowText(line, text) {
      return call('lynx_display.row_text', { line, text });
    },
  });
  return implementations;
}

function lynxNumberImplementations(javascript) {
  const implementations = [{ name: 'JavaScript', ...javascript }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    parseLynxNumberExpression(text) {
      return call('lynx_number.parse', { text });
    },
    relativeLinkNumber(prompt, amount, direction) {
      return call('lynx_number.relative', { prompt, amount, direction });
    },
  });
  return implementations;
}

function readerCommands(root) {
  const commands = [{
    name: 'JavaScript', command: process.execPath, args: ['src/index.js'],
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return commands;
  commands.push({ name: 'Crystal', command: binary, args: [] });
  return commands.map((entry) => ({ ...entry, cwd: root }));
}

function optionImplementations(javascript) {
  const implementations = [{ name: 'JavaScript', ...javascript }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    parseArgs(argv, env = {}) {
      return call('options.parse_reader', { argv, env });
    },
    parseEdbArgs(argv, env = {}) {
      return call('options.parse_edb', { argv, env });
    },
    frontEndName(value) {
      return call('options.front_end_name', { value });
    },
  });
  return implementations;
}

function unicodeImplementations(javascript) {
  const implementations = [{ name: 'JavaScript', ...javascript }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    escapeNonAscii(value) {
      return call('unicode.escape', { value });
    },
    escapedOffset(value, offset) {
      return call('unicode.escaped_offset', { value, offset });
    },
  });
  return implementations;
}

module.exports = {
  call, addressImplementations, ariaImplementations, bidiImplementations,
  blockImplementations, dumpImplementations,
  layoutImplementations, lynxDisplayImplementations, lynxNumberImplementations, optionImplementations,
  readerCommands, unicodeImplementations,
};
