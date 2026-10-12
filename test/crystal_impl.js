'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { EOF } = require('../src/input');

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

function callAsync(operation, payload, { env = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--conformance', operation], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Crystal conformance call ${operation} timed out`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      let response;
      try {
        response = JSON.parse(stdout.trim());
      } catch {
        reject(new Error(`Crystal conformance call ${operation} returned no JSON: ${stderr}`));
        return;
      }
      if (status !== 0 || !response.ok) {
        reject(new Error(response.error || stderr || `Crystal conformance call ${operation} failed`));
        return;
      }
      resolve(response.value);
    });
    child.stdin.end(JSON.stringify(payload));
  });
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
  const sessionScenario = async (url, actions) => {
    const session = await javascript.connect(url);
    const events = new Map();
    for (const { type, method } of actions) {
      if (type !== 'event' || events.has(method)) continue;
      const waiting = [];
      const queued = [];
      events.set(method, { waiting, queued });
      session.on(method, (params) => {
        const resolve = waiting.shift();
        if (resolve) resolve(params);
        else queued.push(params);
      });
    }
    const nextEvent = (method) => {
      const event = events.get(method);
      if (event.queued.length) return Promise.resolve(event.queued.shift());
      return new Promise((resolve) => event.waiting.push(resolve));
    };
    try {
      const values = [];
      for (const action of actions) {
        if (action.type === 'event') {
          values.push({ event: await nextEvent(action.method) });
        } else {
          try {
            values.push({ result: await session.send(action.method, action.params || {}) });
          } catch (error) {
            values.push({ error: error.message });
          }
        }
      }
      return values;
    } finally {
      session.close();
    }
  };

  const implementations = [{ name: 'JavaScript', ...javascript, sessionScenario }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    fromRemoteValue(value) {
      return call('bidi.from_remote', { value });
    },
    sessionScenario(url, actions) {
      return callAsync('bidi.session_scenario', { url, actions });
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

// A scripted pass over the core's buffer: blocks set, the shadow cursor
// moved, changes recorded, text patched, popups relocated, dropdowns spliced
// in — and after each step, one observation both runtimes must agree on. The
// JavaScript original runs the script in-process over src/core.js, so the
// same assertions can be made about both.
function coreImplementations(javascript) {
  const blocksOf = (texts) => texts.map((text, i) => ({ text, item: { name: text, domIndex: i } }));
  const scenario = (script) => {
    const page = {};
    const frames = new Map();
    const frameFor = (name) => {
      if (name === undefined || name === null || name === 'main') return page;
      if (!frames.has(name)) frames.set(name, {});
      return frames.get(name);
    };
    const itemFor = (item) => {
      if (!item || item.frame === undefined) return item;
      return { ...item, frame: frameFor(item.frame) };
    };
    const core = new javascript.Core({ driver: {}, page, source: 'source', sources: ['source'] });
    const anchors = new Map();
    const texts = new Map();
    const undos = new Map();
    const observations = [];
    const newsOf = (list) => list.map(({ start, end, text }) => ({ start, end, text }));
    const anchorOf = (anchor) => ({
      text: anchor.text, name: anchor.name ?? null, identity: anchor.identity ?? null,
      block: anchor.block, context: anchor.context,
    });
    for (const step of script) {
      switch (step.op) {
        case 'blocks':
          core.blocks = step.blocks
            ? step.blocks.map((block, i) => ({
                text: block.text,
                item: itemFor(block.item === undefined ? { name: block.text, domIndex: i } : block.item),
              }))
            : blocksOf(step.texts);
          if (step.cursor !== undefined) core.at(step.cursor);
          observations.push(null);
          break;
        case 'at':
          core.at(step.index);
          observations.push(null);
          break;
        case 'texts': {
          const current = core.texts();
          if (step.id) texts.set(step.id, current);
          observations.push(current);
          break;
        }
        case 'block_text':
          observations.push(core.blockText(step.index));
          break;
        case 'item_value':
          observations.push(core.block(step.index)?.item?.value ?? null);
          break;
        case 'remember_files':
          core.rememberAttachedFiles({
            file: { key: step.key },
            frame: frameFor(step.frame),
          }, step.paths, page);
          observations.push(null);
          break;
        case 'restore_files':
          core.restoreAttachedFiles(core.blocks, page);
          observations.push(null);
          break;
        case 'anchor': {
          const anchor = core.anchor();
          if (step.id) anchors.set(step.id, anchor);
          observations.push(anchorOf(anchor));
          break;
        }
        case 'reanchor': {
          const settled = core.reanchor(
            anchors.get(step.anchor), step.previous ? texts.get(step.previous) : null);
          observations.push({ block: settled.block, exact: settled.exact });
          break;
        }
        case 'restore':
          observations.push(core.restore(anchors.get(step.anchor)));
          break;
        case 'record_changes':
          observations.push(newsOf(core.recordChanges(step.regions)));
          break;
        case 'note_changes':
          observations.push(newsOf(core.noteChanges(texts.get(step.previous))));
          break;
        case 'change_targets':
          observations.push(core.changeTargets().map(({ block, size }) => ({ block, size })));
          break;
        case 'patch': {
          const patched = core.patchText(step.patches, { protect: step.protect !== false });
          if (patched) undos.set(step.id || 'last', patched.undo);
          observations.push(patched
            ? { touched: patched.touched, generation: patched.generation }
            : null);
          break;
        }
        case 'undo':
          undos.get(step.id || 'last')();
          observations.push(true);
          break;
        case 'open_chooser':
          core.openChooser(step.block_index, step.listing);
          observations.push(null);
          break;
        case 'show_chooser':
          observations.push(core.showChooser(step.filter === undefined ? null : step.filter));
          break;
        case 'close_chooser':
          core.closeChooser();
          observations.push(null);
          break;
        case 'in_chooser':
          observations.push(core.inChooser(step.index));
          break;
        case 'follow_popup':
          core.followPopup(step.controls);
          observations.push(null);
          break;
        case 'forget_popup':
          core.forgetPopup();
          observations.push(null);
          break;
        case 'relocate_popup':
          observations.push(core.relocatePopup());
          break;
        case 'popup_at':
          observations.push(core.popupAt());
          break;
        case 'find_near':
          observations.push(core.findNear(step.start, step.text));
          break;
        case 'rendered_url':
          core.renderedUrl = step.url;
          observations.push(null);
          break;
        case 'exhaust':
          core.exhausted = { url: core.renderedUrl, blocks: core.blocks.length };
          observations.push(null);
          break;
        case 'no_more_to_load':
          observations.push(core.noMoreToLoad());
          break;
        default:
          throw new Error(`unknown core scenario op ${step.op}`);
      }
    }
    return observations;
  };

  const implementations = [{
    name: 'JavaScript',
    scenario,
    diffBlocks: (previousTexts, texts) =>
      javascript.diffBlocks(previousTexts, texts.map((text) => ({ text }))),
    soleBlockContaining: (texts, needle) =>
      javascript.soleBlockContaining(texts.map((text) => ({ text })), needle),
    findBlockWithText: (texts, needle) =>
      javascript.findBlockWithText(texts.map((text) => ({ text })), needle),
    sameDocumentFragment: javascript.sameDocumentFragment,
    identityOf: javascript.identityOf,
    sliderTarget: javascript.sliderTarget,
    remapIndex: require('../src/remap').remapIndex,
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    scenario(script) { return call('core.scenario', { script }); },
    diffBlocks(previousTexts, texts) {
      return call('core.diff_blocks', { previous_texts: previousTexts, blocks: texts });
    },
    soleBlockContaining(texts, needle) {
      return call('core.sole_block_containing', { blocks: texts, needle });
    },
    findBlockWithText(texts, needle) {
      return call('core.find_block_with_text', { blocks: texts, needle });
    },
    sameDocumentFragment(before, after) {
      return call('core.same_document_fragment', { before, after });
    },
    identityOf(block) { return call('core.identity_of', { block }); },
    sliderTarget(state, key) { return call('core.slider_target', { state, key }); },
    remapIndex(oldTexts, newTexts, index) {
      return call('core.remap_index', { old: oldTexts, new: newTexts, index });
    },
    snapshotScenario(url, cursor) {
      return callAsync('core.snapshot_scenario', { url, cursor });
    },
    liveCycleScenario(url) { return callAsync('core.live_cycle_scenario', { url }); },
    moreScenario(url) { return callAsync('core.more_scenario', { url }); },
    fragmentScenario(url) { return callAsync('core.fragment_scenario', { url }); },
    navigationScenario(url) { return callAsync('core.navigation_scenario', { url }); },
  });
  return implementations;
}

// Tab inventory and adoption over the same Core policy. The JavaScript side
// uses in-memory pages; the native side is given a scripted BiDi endpoint so
// its real Firefox page objects and protocol requests are exercised too.
function coreTabImplementations(javascript, session) {
  const scenario = async (_url, payload) => {
    const pages = payload.pages.map((given) => {
      const page = {
        contextId: given.id,
        _url: given.url,
        _closed: false,
        _armed: 0,
        url: () => page._url,
        title: async () => given.title,
        isClosed: () => page._closed,
        evaluate: async () => given.foreground,
        close: async () => { page._closed = true; },
        setDefaultTimeout: () => {},
        setDefaultNavigationTimeout: () => {},
      };
      return page;
    });
    const driver = {
      listTabs: () => pages,
      targetIdFor: async (page) => page.contextId,
      armFileChooser: async (page) => { page._armed += 1; return true; },
      newTab: async () => {
        const page = {
          contextId: 'created-context', _url: 'about:blank', _closed: false,
          url: () => page._url, title: async () => '', isClosed: () => page._closed,
          evaluate: async () => false, close: async () => { page._closed = true; },
          setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {},
        };
        pages.push(page);
        return page;
      },
    };
    const core = new javascript.Core({
      driver, page: null, source: 'ax', sources: ['ax'], browserPort: payload.browser_port,
    });
    const observations = [];
    const find = (id) => pages.find((page) => page.contextId === id && !page._closed);
    try {
      for (const step of payload.script) {
        switch (step.op) {
          case 'tabs': observations.push(core.tabs().map((page) => page.contextId)); break;
          case 'adopt': observations.push(await core.adoptTab(find(step.id))); break;
          case 'where': observations.push(core.where()); break;
          case 'next': observations.push(core.nextTab(step.direction)?.contextId ?? null); break;
          case 'after': observations.push(core.tabAfter(find(step.id))?.contextId ?? null); break;
          case 'label': observations.push(await core.tabLabel(find(step.id))); break;
          case 'foreground': observations.push(await core.isForeground(find(step.id))); break;
          case 'new': observations.push((await core.newTab()).contextId); break;
          case 'close': await core.closeTab(find(step.id)); observations.push(null); break;
          case 'claimed_self': {
            const claim = session.readClaims(payload.browser_port)
              .find((entry) => entry.pid === process.pid);
            observations.push(claim?.targetId ?? null);
            break;
          }
          default: throw new Error(`unknown core tab scenario op ${step.op}`);
        }
      }
    } finally {
      session.releaseTab(payload.browser_port);
    }
    return observations;
  };

  const implementations = [{ name: 'JavaScript', scenario }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    scenario(url, payload) { return callAsync('core.tab_scenario', { url, ...payload }); },
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

function interfaceImplementations(javascript) {
  const implementations = [{
    name: 'JavaScript',
    interfaceName: (value) => javascript.interfaceName(value),
    profilesFor: (id) => javascript.profilesFor(id),
    bindingsFor: (id, defaults, profile) => javascript.bindingsFor({ id, defaults }, profile),
    keyPolicy: (profile) => {
      const policy = javascript.keyPolicy(profile);
      return {
        key_definitions: policy.keyDefinitions,
        labels: policy.labels,
        has_key_file: !!policy.keyFile,
      };
    },
    needsLayoutMetadata: (profile) => javascript.needsLayoutMetadata(profile),
    contextActions: () => javascript.LYNX_CONTEXT_ACTIONS,
    contextNavigationAction: (chunk, profile, actionFor) =>
      javascript.contextNavigationAction(chunk, {
        interface: profile,
        keys: actionFor ? { actionFor: (pressed) => actionFor[pressed] ?? null } : null,
      }),
    lynxHidesCursor: (profile, showCursor) => javascript.lynxHidesCursor({
      interface: profile,
      keys: showCursor === undefined ? null : { preferences: { showCursor } },
    }),
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    interfaceName(value) { return call('interfaces.name', { value }); },
    profilesFor(id) { return call('interfaces.profiles_for', { id }); },
    bindingsFor(id, defaults, profile) {
      return call('interfaces.bindings_for', { id, defaults, profile });
    },
    keyPolicy(profile) { return call('interfaces.key_policy', { profile }); },
    needsLayoutMetadata(profile) { return call('interfaces.needs_layout_metadata', { profile }); },
    contextActions() { return call('interfaces.context_actions', {}); },
    contextNavigationAction(chunk, profile, actionFor) {
      return call('interfaces.context_navigation_action', { chunk, interface: profile, action_for: actionFor });
    },
    lynxHidesCursor(profile, showCursor) {
      return call('interfaces.lynx_hides_cursor', { interface: profile, show_cursor: showCursor ?? null });
    },
  });
  return implementations;
}

// A scripted pass over the KeyReader: chunks written at particular moments,
// waits between them, claims taken and released, and the keys that came out.
// The observations are the same shapes on both runtimes: a key, or null for
// the end of the stream, and {value} or {key} for a nextOr race.
function inputImplementations(input) {
  const javascript = {
    name: 'JavaScript',
    async scenario(script) {
      const stream = new PassThrough();
      const reader = new input.KeyReader(stream, { escapeMs: script.escape_ms });
      const tokens = new Map();
      const parked = new Map();
      const observations = [];
      const tick = () => new Promise((resolve) => setImmediate(resolve));
      const key = (pressed) => (pressed === input.EOF ? null : pressed);
      const owner = (step) => (step.owner ? tokens.get(step.owner) : null);
      for (const step of script.script) {
        switch (step.op) {
          case 'write':
            stream.write(step.chunk);
            await tick();
            break;
          case 'wait':
            await new Promise((resolve) => setTimeout(resolve, step.ms));
            break;
          case 'end':
            stream.end();
            await tick();
            break;
          case 'close':
            reader.close();
            break;
          case 'claim':
            tokens.set(step.owner, reader.claim());
            break;
          case 'release':
            reader.release(tokens.get(step.owner));
            break;
          case 'next':
            observations.push(key(await reader.next(owner(step))));
            break;
          case 'park':
            parked.set(step.id, { kind: 'key', promise: reader.next(owner(step)) });
            break;
          case 'next_or': {
            const operation = step.resolve === undefined
              ? new Promise(() => {})
              : Promise.resolve(step.resolve);
            parked.set(step.id, { kind: 'race', promise: reader.nextOr(operation, owner(step)) });
            break;
          }
          case 'await': {
            const parkedWait = parked.get(step.id);
            const outcome = await parkedWait.promise;
            observations.push(parkedWait.kind === 'race'
              ? (Object.hasOwn(outcome, 'value') ? { value: outcome.value } : { key: key(outcome.key) })
              : key(outcome));
            break;
          }
          default:
            throw new Error(`unknown input scenario op ${step.op}`);
        }
      }
      reader.close();
      return observations;
    },
  };
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return [javascript];
  return [javascript, {
    name: 'Crystal',
    scenario(script) { return call('input.scenario', script); },
  }];
}

function sessionImplementations(session) {
  const javascript = {
    name: 'JavaScript',
    async scenario(script) {
      const { processAlive } = require('../src/proc');
      const observations = [];
      const planted = (who) => (who === 'dead' ? 0x7fffffff : process.ppid);
      for (const step of script.script) {
        switch (step.op) {
          case 'reset':
            fs.mkdirSync(path.dirname(session.claimsPath(step.port)), { recursive: true });
            fs.writeFileSync(session.claimsPath(step.port), '[]');
            break;
          case 'claim':
            session.claimTab(step.port, step.target);
            break;
          case 'release':
            session.releaseTab(step.port);
            break;
          case 'inject': {
            const claims = JSON.parse(fs.readFileSync(session.claimsPath(step.port), 'utf8'));
            claims.push({ pid: planted(step.who), targetId: step.target, at: Date.now() });
            fs.writeFileSync(session.claimsPath(step.port), JSON.stringify(claims));
            break;
          }
          case 'other_readers':
            observations.push(session.otherReadersOn(step.port));
            break;
          case 'claimed':
            observations.push([...session.claimedTargets(step.port)]);
            break;
          default:
            throw new Error(`unknown session scenario op ${step.op}`);
        }
      }
      return observations;
    },
  };
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return [javascript];
  return [javascript, {
    name: 'Crystal',
    scenario(script) { return call('session.scenario', script); },
  }];
}

function keymapImplementations(javascript) {
  const build = (spec) => new javascript.Keymap({
    terminfo: spec.terminfo ?? null,
    profile: spec.profile,
    file: spec.file ?? undefined,
    load: spec.load ?? true,
    bindings: spec.bindings ?? {},
    unsupported: spec.unsupported ?? [],
    preferences: spec.preferences ?? {},
  });
  const actions = (keys) => keys.actions.map((action) => ({
    id: action.id, label: action.label, defaults: action.defaults, bindings: action.bindings,
  }));
  const implementations = [{
    name: 'JavaScript',
    actionsFor: (profile) => javascript.actionsFor(profile).map((action) => ({
      id: action.id, label: action.label, defaults: action.defaults,
    })),
    configPath: (xdgConfigHome, home, profile) => javascript.configPath(
      xdgConfigHome === undefined ? process.env : { XDG_CONFIG_HOME: xdgConfigHome }, home, profile),
    readTerminfo: (term) => javascript.readTerminfo({
      env: term === undefined ? process.env : { ...process.env, TERM: term },
    }),
    snapshot(spec) {
      const keys = build(spec);
      return {
        profile: keys.profile, file: keys.file, terminfo: keys.terminfo,
        actions: actions(keys),
        function_names: Object.fromEntries(keys.functionNames),
        unsupported: keys.unsupported, preferences: keys.preferences, labels: keys.labels,
      };
    },
    actionFor: (spec, chunk) => build(spec).actionFor(chunk),
    editingActionFor: (spec, chunk) => build(spec).editingActionFor(chunk),
    nameForSequence: (spec, sequence) => build(spec).nameForSequence(sequence),
    sequencesFor: (spec, binding) => build(spec).sequencesFor(binding),
    isKey: (spec, sequence, name) => build(spec).isKey(sequence, name),
    conflicts: (spec, id, binding) => build(spec).conflicts(id, binding).map((action) => action.id),
    assign(spec, id, sequence, add) {
      const keys = build(spec);
      const result = keys.assign(id, sequence, { add: !!add });
      return result && {
        binding: result.binding,
        displaced: result.displaced ? result.displaced.id : null,
        actions: actions(keys),
      };
    },
    unbind(spec, id) {
      const keys = build(spec);
      keys.unbind(id);
      return { actions: actions(keys) };
    },
    reset(spec) {
      const keys = build(spec);
      keys.reset();
      return { actions: actions(keys) };
    },
    save(spec) {
      build(spec).save();
      return true;
    },
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    actionsFor(profile) { return call('keys.actions_for', { profile }); },
    configPath(xdgConfigHome, home, profile) {
      return call('keys.config_path', { xdg_config_home: xdgConfigHome ?? null, home, profile });
    },
    readTerminfo(term) { return callAsync('keys.read_terminfo', { term: term ?? null }); },
    snapshot(spec) { return call('keys.snapshot', spec); },
    actionFor(spec, chunk) { return call('keys.action_for', { ...spec, chunk }); },
    editingActionFor(spec, chunk) { return call('keys.editing_action_for', { ...spec, chunk }); },
    nameForSequence(spec, sequence) { return call('keys.name_for_sequence', { ...spec, sequence }); },
    sequencesFor(spec, binding) { return call('keys.sequences_for', { ...spec, spec: binding }); },
    isKey(spec, sequence, name) { return call('keys.is_key', { ...spec, sequence, name }); },
    conflicts(spec, id, binding) { return call('keys.conflicts', { ...spec, id, spec: binding }); },
    assign(spec, id, sequence, add) {
      return call('keys.assign', { ...spec, id, sequence, add: !!add });
    },
    unbind(spec, id) { return call('keys.unbind', { ...spec, id }); },
    reset(spec) { return call('keys.reset', spec); },
    save(spec) { return call('keys.save', spec); },
  });
  return implementations;
}

// The Lynx effective-configuration importer, differenced between the
// JavaScript original and the Crystal port: the same key descriptions, map
// dumps, preference files, and injected lynx runs answer both.
// The Lynx key decisions, differenced between the JavaScript original and
// the Crystal port: the same interface gates, digit prompts, screen actions,
// and Tab rules, driven against a fake host that records every call.
function lynxActionsImplementations() {
  const { createLynxActions } = require('../src/lynx_actions');
  const { Keymap } = require('../src/keys');
  const implementations = [{
    name: 'JavaScript',
    harness() {
      const calls = [];
      const fakeKeymap = ({ browse = {}, edit = {} } = {}) => ({
        actionFor: (chunk) => browse[chunk] || null,
        editingActionFor: (chunk) => edit[chunk] || null,
      });
      const actions = createLynxActions({
        fallbackKeymap: fakeKeymap(),
        keyIs: (chunk, name) => chunk === `[${name}]`,
        setStatus: (state, msg) => calls.push(['status', msg]),
        currentItem: (state) => state.item || null,
        isField: (role) => role === 'textbox',
        async beginTyping() { calls.push(['beginTyping']); return true; },
        openLinkNumberPrompt: (state, digits) => calls.push(['number', digits]),
        openHelp: () => calls.push(['help']),
        describeCurrent: () => calls.push(['describe']),
        async openMainMenu() { calls.push(['main-menu']); },
        openOptions: () => calls.push(['options']),
        async openTraceLog() { calls.push(['trace-log']); },
        async toggleTrace() { calls.push(['toggle-trace']); },
      });
      return {
        calls,
        reader: (interfaceName = 'lynx', extra = {}) => ({
          interface: interfaceName,
          keys: new Keymap({ terminfo: {}, profile: interfaceName === 'lynx' ? 'lynx' : 'default', load: false }),
          ...extra,
        }),
        setInterface: (state, name) => { state.interface = name; },
        setItem: (state, item) => { state.item = item; },
        setPreferences: (state, prefs) => { state.keys.preferences = prefs; },
        setKeys: (state, map) => { state.keys = map; },
        keymap: fakeKeymap,
        active: (state) => actions.active(state),
        digit: (chunk, state) => actions.digit(chunk, state),
        action: (action, state, page) => actions.action(action, state, page),
        afterQuickNav: (found, state, page) => actions.afterQuickNav(found, state, page),
        popupCloseHint: (state) => actions.popupCloseHint(state),
        searchCase: (state) => actions.searchCase(state),
        libraryAction: (state, chunk) => actions.libraryAction(state, chunk),
        libraryKeepsBrowseMap: (state) => actions.libraryKeepsBrowseMap(state),
        tabArrow: (state, chunk) => actions.tabArrow(state, chunk),
        tabNeedsActivation: (state) => actions.tabNeedsActivation(state),
        tabTypingStatus: (state, name) => actions.tabTypingStatus(state, name),
        tabLandedMode: (state) => actions.tabLandedMode(state),
        typeCommand: (state, chunk) => actions.typeCommand(state, chunk),
      };
    },
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    harness() {
      const calls = [];
      // The reader state lives here and rides along with every question, so
      // the Crystal op can rebuild it call by call.
      const current = { interface: 'lynx', keys: null, item: null };
      const send = (method, payload = {}) => {
        const answer = call('lynx_actions.call', {
          method,
          interface: current.interface,
          keys: current.keys,
          item: current.item,
          ...payload,
        });
        calls.push(...answer.calls);
        return answer.value;
      };
      return {
        calls,
        reader: (interfaceName = 'lynx', extra = {}) => {
          current.interface = interfaceName;
          current.keys = extra.keys || { profile: interfaceName, terminfo: {}, load: false };
          current.item = extra.item || null;
          return current;
        },
        setInterface: (state, name) => { current.interface = name; },
        setItem: (state, item) => { current.item = item; },
        setPreferences: (state, prefs) => {
          current.keys = { ...current.keys, preferences: prefs };
        },
        setKeys: (state, map) => { current.keys = { fake: map }; },
        keymap: (map) => map,
        active: () => send('active'),
        digit: (chunk) => send('digit', { chunk }),
        action: (action) => send('action', { action }),
        afterQuickNav: (found) => send('after_quick_nav', { found: !!found }),
        popupCloseHint: () => send('popup_close_hint'),
        searchCase: () => send('search_case'),
        libraryAction: (state, chunk) => send('library_action', { chunk }),
        libraryKeepsBrowseMap: () => send('library_keeps_browse_map'),
        tabArrow: (state, chunk) => send('tab_arrow', { chunk }),
        tabNeedsActivation: () => send('tab_needs_activation'),
        tabTypingStatus: (state, name) => send('tab_typing_status', { name }),
        tabLandedMode: () => send('tab_landed_mode'),
        typeCommand: (state, chunk) => send('type_command', { chunk }),
      };
    },
  });
  return implementations;
}

// TAWB's Lynx state — the import-once keymap and preference policy —
// differenced between the JavaScript original and the Crystal port: the same
// injected imports, saved settings, key files, and reimport requests must
// produce the same map, the same preferences, and the same writes.
// The internal Lynx pages' row builders, differenced between the JavaScript
// original and the Crystal port: the same help text, document information,
// visited and session lists, reference lists that keep the block Enter must
// activate, and control descriptions.
// The Lynx Options menu, differenced between the JavaScript original and the
// Crystal port: the same rows and columns, the same provisional choosing,
// and the same byte-level calls to the terminal through a fake host.
function lynxOptionsImplementations(lynxOptions, lynxOptionsScreen, lynxSettings, lynxDisplay) {
  // The full preference set a reader carries; the screen draws all of it.
  const PREFERENCES = {
    keypadMode: 'NUMBERS_AS_ARROWS', numberLinks: false, numberFields: false,
    numberLinksOnLeft: true, numberFieldsOnLeft: true,
    textfieldsNeedActivation: false, searchCase: 'CASE_INSENSITIVE', showCursor: false,
  };
  const implementations = [{
    name: 'JavaScript',
    model(method, args = {}) {
      const preferences = args.preferences || {};
      switch (method) {
        case 'screen_lines': return lynxOptions.screenLines(preferences);
        case 'option_value':
          return lynxOptions.optionValue(lynxOptions.optionForLetter(args.letter), preferences);
        case 'choice_index':
          return lynxOptions.choiceIndex(lynxOptions.optionForLetter(args.letter), preferences);
        case 'apply_choice': {
          const working = { ...preferences };
          lynxOptions.applyChoice(lynxOptions.optionForLetter(args.letter), working, args.index || 0);
          return working;
        }
        case 'persistable': return lynxOptions.persistableOptions(preferences);
        case 'constants': return {
          commandRow: lynxOptions.COMMAND_ROW,
          anyKeyChange: lynxOptions.ANY_KEY_CHANGE,
          valueAccepted: lynxOptions.VALUE_ACCEPTED,
          cancelled: lynxOptions.CANCELLED,
          choiceList: lynxOptions.CHOICE_LIST,
          selectLine: lynxOptions.SELECT_LINE,
          commandPrompt: lynxOptions.COMMAND_PROMPT,
          notChangeable: lynxOptions.NOT_CHANGEABLE,
        };
        default: throw new Error(`unknown lynx options model method ${method}`);
      }
    },
    screen(options) {
      const events = [];
      const written = [];
      const host = {
        resetScrollRegion() { events.push(['reset']); },
        writeLine(row, text) { events.push(['line', row, text]); },
        moveCursor(row, col) { events.push(['cursor', row, col]); },
        clearScreen() { events.push(['clear']); },
        setStatus(state, msg) { events.push(['status', msg]); },
        relayout() { events.push(['relayout']); },
        render(state, page, opts) { events.push(['render', !!(opts && opts.force) ? 1 : 0]); },
        clampCol() { events.push(['clampCol']); },
        clampScroll() { events.push(['clampScroll']); },
        saveSettings(state, settings) {
          events.push(['save']);
          written.push(settings);
          if (options.settingsFile) {
            lynxSettings.writeLynxSettings(settings, { file: options.settingsFile });
          }
        },
        keyIs: (chunk, name) => chunk === `[${name}]`,
      };
      const state = {
        interface: 'lynx', mode: 'browse', options: null,
        keys: { preferences: { ...PREFERENCES, ...(options.preferences || {}) } },
        lines: [{ blockIndex: 0, text: 'The page' }],
        cursor: 0, col: 0, scroll: 0,
        title: options.title || 'The page',
        core: { live: { refreshing: false } },
        lynxSettingsFile: options.settingsFile || null,
      };
      lynxOptionsScreen.openOptions(host, state, { url: () => 'https://example.test/page' });
      for (const chunk of options.keys || []) {
        // The screen's handlers are synchronous at this boundary.
        lynxOptionsScreen.handleOptionsKey(host, chunk, state, { url: () => 'https://example.test/page' });
      }
      return {
        events, written,
        mode: state.mode,
        refreshing: state.core.live.refreshing,
        preferences: state.keys.preferences,
        choosing: state.options && state.options.choosing ? state.options.choosing.letter : null,
        cursor: state.cursor,
        settingsFileExists: options.settingsFile ? fs.existsSync(options.settingsFile) : false,
      };
    },
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    model(method, args = {}) {
      return call('lynx_options.model', { method, ...args });
    },
    screen(options) {
      return call('lynx_options.screen', {
        ...options,
        preferences: { ...PREFERENCES, ...(options.preferences || {}) },
      });
    },
  });
  return implementations;
}

function lynxPagesImplementations(lynxPages) {
  const implementations = [{
    name: 'JavaScript',
    page(method, args) {
      switch (method) {
        case 'help': return lynxPages.helpRows({ unsupported: args.unsupported });
        case 'document_info': return lynxPages.documentInfoRows(args);
        case 'visited': return lynxPages.visitedRows(args.visited);
        case 'session': return lynxPages.sessionRows(args.pageLog);
        case 'link_list': return lynxPages.linkListRows(args);
        case 'describe': return lynxPages.describeItem(args.item);
        case 'trace': return lynxPages.traceRows(args.text);
        default: throw new Error(`unknown lynx pages method ${method}`);
      }
    },
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    page(method, args) {
      return call('lynx_pages.call', { method, ...args });
    },
  });
  return implementations;
}

function lynxStateImplementations(lynxState) {
  const describe = (options, map, tallies) => {
    const actions = {};
    for (const chunk of options.probe) actions[chunk] = map.actionFor(chunk);
    return {
      actions,
      preferences: map.preferences,
      unsupported: map.unsupported,
      keysFileExists: fs.existsSync(options.keysFile),
      written: tallies.written,
      reads: tallies.reads,
      imported: tallies.imported,
    };
  };
  const implementations = [{
    name: 'JavaScript',
    keymap(options) {
      const written = [];
      const tallies = { reads: 0, imported: 0 };
      const map = lynxState.lynxKeymapFor({
        lynxReimport: options.lynxReimport,
        lynxExecutable: options.lynxExecutable,
        lynxConfig: options.lynxConfig,
      }, {
        importLynx: options.import
          ? () => { tallies.imported += 1; return options.import; } : undefined,
        readLynx: options.readLynx
          ? () => { tallies.reads += 1; return options.readLynx; } : undefined,
        writeLynx: (settings) => { written.push(settings); },
        keysFile: options.keysFile,
        hasKeys: options.hasKeys === undefined ? undefined : () => options.hasKeys,
      });
      return describe(options, map, { ...tallies, written });
    },
    preferences(options) {
      return {
        preferences: lynxState.lynxPreferences({
          readLynx: options.readLynx ? () => options.readLynx : undefined,
        }),
      };
    },
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    keymap(options) {
      return call('lynx_state.keymap', { ...options, probe: options.probe });
    },
    preferences(options) {
      return call('lynx_state.preferences', options);
    },
  });
  return implementations;
}

// The keyboard wizard, differenced between the JavaScript original and the
// Crystal port: the same rows, the same prompts, and the same byte-level
// writes to a recorded terminal, driven by the same scripted keys.
// The byte-level screen primitives, differenced between the JavaScript
// original and the Crystal port: row rewriting and the nano-style edited-row
// transaction that keeps its intermediate screen states from the terminal.
function screenImplementations() {
  const { patchEditedLine } = require('../src/index');
  const implementations = [{
    name: 'JavaScript',
    patchEditedLine(args) {
      const written = [];
      const real = process.stdout.write;
      process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
      try {
        const changed = patchEditedLine(args.row, args.before, args.after, {
          currentCol: args.currentCol === undefined ? null : args.currentCol,
          finalCol: args.finalCol === undefined ? null : args.finalCol,
        });
        return { changed, writes: written };
      } finally {
        process.stdout.write = real;
      }
    },
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    patchEditedLine(args) {
      return call('screen.patch_edited_line', args);
    },
  });
  return implementations;
}

// The live observer against a real Firefox, on both runtimes. Each side
// launches its own browser and runs the same scenario: arm before the
// document exists, read the parse, mutate the page, and pulse across a
// navigation. Only a browser can say whether the preload script really
// arrives at document-start.
function liveRealImplementations(liveModule, driverModule) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const implementations = [{
    name: 'JavaScript',
    async runScenario({ profile, url, url2, mutation, timeoutMs = 45000 }) {
      const driver = await driverModule.openDriver({
        engine: 'firefox', profile, browserTimeoutMs: timeoutMs, log: () => {},
      });
      try {
        const page = driver.context.pages()[0] || await driver.context.newPage();
        const install = await liveModule.installLive(page);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          () => (window[Symbol.for('tweb.queue')] || []).length > 0, null, { timeout: 8000 },
        ).catch(() => {});
        const parseBatches = await liveModule.collect(page);
        // A real function: the driver compiles bare strings as expressions.
        // The Crystal side takes the same function's source text.
        await page.evaluate(mutation);
        await sleep(800);
        const mutationBatches = await liveModule.collect(page);
        const live = liveModule.createLiveState();
        const first = await liveModule.pulse(page, live);
        await sleep(1100);
        await page.goto(url2, { waitUntil: 'domcontentloaded' });
        const second = await liveModule.pulse(page, live);
        return {
          install,
          parseBatches,
          mutationBatches,
          pulses: [first, second].map((pulse) => pulse && ({
            changed: pulse.changed, navigated: pulse.navigated, rearmed: pulse.rearmed,
          })),
        };
      } finally {
        await driver.close().catch(() => {});
      }
    },
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    async runScenario(args) {
      return callAsync('live.real_scenario', {
        ...args,
        mutation: String(args.mutation),
      }, { timeoutMs: 120000 });
    },
  });
  return implementations;
}

// The terminal drawing of the reader, differenced between the JavaScript
// original and the Crystal port: a state, a page address, and the actions to
// run in order against the same live state. What each action wrote to the
// terminal — and what it refused to rewrite — is the behaviour under test.
function readerImplementations(index, keysModule) {
  const coreModule = require('../src/core');
  // A keyboard for one prompt: queued keystrokes, and the race a pending
  // navigation runs against them.
  const scriptedKeyReader = (keys) => {
    const queue = (keys ?? []).map((k) => (k === '<eof>' ? EOF : k));
    return {
      claim() { return 'token'; },
      release() {},
      async next() {
        if (!queue.length) throw new Error('the prompt asked for a key nobody pressed');
        return queue.shift();
      },
      async nextOr(operation) {
        if (queue.length) return { key: queue.shift() };
        const value = await operation;
        return { value };
      },
    };
  };
  const buildKeys = (spec) => new keysModule.Keymap({
    terminfo: spec.terminfo ?? null,
    profile: spec.profile ?? 'default',
    file: spec.file ?? undefined,
    load: spec.load ?? true,
    bindings: spec.bindings ?? {},
    unsupported: spec.unsupported ?? [],
    preferences: spec.preferences ?? {},
  });

  const buildJsState = (spec, atCalls) => {
    const core = {
      source: spec.core?.source ?? 'ax',
      blocks: spec.core?.blocks ?? [],
      popup: spec.core?.popup ?? null,
      popupAt: () => (spec.core?.popupAt ?? -1),
      at: (index) => { atCalls.push(index); },
      markInput() { this.inputMarks = (this.inputMarks ?? 0) + 1; },
      forgetPopup() { this.popup = null; },
      async activate(item) {
        this.activated = (this.activated ?? []).concat([item]);
        const failure = spec.core?.activationFailure;
        if (failure) {
          if (failure.timeout) throw new coreModule.ActionTimeout('Activating timed out after 6000ms');
          throw new Error(failure.message ?? 'the activation failed');
        }
        // The real activation always answers an object, with a status when
        // the page said one; the reader fills in its own words otherwise.
        return spec.core?.activatedStatus ?? {};
      },
      async fragmentOf() { return spec.core?.fragment ?? null; },
      async focusControl() { return spec.core?.focusOk ?? true; },
      async attachFiles(item, paths) {
        this.attachments = (this.attachments ?? []).concat([{ item, paths }]);
        return true;
      },
      async optionsFor() { return spec.core?.listing ?? null; },
      async fieldForTyping() { return spec.core?.field ?? null; },
      async chooseOption() {
        const failure = spec.core?.chooseFailure;
        if (failure) {
          if (failure.timeout) throw new coreModule.ActionTimeout('Choosing timed out after 6000ms');
          throw new Error(failure.message ?? 'the choice failed');
        }
        return spec.core?.chooseOutcome ?? { changed: true };
      },
      followPopup(controls) { this.popup = controls ? { controls } : null; return this.popup; },
      noteChanges() { return spec.core?.changes ?? []; },
      async blockAtFragment() { return spec.core?.fragmentBlock ?? -1; },
      async watchActivationFocus() {
        return spec.core?.watchFocus ? { token: 'watch' } : null;
      },
      async cancelActivationFocus() {},
      async activationFocus() {
        return spec.core?.focusFound ? { found: true } : null;
      },
      async focusDestinationBlock() { return spec.core?.focusBlock ?? -1; },
      async dropFocusDestination() {},
      async readTypingField() {
        this.typingReads = (this.typingReads ?? 0) + 1;
        const fields = spec.core?.typedFields ?? [];
        if (!fields.length) return null;
        return fields[Math.min(this.typingReads - 1, fields.length - 1)];
      },
      async releaseTypingField() { this.typingReleased = true; },
      async adjustControl() {
        const failure = spec.core?.adjustFailure;
        if (failure) {
          if (failure.timeout) throw new coreModule.ActionTimeout('Adjusting timed out after 6000ms');
          throw new Error(failure.message ?? 'the adjustment failed');
        }
        return spec.core?.adjustOutcome ?? { changed: true, fallback: false };
      },
      driver: { name: spec.core?.driverName ?? 'scripted' },
      noMoreToLoad() { return !!spec.core?.noMoreToLoad; },
      async askForMore() {
        const failure = spec.core?.askMoreFailure;
        if (failure) throw new Error(failure.message ?? 'the page would not say');
        return spec.core?.askMoreOutcome ?? { grew: false, scrollable: false, moved: false, target: 'nothing' };
      },
      async reanchor() {
        return { block: spec.core?.reanchorBlock ?? -1, exact: spec.core?.reanchorExact ?? false };
      },
      canRealClick() { return spec.core?.canRealClick !== false; },
      async realClick() {
        return spec.core?.realClickOutcome ?? { ok: true };
      },
      canHover() { return spec.core?.canHover !== false; },
      async hover() {
        return spec.core?.hoverOutcome ?? { ok: true };
      },
      async downloadLink() {
        return spec.core?.downloadOutcome ?? { ok: true };
      },
      changeTargets() { return spec.core?.changeTargets ?? []; },
      changeIndex: spec.core?.changeIndex ?? -1,
      async attachLive() { return { armed: true }; },
      async collectLive() {},
      async pulseLive() {},
      // The place keeper's page side: the element a capture is told about,
      // where a restore is told that element now is, and a count of the
      // releases. The handle is a stand-in; nothing here touches a page.
      placeDescribed: [],
      placeArrays: [],
      placeReleases: 0,
      async handleFor(item) {
        this.placeDescribed.push(item);
        if (spec.core?.placeRefuses) throw new Error('this line carries no element reference');
        const described = spec.core?.placeElement ?? null;
        const location = spec.core?.placeLocation ?? null;
        const host = this;
        return {
          async evaluate(fn, arg) {
            if (arg === undefined) return described;
            host.placeArrays.push(arg);
            return location;
          },
          async dispose() { host.placeReleases += 1; },
        };
      },
      async rescan() {
        // Each view has its own extractor, so a rescan after a view switch
        // answers with that view's own blocks.
        const perView = spec.core?.sourceBlocks?.[this.source];
        if (perView) this.blocks = perView;
        else if (spec.core?.rescanBlocks) this.blocks = spec.core.rescanBlocks;
        this.snapshotCostMs = spec.core?.rescanCost ?? 0;
      },
      anchor: () => (spec.core?.anchor ?? null),
      restore: () => (spec.core?.restoreBlock ?? -1),
      reanchor: () => ({ block: spec.core?.reanchorBlock ?? -1,
        exact: spec.core?.reanchorExact ?? false }),
      live: spec.core?.live ?? null,
      snapshotCostMs: spec.core?.snapshotCostMs ?? 0,
    };
    // The dropdown's entries are spliced into the block list by the real
    // chooser implementation, borrowed from the Core prototype so the
    // scripted core cannot drift from the real one. The blocks are read
    // through so a rescan that replaces the list is seen, not dodged.
    const chooserHost = Object.create(coreModule.Core.prototype);
    Object.defineProperty(chooserHost, 'blocks', { get: () => core.blocks });
    core.openChooser = (at, listing) =>
      coreModule.Core.prototype.openChooser.call(chooserHost, at, listing);
    core.showChooser = (filter) =>
      coreModule.Core.prototype.showChooser.call(chooserHost, filter);
    core.closeChooser = () => coreModule.Core.prototype.closeChooser.call(chooserHost);
    Object.defineProperty(core, 'chooser', { get: () => chooserHost.chooser });
    const state = {
      rows: spec.rows ?? 24, cols: spec.cols ?? 80,
      interface: spec.interface ?? 'tawb', mode: spec.mode ?? 'browse',
      title: spec.title ?? '', escapeUnicode: !!spec.escapeUnicode,
      shortLinks: !!spec.shortLinks, linkAddress: spec.linkAddress !== false,
      statusMsg: spec.statusMsg ?? '',
      cursor: spec.cursor ?? 0, col: spec.col ?? 0, scroll: spec.scroll ?? 0,
      lines: (spec.lines ?? []).map((line) => ({
        text: line.text ?? '', blockIndex: line.blockIndex ?? 0,
        spans: line.spans ? line.spans.map((span) => ({
          start: span.start, end: span.end, blockIndex: span.blockIndex,
          displayNumber: span.displayNumber,
        })) : undefined,
        continuation: !!line.continuation,
        displayIndent: line.displayIndent ?? 0,
        displayPrefix: line.displayPrefix ?? '',
        displaySuffix: line.displaySuffix ?? '',
        displayNumber: line.displayNumber ?? null,
      })),
      drawn: {
        title: spec.drawn?.title ?? null,
        address: spec.drawn?.address ?? null,
        addressCaretCol: spec.drawn?.addressCaretCol ?? null,
        hint: spec.drawn?.hint ?? null,
        status: spec.drawn?.status ?? null,
      },
      core,
      // The activation path logs against the driver; a scripted state still
      // carries the name it would have in the real loop.
      driver: spec.driver ?? {
        name: 'scripted',
        async readLibrary(kind) {
          if (spec.browserLibrary?.failure) throw new Error(spec.browserLibrary.failure);
          return spec.browserLibrary?.[kind] ?? [];
        },
        async saveBookmark(entry) {
          if (spec.browserLibrary?.saveFailure) throw new Error(spec.browserLibrary.saveFailure);
          return entry;
        },
        async deleteBookmark() {
          if (spec.browserLibrary?.deleteFailure) throw new Error(spec.browserLibrary.deleteFailure);
        },
      },
      keys: spec.keys ? buildKeys(spec.keys) : null,
      typing: spec.typing ? {
        item: spec.typing.item, text: spec.typing.text ?? '',
        caret: spec.typing.caret ?? 0, drawn: spec.typing.drawn ?? null,
      } : null,
      address: spec.address ? {
        text: spec.address.text ?? '', caret: spec.address.caret ?? 0,
        scroll: spec.address.scroll ?? 0,
      } : null,
      auth: spec.auth ? {
        challenge: spec.auth.challenge, refused: !!spec.auth.refused,
        stage: spec.auth.stage ?? 'user',
        user: { text: spec.auth.user?.text ?? '', caret: spec.auth.user?.caret ?? 0 },
        password: { text: spec.auth.password?.text ?? '', caret: spec.auth.password?.caret ?? 0 },
      } : null,
      find: spec.find ? {
        direction: spec.find.direction ?? 1, text: spec.find.text ?? '',
        caret: spec.find.caret ?? 0,
      } : null,
      lastFind: spec.lastFind
        ? { direction: spec.lastFind.direction ?? 1, text: spec.lastFind.text ?? '' }
        : null,
      line: spec.line ? {
        label: spec.line.label ?? '',
        buffer: { text: spec.line.buffer?.text ?? '', caret: spec.line.buffer?.caret ?? 0 },
      } : null,
      files: spec.files ?? null,
      library: spec.library ?? null, dialog: spec.dialog ?? null,
      options: spec.options ?? null,
      controlling: spec.controlling ?? null,
      chooser: spec.chooser ?? null,
      linkNumber: spec.linkNumber ?? null,
      search: spec.search ?? null,
      sources: spec.sources ?? ['ax'],
      lynxPresentationSource: spec.presentationSource ?? null,
    };
    return state;
  };

  // One synchronous reader action: the drawing and state transitions that
  // need no awaiting. Async ops are handled by drawAsync on top of this.
  const runReaderAction = (action, state, page) => {
    switch (action.op) {
      case 'drawTitle':
        index.drawTitle(state, { force: !!action.force }); return undefined;
      case 'drawAddress':
        index.drawAddress(state, page, { force: !!action.force, edit: !!action.edit }); return undefined;
      case 'drawHint':
        index.drawHint(state, { force: !!action.force }); return undefined;
      case 'setStatus':
        index.setStatus(state, action.msg); return undefined;
      case 'drawStatus':
        index.drawStatus(state, page); return undefined;
      case 'render':
        index.render(state, page, { force: !!action.force }); return undefined;
      case 'drawList':
        index.drawList(state); return undefined;
      case 'parkCursor':
        index.parkCursor(state); return undefined;
      case 'drawAuthPrompt':
        index.drawAuthPrompt(state); return undefined;
      case 'drawFind':
        index.drawFind(state); return undefined;
      case 'drawLinePrompt':
        index.drawLinePrompt(state); return undefined;
      case 'renderRow':
        return index.renderRow(state, action.lineIndex ?? 0);
      case 'typingText': {
        const typing = index.typingText(state);
        return { text: typing.text, caretCol: typing.caretCol };
      }
      case 'hintText':
        return index.hintText(state);
      case 'authPromptText': {
        const prompt = index.authPromptText(state);
        return { text: prompt.text, caretCol: prompt.caretCol };
      }
      case 'linkTarget':
        return index.linkTarget(state, page);
      case 'shortTarget':
        return index.shortTarget(action.href, action.here);
      case 'viewportHeight':
        return index.viewportHeight();
      case 'lineRow':
        return index.lineRow(state, action.lineIndex ?? 0);
      case 'cursorCol':
        return index.cursorCol(state);
      case 'clampScroll':
        index.clampScroll(state); return undefined;
      case 'lynxHidesCursor':
        return index.lynxHidesCursor(state);
      case 'screenBefore':
        return index.screenBefore(state);
      case 'visibleRowsNow':
        return index.visibleRowsNow(state);
      case 'patchVisibleRows':
        return index.patchVisibleRows(state, action.before ?? []);
      case 'repaintList':
        return index.repaintList(state, page, action.before ?? null);
      case 'repaintLynxSelection':
        index.repaintLynxSelection(state, action.oldCursor ?? 0, action.oldCol ?? 0); return undefined;
      case 'relayout':
        index.relayout(state);
        return state.lines.map((line) => ({
          text: line.text, blockIndex: line.blockIndex,
          continuation: !!line.continuation,
          displayNumber: line.displayNumber ?? null,
          displayIndent: line.displayIndent ?? 0,
          displayPrefix: line.displayPrefix ?? '',
          displaySuffix: line.displaySuffix ?? '',
          ...(line.spans ? {
            spans: line.spans.map((span) => ({
              start: span.start, end: span.end, blockIndex: span.blockIndex,
              displayNumber: span.displayNumber ?? null,
            })),
          } : {}),
        }));
      case 'preserveViewportRow':
        index.preserveViewportRow(state, action.row ?? 0,
          action.height === undefined ? index.viewportHeight() : action.height);
        return undefined;
      case 'moveScreen': {
        const height = action.height === undefined ? index.viewportHeight() : action.height;
        index.moveScreen(state, action.direction ?? 1, page, height,
          action.lines === undefined ? height - 1 : action.lines);
        return undefined;
      }
      case 'redrawAfterResize':
        index.redrawAfterResize(state, page); return undefined;
      case 'moveSelection':
        index.moveSelection(state, action.cursor ?? 0, page, action.col ?? 0); return undefined;
      case 'moveCaretLeft':
        index.moveCaretLeft(state, page); return undefined;
      case 'moveCaretRight':
        index.moveCaretRight(state, page); return undefined;
      case 'positionForBlock': {
        const position = index.positionForBlock(state, action.blockIndex ?? 0);
        return position ? { line: position.line, col: position.col } : null;
      }
      case 'focusableEdge': {
        const edge = index.focusableEdge(state, action.direction ?? 1);
        return edge ? { line: edge.line, col: edge.col } : null;
      }
      case 'findQuickNav': {
        const spec = index.QUICK_ACTIONS[action.action];
        if (!spec) throw new Error(`unknown quick action ${action.action}`);
        const found = index.findQuickNav(state, spec.match, spec.direction,
          { sameLine: spec.sameLine });
        return found ? { line: found.line, col: found.col } : null;
      }
      case 'quickWalk': {
        const spec = index.QUICK_ACTIONS[action.action];
        if (!spec) throw new Error(`unknown quick action ${action.action}`);
        const hits = [];
        for (let i = 0; i < (action.limit ?? 100); i += 1) {
          const found = index.findQuickNav(state, spec.match, spec.direction,
            { sameLine: spec.sameLine });
          if (!found) break;
          hits.push({ line: found.line, col: found.col });
          index.moveSelection(state, found.line, page, found.col);
        }
        return hits;
      }
      case 'findParagraph': {
        const found = index.findParagraph(state, action.direction ?? 1);
        return found ? { line: found.line, col: found.col } : null;
      }
      case 'jumpTo': {
        const found = action.found ? { line: action.found.line, col: action.found.col } : null;
        index.jumpTo(state, page, found, action.label, action.direction ?? 1);
        return undefined;
      }
      case 'authKey': {
        const answer = index.handleAuthKey(action.chunk, state);
        return answer === undefined ? 'continue' : answer;
      }
      case 'popupIsOpen':
        return index.popupIsOpen(state);
      case 'popupKey':
        return index.popupKey({
          action: action.action ?? null, chunk: action.chunk ?? '',
          contextAction: action.contextAction ?? null, escape: !!action.escape,
        }) ?? null;
      case 'moveToPopup':
        index.moveToPopup(state, page, action.item ?? null); return undefined;
      case 'openChooser':
        index.openChooser(state, page, action.item, action.listing); return undefined;
      case 'closeChooser':
        index.closeChooser(state, page, { note: action.note ?? null }); return undefined;
      case 'refilter':
        index.refilter(state, page, action.filter ?? ''); return undefined;
      case 'chooserLines': {
        const range = index.chooserLines(state);
        return range ? { first: range.first, last: range.last } : null;
      }
      case 'filePromptText': {
        const prompt = index.filePromptText(state);
        return { text: prompt.text, caretCol: prompt.caretCol };
      }
      case 'completePath': {
        const completion = index.completePath(action.text ?? '');
        return { text: completion.text, note: completion.note ?? null };
      }
      case 'fileToAttach':
        return index.fileToAttach(action.text ?? '');
      case 'findKey':
        index.handleFindKey(action.chunk, state, page); return undefined;
      case 'findText': {
        const found = index.findText(state, action.needle, action.direction ?? 1);
        return found ? { line: found.line, col: found.col, wrapped: found.wrapped } : null;
      }
      case 'runSearch':
        index.runSearch(state, page, action.needle, action.direction ?? 1); return undefined;
      default:
        throw new Error(`unknown reader action ${action.op}`);
    }
  };

  const stateSnapshot = (state, atCalls) => ({
    mode: state.mode,
    title: state.title,
    popup: state.core.popup ?? null,
    live: state.core.live ?? null,
    chooser: state.core.chooser ?? null,
    attachments: state.core.attachments ?? [],
    activated: state.core.activated ?? [],
    visitedLinks: state.visitedLinks ?? [],
    pageLog: state.pageLog ?? [],
    drawn: { ...state.drawn },
    scroll: state.scroll, col: state.col, cursor: state.cursor,
    statusMsg: state.statusMsg,
    lines: state.lines.map((line) => ({
      text: line.text, blockIndex: line.blockIndex,
      continuation: !!line.continuation,
      displayNumber: line.displayNumber ?? null,
      displayIndent: line.displayIndent ?? 0,
      displayPrefix: line.displayPrefix ?? '',
      displaySuffix: line.displaySuffix ?? '',
      ...(line.spans ? {
        spans: line.spans.map((span) => ({
          start: span.start, end: span.end, blockIndex: span.blockIndex,
          displayNumber: span.displayNumber ?? null,
        })),
      } : {}),
    })),
    address: state.address
      ? { text: state.address.text, caret: state.address.caret, scroll: state.address.scroll }
      : null,
    typing: state.typing ? { text: state.typing.text, caret: state.typing.caret } : null,
    auth: state.auth ? {
      stage: state.auth.stage,
      user: { ...state.auth.user }, password: { ...state.auth.password },
    } : null,
    find: state.find
      ? { direction: state.find.direction, text: state.find.text, caret: state.find.caret }
      : null,
    lastFind: state.lastFind
      ? { direction: state.lastFind.direction, text: state.lastFind.text }
      : null,
    controlling: state.controlling ?? null,
    chooserMode: state.chooser ?? null,
    files: state.files ?? null,
    loadingMore: state.loadingMore ?? false,
    changeIndex: state.core.changeIndex ?? -1,
    linkNumber: state.linkNumber
      ? {
        text: state.linkNumber.text ?? '',
        cursor: state.linkNumber.cursor ?? 0,
        col: state.linkNumber.col ?? 0,
        targets: (state.linkNumber.targets ?? []).map((target) => ({
          number: target.number ?? null, line: target.line ?? 0, col: target.col ?? 0,
        })),
      }
      : null,
    atCalls,
    inputMarks: state.core.inputMarks ?? 0,
    typingReads: state.core.typingReads ?? 0,
    typingReleased: state.core.typingReleased ?? false,
    source: state.core.source,
    presentationSource: state.lynxPresentationSource ?? null,
    placeDescribed: state.core.placeDescribed ?? [],
    placeArrays: state.core.placeArrays ?? [],
    placeReleases: state.core.placeReleases ?? 0,
  });

  const scriptedTabPage = (entry = {}) => {
    let url = entry.url ?? 'about:blank';
    let closed = false;
    const page = {
      _blocks: entry.blocks,
      url: () => url,
      title: async () => (entry.title ?? ''),
      mainFrame: () => page,
      on: () => {},
      isClosed: () => closed,
      async goto(target) { url = target; },
      async waitForLoadState() {},
      async close() { closed = true; },
      keyboard: { async press() {}, async type() {} },
    };
    return page;
  };

  const configureScriptedTabs = (state, spec) => {
    const entries = spec.core?.tabs;
    if (!entries) return null;
    const pages = entries.map(scriptedTabPage);
    if (!pages.length) pages.push(scriptedTabPage());
    let current = pages[Math.max(0, Math.min(spec.core?.currentTab ?? 0, pages.length - 1))];
    state.core.page = current;
    // switchToTab starts the production ticker after attaching a page. The
    // harness has no clock-driven live work; a non-enumerable sentinel keeps
    // that timer out of both the process and the state comparison.
    if (state.core.live) Object.defineProperty(state.core.live, 'ticker', {
      value: true, writable: true, configurable: true,
    });
    if (current._blocks) state.core.blocks = current._blocks;
    state.core.tabs = () => pages.filter((page) => !page.isClosed());
    state.core.adoptTab = async (page) => {
      current = page;
      state.core.page = page;
      if (page._blocks) state.core.blocks = page._blocks;
    };
    state.core.nextTab = (direction) => {
      const all = state.core.tabs();
      if (all.length < 2) return null;
      const at = Math.max(0, all.indexOf(current));
      return all[(at + direction + all.length) % all.length];
    };
    state.core.tabAfter = (page) => {
      const all = state.core.tabs();
      if (all.length < 2) return null;
      const at = Math.max(0, all.indexOf(page));
      return all[(at + 1) % all.length];
    };
    state.core.where = (page = current) => {
      const all = state.core.tabs();
      return { position: all.indexOf(page) + 1, of: all.length };
    };
    state.core.tabLabel = async (page) => {
      const title = String(await page.title()).replace(/\s+/g, ' ').trim();
      return (title || page.url() || 'untitled').slice(0, 60);
    };
    state.core.newTab = async () => {
      if (spec.core?.newTabFault) throw new Error(spec.core.newTabFault);
      const page = scriptedTabPage();
      page._blocks = [];
      pages.push(page);
      return page;
    };
    state.core.closeTab = async (page) => {
      if (spec.core?.closeTabFault) throw new Error(spec.core.closeTabFault);
      await page.close();
    };
    const originalRescan = state.core.rescan.bind(state.core);
    state.core.rescan = async ({ page } = {}) => {
      if (page?._blocks) state.core.blocks = page._blocks;
      else await originalRescan();
    };
    return current;
  };

  const implementations = [{
    name: 'JavaScript',
    draw(args) {
      const atCalls = [];
      const state = buildJsState(args.state, atCalls);
      let pageUrl = args.page?.url ?? '';
      const page = { url: () => pageUrl, title: async () => (args.page?.title ?? ''),
        // The page the reader drives cannot be asked to evaluate anything:
        // the page-side probes (history identity, focus watch) then fall
        // back the way they would against a browser that refused.
        evaluate: async () => { throw new Error('the page cannot be asked'); },
        waitForLoadState: async () => {},
        async goto(url) {
          if (args.page?.gotoFault) throw new Error(args.page.gotoFault);
          if (args.page?.gotoHang) return new Promise(() => {});
          pageUrl = url;
        },
        async stopLoading() {},
        async reload() {
          if (args.page?.reloadFault) throw new Error(args.page.reloadFault);
        } };
      // parkCursor and set_status draw the address row from state.core.page,
      // exactly as the reading loop's own state does.
      state.core.page = page;
      const savedWrite = process.stdout.write.bind(process.stdout);
      const saved = {
        rows: process.stdout.rows, cols: process.stdout.columns,
        write: process.stdout.write,
      };
      process.stdout.rows = args.state.rows ?? 24;
      process.stdout.columns = args.state.cols ?? 80;
      const results = [];
      let current = null;
      process.stdout.write = (chunk) => {
        if (current) current.push(String(chunk));
        return true;
      };
      try {
        for (const action of args.actions ?? []) {
          current = [];
          const entry = {};
          const value = runReaderAction(action, state, page);
          if (value !== undefined) {
            // Sparse arrays come back with nulls where the JavaScript
            // original has holes, which is the same answer over the wire.
            entry.value = JSON.parse(JSON.stringify(value));
          }
          entry.writes = current;
          results.push(entry);
        }
      } finally {
        process.stdout.rows = saved.rows;
        process.stdout.columns = saved.cols;
        process.stdout.write = saved.write;
      }
      return {
        results,
        state: stateSnapshot(state, atCalls),
      };
    },
    async drawAsync(args) {
      const atCalls = [];
      const state = buildJsState(args.state, atCalls);
      let pageUrl = args.page?.url ?? '';
      const pageHistory = args.page?.history ?? [];
      let pageHistoryIndex = args.page?.historyIndex ?? 0;
      let page = { url: () => pageUrl,
        title: async () => (pageHistory[pageHistoryIndex]?.title ?? args.page?.title ?? ''),
        evaluate: async (fn, arg) => {
          const source = String(fn);
          if (source.includes('history.go')) {
            const target = pageHistoryIndex + arg;
            if (target >= 0 && target < pageHistory.length) {
              pageHistoryIndex = target;
              pageUrl = pageHistory[target].url;
              state.core.blocks = pageHistory[target].blocks ?? [];
            }
            return undefined;
          }
          if (source.includes('currentEntry')) return pageHistory.length ? String(pageHistoryIndex) : null;
          if (source.includes('location.href')) return pageUrl;
          if (source.includes('readyState')) return 'complete';
          throw new Error('the page cannot be asked');
        },
        waitForLoadState: async () => {},
        async goto(url) {
          if (args.page?.gotoFault) throw new Error(args.page.gotoFault);
          if (args.page?.gotoHang) return new Promise(() => {});
          pageUrl = url;
        },
        async stopLoading() {},
        async reload() {
          if (args.page?.reloadFault) throw new Error(args.page.reloadFault);
        },
        keyboard: { presses: [], async press(key) {
          if (args.page?.failPress) throw new Error('the page refused');
          this.presses.push(key);
        }, async type(text) {
          if (args.page?.failPress) throw new Error('the page refused');
          this.presses.push(text);
        } } };
      state.core.page = page;
      page = configureScriptedTabs(state, args.state) ?? page;
      const savedWrite = process.stdout.write.bind(process.stdout);
      const saved = {
        rows: process.stdout.rows, cols: process.stdout.columns,
        write: process.stdout.write,
      };
      process.stdout.rows = args.state.rows ?? 24;
      process.stdout.columns = args.state.cols ?? 80;
      const results = [];
      let current = null;
      process.stdout.write = (chunk) => {
        if (current) current.push(String(chunk));
        return true;
      };
      try {
        for (const action of args.actions ?? []) {
          page = state.core.page;
          current = [];
          const entry = {};
          let value;
          if (action.op === 'libraryKey') {
            value = await index.handleLibraryKey(action.chunk, state, page) ?? null;
          } else if (action.op === 'refresh') {
            await index.refresh(state, page, { resetCursor: !!action.resetCursor,
              anchor: action.anchor ?? null });
            value = undefined;
          } else if (action.op === 'closePopup') {
            await index.closePopup(state, page);
            value = undefined;
          } else if (action.op === 'beginTyping') {
            value = await index.beginTyping(state, page, action.item);
          } else if (action.op === 'activate') {
            if (action.keys) state.keyReader = scriptedKeyReader(action.keys);
            await index.activateCurrent(state, page);
            value = undefined;
          } else if (action.op === 'chooseKey') {
            await index.handleChooseKey(action.chunk, state, page);
            value = undefined;
          } else if (action.op === 'typeKey') {
            await index.handleTypeKey(action.chunk, state, page);
            value = undefined;
          } else if (action.op === 'fieldCommandKey') {
            await index.handleFieldCommandKey(action.chunk, state, page);
            value = undefined;
          } else if (action.op === 'formsKey') {
            if (action.keys) state.keyReader = scriptedKeyReader(action.keys);
            await index.handleFormsKey(action.chunk, state, page);
            value = undefined;
          } else if (action.op === 'browseKey') {
            if (action.keys) state.keyReader = scriptedKeyReader(action.keys);
            value = await index.handleBrowseKey(action.chunk, state, page) ?? null;
          } else if (action.op === 'loadMore') {
            await index.loadMore(state, page);
            value = undefined;
          } else if (action.op === 'clickAsHuman') {
            await index.clickAsHuman(state, page);
            value = undefined;
          } else if (action.op === 'hoverAsHuman') {
            await index.hoverAsHuman(state, page);
            value = undefined;
          } else if (action.op === 'downloadCurrentLink') {
            await index.downloadCurrentLink(state, page);
            value = undefined;
          } else if (action.op === 'jumpToChange') {
            index.jumpToChange(state, page, action.direction ?? 1);
            value = undefined;
          } else if (action.op === 'openNumberPrompt') {
            index.openLinkNumberPrompt(state, action.digits ?? '');
            value = undefined;
          } else if (action.op === 'numberKey') {
            if (action.keys) state.keyReader = scriptedKeyReader(action.keys);
            await index.handleNumberKey(action.chunk, state, page);
            value = undefined;
          } else if (action.op === 'focusAddress') {
            index.focusAddressBar(state, page, action.text);
            value = undefined;
          } else if (action.op === 'addressKey') {
            if (action.keys) state.keyReader = scriptedKeyReader(action.keys);
            await index.handleAddressKey(action.chunk, state, page);
            value = undefined;
          } else if (action.op === 'controlKey') {
            await index.handleControlKey(action.chunk, state, page);
            value = undefined;
          } else if (action.op === 'reportAfterAction') {
            value = await index.reportAfterAction(state, page, {
              previousTexts: action.previousTexts ?? [],
              previousUrl: action.previousUrl ?? '',
              anchor: action.anchor ?? null,
              screen: action.screen ?? null,
              focused: action.focused ?? null,
            });
          } else if (action.op === 'askFiles') {
            state.keyReader = scriptedKeyReader(action.keys);
            value = (await index.askForFilePaths(state, {
              asking: action.asking, multiple: !!action.multiple, accept: action.accept ?? '',
            })) ?? null;
          } else if (action.op === 'pageKey') {
            const before = page.keyboard.presses.length;
            await index.handlePageKey(action.chunk, state, page);
            value = page.keyboard.presses.slice(before);
          } else if (action.op === 'askPassword') {
            const queue = (action.keys ?? []).map((k) => (k === '<eof>' ? EOF : k));
            state.keyReader = {
              claim() { return 'token'; },
              release() {},
              async next() {
                if (!queue.length) throw new Error('the prompt asked for a key nobody pressed');
                return queue.shift();
              },
            };
            value = (await index.askForPassword(state, action.challenge,
              { refused: !!action.refused })) ?? null;
          } else {
            value = runReaderAction(action, state, page);
          }
          if (value !== undefined) {
            entry.value = JSON.parse(JSON.stringify(value));
          }
          entry.writes = current;
          results.push(entry);
        }
      } finally {
        process.stdout.rows = saved.rows;
        process.stdout.columns = saved.cols;
        process.stdout.write = saved.write;
      }
      return {
        results,
        state: stateSnapshot(state, atCalls),
      };
    },
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    draw(args) {
      return call('reader.draw', args);
    },
  });
  return implementations;
}

function keyWizardImplementations(keysModule, keyWizard, inputModule) {
  const implementations = [{
    name: 'JavaScript',
    rows(options) {
      const keymap = new keysModule.Keymap({
        terminfo: {}, profile: options.profile || 'default', file: options.file,
        load: false, bindings: options.bindings || {}, unsupported: options.unsupported || [],
      });
      if (options.unbindAll) for (const action of keymap.actions) keymap.unbind(action.id);
      return keyWizard.wizardRows(keymap).map((row) => ({
        type: row.type,
        label: row.label === undefined ? null : row.label,
        actionId: row.action ? row.action.id : null,
        text: keyWizard.rowText(row, keymap),
      }));
    },
    async run(options) {
      const keymap = new keysModule.Keymap({
        terminfo: {}, profile: options.profile || 'default', file: options.file,
        load: false, bindings: options.bindings || {}, unsupported: options.unsupported || [],
      });
      if (options.unbindAll) for (const action of keymap.actions) keymap.unbind(action.id);
      const writes = [];
      let current = 0;
      const output = new PassThrough();
      output.rows = options.rows || 24;
      output.columns = options.cols || 80;
      output.write = (chunk) => { writes.push({ key: current, text: String(chunk) }); return true; };
      const keys = (options.keys || []).slice();
      const reader = {
        next: async () => { current += 1; return keys.length ? keys.shift() : inputModule.EOF; },
        close: () => {},
      };
      const saved = await keyWizard.runKeyWizard({
        input: new PassThrough(), output, keymap, reader,
        altScreen: options.altScreen !== false,
      });
      return {
        writes,
        saved,
        actions: keymap.actions.map((action) => ({ id: action.id, bindings: action.bindings })),
        probes: Object.fromEntries((options.probe || []).map((chunk) => [chunk, keymap.actionFor(chunk)])),
        editingProbes: Object.fromEntries(
          (options.editingProbe || []).map((chunk) => [chunk, keymap.editingActionFor(chunk)])),
        fileExists: options.file ? fs.existsSync(options.file) : false,
      };
    },
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    rows(options) {
      return call('key_wizard.rows', options);
    },
    run(options) {
      return call('key_wizard.run', options);
    },
  });
  return implementations;
}

function lynxConfigImplementations(lynxConfig) {
  const implementations = [{
    name: 'JavaScript',
    keySpec: lynxConfig.lynxKeySpec,
    parseBrowseMap: lynxConfig.parseBrowseMap,
    parseEditMap: lynxConfig.parseEditMap,
    parsePreferences: lynxConfig.parsePreferences,
    read({ env, config, dumps, home }) {
      const seen = [];
      const imported = lynxConfig.readLynxConfig({
        env, config,
        run: (_command, args, options) => {
          seen.push(options.env);
          const key = args[0] === '-show_cfg' ? '-show_cfg' : args[1];
          return dumps[key] || { status: 0, stdout: '' };
        },
        readFile: (path) => {
          if (!home || path !== home.path) throw new Error('missing');
          return home.rc || '';
        },
      });
      return { imported, seen };
    },
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    keySpec: (text) => call('lynx_config.key_spec', { text }),
    parseBrowseMap: (text) => call('lynx_config.parse_browse_map', { text }),
    parseEditMap: (text) => call('lynx_config.parse_edit_map', { text }),
    parsePreferences: (showConfig, lynxrc) =>
      call('lynx_config.parse_preferences', { showConfig, lynxrc: lynxrc || '' }),
    read({ env, config, dumps, home }) {
      const result = call('lynx_config.read', {
        env, config: config || null, dumps,
        home: home ? { path: home.path, rc: home.rc || '' } : null,
      });
      return { imported: result, seen: result.envs };
    },
  });
  return implementations;
}

function lynxKeymapImplementations(javascript) {
  const implementations = [{
    name: 'JavaScript',
    actionForFunction: javascript.actionForFunction,
    functionForAction: javascript.functionForAction,
    functionNames: (ids) => Object.fromEntries(javascript.functionNames(ids.map((id) => ({ id })))),
    parse: javascript.parseKeyFile,
    serialise: javascript.serialiseKeyFile,
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    actionForFunction(name) { return call('lynx_keymap.action_for_function', { name }); },
    functionForAction(id) { return call('lynx_keymap.function_for_action', { id }); },
    functionNames(ids) { return call('lynx_keymap.function_names', { ids }); },
    parse(text) { return call('lynx_keymap.parse', { text }); },
    serialise(actions) { return call('lynx_keymap.serialise', { actions }); },
  });
  return implementations;
}

// The field-editing buffer, differenced between the JavaScript original and
// the Crystal port: the same keymap answers, the same buffer edits, and the
// same key sequences sent into a real field.
function editImplementations(edit, keys) {
  const build = (spec) => new keys.Keymap({ terminfo: {}, profile: 'default', load: false, ...spec });
  const implementations = [{
    name: 'JavaScript',
    actionFor: (spec, key) => edit.editAction(key, build(spec)),
    apply: (buffer, action) => {
      const edited = { text: buffer.text, caret: buffer.caret };
      const ok = edit.applyBufferEdit(edited, action);
      return { ok, text: edited.text, caret: edited.caret };
    },
    wordStart: (text, caret) => edit.wordStart(text, caret),
    wordEnd: (text, caret) => edit.wordEnd(text, caret),
    keysFor: async (action) => {
      const pressed = [];
      const sent = await edit.sendFieldEdit(
        { press: async (key) => { pressed.push(key); } }, action);
      return sent ? pressed : null;
    },
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    actionFor(spec, key) { return call('edit.action', { key, ...spec }); },
    apply(buffer, action) {
      return call('edit.apply', { text: buffer.text, caret: buffer.caret, action });
    },
    wordStart(text, caret) { return call('edit.word_start', { text, caret }); },
    wordEnd(text, caret) { return call('edit.word_end', { text, caret }); },
    keysFor(action) { return call('edit.keys_for', { action }); },
  });
  return implementations;
}

function endpointImplementations(javascript) {
  const implementations = [{
    name: 'JavaScript',
    read: javascript.readEndpointRecord,
    write: javascript.writeEndpointRecord,
    freePort: javascript.freePort,
    running: javascript.runningEndpoint,
    portOf: javascript.portOfEndpoint,
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    read(profile) { return call('endpoint.read', { profile }); },
    write(profile, record) { return call('endpoint.write', { profile, record }); },
    freePort() { return callAsync('endpoint.free_port', {}); },
    running(profile) { return callAsync('endpoint.running', { profile }); },
    portOf(url) { return call('endpoint.port_of', { url }); },
  });
  return implementations;
}

function firefoxAgentImplementations(javascript) {
  const implementations = [{ name: 'JavaScript', ask: javascript.askFirefoxLibrary }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    ask(port, request) {
      return callAsync('firefox.agent_request', { port, request });
    },
  });
  return implementations;
}

function firefoxAutomationImplementations({
  bidi, FirefoxPage, askFirefoxLibrary, verifyWebdriverFlag,
}) {
  const verifiedSession = async (url, libraryPort) => {
    const session = await bidi.connect(url);
    try {
      const started = await session.send('session.new', { capabilities: { alwaysMatch: {} } });
      const cleared = await askFirefoxLibrary(libraryPort, { kind: 'clearAutomation' });
      const context = {
        async newPage({ background = false } = {}) {
          const params = { type: 'tab' };
          if (background) params.background = true;
          const created = await session.send('browsingContext.create', params);
          return new FirefoxPage(session, created.context, context);
        },
      };
      const webdriver = await verifyWebdriverFlag(context);
      if (webdriver) {
        throw new Error('Firefox is still announcing itself as automated (navigator.webdriver is true)');
      }
      return { session: started, cleared, webdriver };
    } finally {
      await session.send('session.end', {}).catch(() => {});
      session.close();
    }
  };

  const implementations = [{ name: 'JavaScript', verifiedSession }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    verifiedSession(url, libraryPort) {
      return callAsync('firefox.verified_session', { url, library_port: libraryPort });
    },
  });
  return implementations;
}

function firefoxLaunchImplementations(javascript) {
  const withEnvironment = (values, fn) => {
    const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
    try {
      for (const [name, value] of Object.entries(values)) {
        if (value == null) delete process.env[name];
        else process.env[name] = value;
      }
      return fn();
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value == null) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };
  const implementations = [{
    name: 'JavaScript',
    ...javascript,
    findFirefox(pathValue) {
      return withEnvironment({ PATH: pathValue }, () => javascript.findFirefox());
    },
    defaultProfile(executable, { home, xdgDataHome }) {
      return withEnvironment({ HOME: home, XDG_DATA_HOME: xdgDataHome },
        () => javascript.defaultProfileDir(executable));
    },
    launchPreferences(port) {
      return {
        ...javascript.MEDIA_PREFS,
        ...javascript.PASSWORD_PREFS,
        'browser.altClickSave': true,
        'marionette.port': port,
      };
    },
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    profileLastVersion(profile) {
      return call('firefox.profile_last_version', { profile });
    },
    installedFirefoxVersion(executable) {
      return call('firefox.installed_version', { executable });
    },
    requireCompatibleProfile({ executable, name }, profile) {
      return call('firefox.require_compatible_profile', { executable, name, profile });
    },
    writeProfilePrefs(profile, preferences) {
      return call('firefox.write_profile_prefs', { profile, preferences });
    },
    findFirefox(pathValue) {
      return call('firefox.find', { path: pathValue });
    },
    defaultProfile(executable, { home, xdgDataHome }) {
      return call('firefox.default_profile', {
        executable, home, xdg_data_home: xdgDataHome,
      });
    },
    launchPreferences(port) {
      return call('firefox.launch_preferences', { port });
    },
    launchScenario(options) {
      return callAsync('firefox.launch_scenario', {
        profile: options.profile,
        timeout_ms: options.timeoutMs,
        path: options.path,
        display: options.display,
      }, { env: { FAKE_FIREFOX_LOG: options.log } });
    },
  });
  return implementations;
}

function firefoxPageImplementations({ bidi, FirefoxPage, FirefoxFrame, extractAxItems }) {
  const pageScenario = async (url, { events, target, layout = false }) => {
    const session = await bidi.connect(url);
    try {
      const started = await session.send('session.new', { capabilities: { alwaysMatch: {} } });
      await session.send('session.subscribe', { events });
      const initial = await session.send('browsingContext.getTree', {});
      const top = initial.contexts[0];
      if (!top) throw new Error('Firefox exposed no browsing context');
      const page = new FirefoxPage(session, top.context, {});
      page.setUrl(top.url || 'about:blank');
      await page.goto(target, { waitUntil: 'domcontentloaded' });
      const result = await session.send('browsingContext.getTree', { root: top.context });
      const documents = {};
      const frameTree = async (context) => {
        const frame = new FirefoxFrame(session, context.context, page);
        frame._url = context.url || 'about:blank';
        documents[context.context] = await frame.evaluate(extractAxItems, { layout });
        const children = await Promise.all((context.children || []).map(frameTree));
        return {
          frame: { id: context.context, url: context.url || 'about:blank' },
          ...(children.length ? { childFrames: children } : {}),
        };
      };
      const tree = await frameTree(result.contexts[0]);
      const made = await session.send('browsingContext.create', { type: 'tab', background: true });
      const created = new FirefoxPage(session, made.context, {});
      await created.close();
      return { session: started, url: page.url(), tree, documents, created: made.context };
    } finally {
      await session.send('session.end', {}).catch(() => {});
      session.close();
    }
  };

  const implementations = [{ name: 'JavaScript', pageScenario }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    pageScenario(url, options) {
      return callAsync('firefox.page_scenario', { url, ...options });
    },
  });
  return implementations;
}

// A scripted pass over the handle layer: values passed into the page and
// elements held across calls. The scripted endpoint records every message,
// so the assertions cover both the answers and the exact wire traffic —
// which is the contract, since a real Firefox parses the same bytes.
function firefoxHandleImplementations({ bidi, FirefoxFrame, FirefoxPage, FirefoxKeyboard,
  clickThrough, prepareRealClick, submitsAutofilled }) {
  const handleScenario = async (url, script) => {
    const session = await bidi.connect(url);
    const observations = [];
    let frame = null;
    let current = null;
    let handle = null;
    let acting = null;
    let keyboard = null;
    let refs = [];
    const reference = (held) => ({ id: held.contextId, url: held.url() });
    const clickInFrame = async (target, x, y) => {
      const context = target?.contextId || acting.contextId;
      try {
        await session.send('input.performActions', {
          context,
          actions: [{
            type: 'pointer', id: 'tweb-mouse', parameters: { pointerType: 'mouse' },
            actions: [
              { type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 },
            ],
          }],
        });
      } finally {
        await session.send('input.releaseActions', { context }).catch(() => {});
      }
    };
    try {
      await session.send('session.new', { capabilities: { alwaysMatch: {} } });
      for (const step of script) {
        switch (step.op) {
          case 'frame':
            frame = new FirefoxFrame(session, step.context, {});
            frame._url = step.url;
            current = frame;
            acting = new FirefoxPage(session, step.context, {});
            keyboard = new FirefoxKeyboard(session, { contextId: step.context });
            observations.push(null);
            break;
          case 'url':
            observations.push(current.url());
            break;
          case 'evaluate': {
            // A source shaped like an expression goes in as the string (the
            // driver wraps it); anything else is eval'd back into a real
            // function, whose text is the declaration the wire carries.
            const fn = step.expression !== undefined ? step.expression : (0, eval)(step.fn);
            const value = await current.evaluate(fn, 'arg' in step ? step.arg : undefined);
            observations.push(value === undefined ? null : value);
            break;
          }
          case 'evaluate_handle': {
            const fn = (0, eval)(step.fn);
            handle = await current.evaluateHandle(fn, 'arg' in step ? step.arg : undefined);
            observations.push({ handle: handle.handle, sharedId: handle.sharedId || null });
            break;
          }
          case 'handle_evaluate':
            observations.push(
              await handle.evaluate((0, eval)(step.fn), 'arg' in step ? step.arg : undefined));
            break;
          case 'handle_dispose':
            await handle.dispose();
            observations.push(null);
            break;
          case 'query_all':
            refs = await current.$$(step.selector);
            observations.push(refs.length);
            break;
          case 'content_frame': {
            const found = refs[step.index] ? await refs[step.index].contentFrame() : null;
            observations.push(found ? reference(found) : null);
            break;
          }
          case 'child_frames':
            observations.push((await current.childFrames()).map(reference));
            break;
          case 'use_child': {
            const found = refs[step.index] ? await refs[step.index].contentFrame() : null;
            if (found) {
              current = found;
              observations.push(reference(found));
            } else {
              observations.push(null);
            }
            break;
          }
          case 'use_main':
            current = frame;
            observations.push(null);
            break;
          case 'activate':
            observations.push(await handle.evaluate(clickThrough));
            break;
          case 'activate_item': {
            const { Core } = require('../src/core');
            const driver = {
              realClick: (scope, held) => acting.realClick(scope, held),
              clickInFrame,
              axElementHandle: (scope, item) => scope.evaluateHandle(
                (i) => (window[Symbol.for('tweb.ax')] || [])[i], item.axIndex),
            };
            const core = new Core({
              driver, page: acting, source: step.source || 'ax', sources: ['ax'],
            });
            const item = { ...step.item };
            if (item.frame && item.frame.id) {
              item.frame = new FirefoxFrame(session, item.frame.id, acting);
            }
            if (item.pressFrame && item.pressFrame.id) {
              item.pressFrame = new FirefoxFrame(session, item.pressFrame.id, acting);
            }
            observations.push(await core.activate(item, acting));
            break;
          }
          case 'focus_control':
            observations.push(await handle.evaluate((el) => { el.focus(); return true; }));
            break;
          case 'submits_autofilled':
            observations.push(await handle.evaluate(submitsAutofilled));
            break;
          case 'set_files':
            observations.push(await acting.setFiles(handle, step.paths));
            break;
          case 'real_click': {
            // As core.realClickHandle, without the reader's navigation wait:
            // the check first, then the browser's own click.
            const ready = await handle.evaluate(prepareRealClick);
            if (!ready || !ready.ok) {
              observations.push(ready === undefined ? null : ready);
              break;
            }
            await acting.realClick(current, handle);
            observations.push({ ok: true });
            break;
          }
          case 'hover': {
            const ready = await handle.evaluate(prepareRealClick);
            if (!ready || !ready.ok) {
              observations.push(ready === undefined ? null : ready);
              break;
            }
            await acting.hover(current, handle, ready);
            observations.push({ ok: true });
            break;
          }
          case 'key_type':
            await keyboard.type(step.text);
            observations.push(null);
            break;
          case 'key_press':
            await keyboard.press(step.key);
            observations.push(null);
            break;
          case 'key_error':
            try {
              await keyboard.press(step.key);
              observations.push(null);
            } catch (error) {
              observations.push(error.message);
            }
            break;
          case 'click_slider':
            await acting.clickSlider(current, handle, step.ratio, step.orientation);
            observations.push(null);
            break;
          default:
            throw new Error(`unknown handle scenario op ${step.op}`);
        }
      }
    } finally {
      await session.send('session.end', {}).catch(() => {});
      session.close();
    }
    return observations;
  };

  const implementations = [{ name: 'JavaScript', handleScenario }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    handleScenario(url, script) {
      return callAsync('firefox.handle_scenario', { url, script });
    },
  });
  return implementations;
}

function marionetteImplementations(javascript) {
  const implementations = [{
    name: 'JavaScript',
    clearAutomation(port) { return javascript.clearAutomationFlag({ port }); },
    releaseStranded(port) { return javascript.releaseStrandedSession(port); },
  }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    clearAutomation(port) {
      return callAsync('marionette.clear_automation', { port });
    },
    releaseStranded(port) {
      return callAsync('marionette.release_stranded', { port });
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

function liveImplementations(javascript) {
  const scenario = (script) => {
    const { Core } = require('../src/core');
    const core = new Core({ driver: {}, page: {}, source: 'ax', sources: ['ax'] });
    const observations = [];
    const at = (now, fn) => {
      const before = Date.now;
      Date.now = () => now;
      try { return fn(); } finally { Date.now = before; }
    };
    for (const step of script) {
      switch (step.op) {
        case 'enabled': core.live.enabled = step.value; observations.push(null); break;
        case 'refreshing': core.live.refreshing = step.value; observations.push(null); break;
        case 'classify': observations.push(core.classify(step.payload)); break;
        case 'notifies': observations.push(core.live.notifies); break;
        case 'mark_input': at(step.now, () => core.markInput()); observations.push(null); break;
        case 'reading': observations.push(at(step.now, () => core.reading())); break;
        default: throw new Error(`unknown live scenario op ${step.op}`);
      }
    }
    return observations;
  };
  const implementations = [{ name: 'JavaScript', ...javascript, scenario }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    createLiveState() { return call('live.create_state', {}); },
    refreshDue(state, now) { return call('live.refresh_due', { state, now }); },
    scenario(script) { return call('live.classify_scenario', { script }); },
    watcherScenario(url, script) {
      return callAsync('live.watcher_scenario', { url, script });
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

// A scripted pass over the reader's line-space place-keeping: a view set,
// positions asked for, text located, the cursor landed. The JavaScript
// original runs the script in-process over src/place.js, so the same
// assertions can be made about both.
function placeImplementations(place) {
  const scenario = (script) => {
    let state = null;
    const observations = [];
    const positionOf = (found) => found && {
      line: found.line, col: found.col, end: found.end, blockIndex: found.blockIndex,
    };
    for (const step of script) {
      switch (step.op) {
        case 'state':
          state = {
            source: step.source,
            cursor: step.cursor === undefined ? 0 : step.cursor,
            col: step.col === undefined ? 0 : step.col,
            blocks: step.blocks.map((block) => ({ text: block.text, item: block.item })),
            lines: step.lines,
          };
          observations.push(null);
          break;
        case 'positions_at_line':
          observations.push(place.positionsAtLine(state, step.line).map(positionOf));
          break;
        case 'position_of_block':
          observations.push(positionOf(place.positionOfBlock(state, step.block)));
          break;
        case 'block_index_at_line':
          observations.push(place.blockIndexAtLine(state, step.line, step.col === undefined ? 0 : step.col));
          break;
        case 'has_element':
          observations.push(place.hasElement(
            step.source === undefined ? state.source : step.source, step.item));
          break;
        case 'index_of_item':
          observations.push(place.indexOfItem(
            step.source === undefined ? state.source : step.source, step.item));
          break;
        case 'anchor': {
          // The LOOKBACK walk capturePlace runs before it resolves an
          // element, inlined here exactly as src/place.js has it.
          let found = null;
          for (let i = step.block; i >= 0 && step.block - i <= place.LOOKBACK_BLOCKS; i -= 1) {
            const block = state.blocks[i];
            if (block && place.hasElement(state.source, block.item)) { found = i; break; }
          }
          observations.push(found);
          break;
        }
        case 'locate_by_text':
          observations.push(place.locateByText(state, step.place));
          break;
        case 'cursor':
          observations.push({ cursor: state.cursor, col: state.col });
          break;
        case 'land_on':
          observations.push(place.landOn(state, step.block, step.place, !!step.exact));
          break;
        case 'refine_to_text': {
          const refined = place.refineToText(state, step.from, step.place);
          observations.push({ line: refined.line, col: refined.col, exact: refined.exact });
          break;
        }
        default:
          throw new Error(`unknown place scenario op ${step.op}`);
      }
    }
    return observations;
  };

  const implementations = [{ name: 'JavaScript', scenario }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    scenario(script) { return call('place.scenario', { script }); },
  });
  return implementations;
}

// The element half of the place keeper: what a capture holds, and which
// fallback a restore settles on. The page itself is scripted — a stand-in
// element handle answers describeElement and locateElement with whatever the
// scenario set — so what the two runtimes are being compared on is the
// orchestration either side of the page.
function placeElementImplementations(place) {
  const keptJson = (kept) => (kept ? {
    source: kept.source,
    text: kept.text,
    col: kept.col,
    ratio: kept.ratio,
    onElement: !!kept.onElement,
    label: kept.label,
    ordinal: kept.ordinal === undefined ? null : kept.ordinal,
    total: kept.total === undefined ? null : kept.total,
    held: !!kept.handle,
    frame: kept.frame === undefined ? null : kept.frame,
  } : null);

  const scenario = async (script) => {
    let state = null;
    let captured = null;
    const elements = {
      description: null, location: null, refuses: false,
      described: [], arrays: [], releases: 0,
    };
    // The real core disposes of a handle it could not describe, so the
    // stand-in counts that disposal too and the release count means the same
    // thing on both sides of the differential.
    const makeHandle = () => ({
      async evaluate(fn, arg) {
        if (arg === undefined) return elements.description;
        elements.arrays.push(arg);
        return elements.location;
      },
      async dispose() { elements.releases += 1; },
    });
    const resolveHandle = async (item) => {
      elements.described.push(item);
      if (elements.refuses) throw new Error('this line carries no element reference');
      return makeHandle();
    };
    // A place handed in by the scenario rather than captured: the handle is
    // what `held` means, so one is attached when the scenario says so.
    const placeOf = (step) => {
      if (!step.place) return captured;
      return { ...step.place, handle: step.place.held ? makeHandle() : null };
    };
    const observations = [];
    for (const step of script) {
      switch (step.op) {
        case 'state':
          state = {
            source: step.source,
            cursor: step.cursor === undefined ? 0 : step.cursor,
            col: step.col === undefined ? 0 : step.col,
            blocks: step.blocks.map((block) => ({ text: block.text, item: block.item })),
            lines: step.lines,
          };
          observations.push(null);
          break;
        case 'elements':
          elements.description = step.description === undefined ? null : step.description;
          elements.location = step.location === undefined ? null : step.location;
          elements.refuses = !!step.refuses;
          observations.push(null);
          break;
        case 'capture_place':
          captured = await place.capturePlace(state, resolveHandle);
          observations.push(keptJson(captured));
          break;
        case 'restore_place':
          observations.push((await place.restorePlace(state, null, placeOf(step))) ?? null);
          break;
        case 'locate_by_element': {
          const subject = placeOf(step);
          observations.push(subject
            ? ((await place.locateByElement(state, null, subject)) ?? null)
            : null);
          break;
        }
        case 'elements_seen':
          observations.push({
            described: elements.described,
            arrays: elements.arrays,
            releases: elements.releases,
          });
          break;
        case 'cursor':
          observations.push({ cursor: state.cursor, col: state.col });
          break;
        default:
          throw new Error(`unknown place element scenario op ${step.op}`);
      }
    }
    return observations;
  };

  const implementations = [{ name: 'JavaScript', scenario }];
  if (process.env.TAWB_TEST_CRYSTAL !== '1') return implementations;
  implementations.push({
    name: 'Crystal',
    async scenario(script) { return call('place.scenario', { script }); },
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
  call, callAsync, addressImplementations, ariaImplementations, bidiImplementations,
  blockImplementations, coreImplementations, coreTabImplementations,
  dumpImplementations, editImplementations,
  endpointImplementations,
  firefoxAgentImplementations,
  firefoxAutomationImplementations, firefoxHandleImplementations, firefoxLaunchImplementations,
  firefoxPageImplementations,
  inputImplementations, interfaceImplementations, keyWizardImplementations, keymapImplementations, layoutImplementations,
  liveImplementations, liveRealImplementations, lynxActionsImplementations, lynxConfigImplementations, lynxDisplayImplementations, lynxKeymapImplementations,
  lynxNumberImplementations, lynxOptionsImplementations, lynxPagesImplementations, lynxStateImplementations, marionetteImplementations, optionImplementations,
  placeElementImplementations, placeImplementations, readerCommands, readerImplementations, screenImplementations, sessionImplementations, unicodeImplementations,
};
