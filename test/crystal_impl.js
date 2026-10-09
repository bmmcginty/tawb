'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { PassThrough } = require('node:stream');

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

function callAsync(operation, payload, { env = {} } = {}) {
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
    }, 10000);
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
    const core = new javascript.Core({ driver: {}, page: {}, source: 'source', sources: ['source'] });
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
                item: block.item === undefined ? { name: block.text, domIndex: i } : block.item,
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
  call, callAsync, addressImplementations, ariaImplementations, bidiImplementations,
  blockImplementations, coreImplementations, dumpImplementations, endpointImplementations,
  firefoxAgentImplementations,
  firefoxAutomationImplementations, firefoxLaunchImplementations, firefoxPageImplementations,
  inputImplementations, interfaceImplementations, keymapImplementations, layoutImplementations,
  lynxDisplayImplementations, lynxKeymapImplementations,
  lynxNumberImplementations, marionetteImplementations, optionImplementations,
  readerCommands, sessionImplementations, unicodeImplementations,
};
