// Generated from src/firefox.js libraryParentScript(); update with tools/update_crystal_assets.js.
const automationReport = () => {
    const keys = ["RemoteAgent:Active","Marionette:Active","RemoteAgent:IsBrowserAutomationRunning","Marionette:IsBrowserAutomationRunning"];
    const report = { keys: {}, shared: null, services: {}, processes: {} };
    for (const key of keys) {
      try {
        report.keys[key] = Services.ppmm.sharedData.get(key) ?? false;
      } catch (e) {
        report.keys[key] = String((e && e.message) || e).slice(0, 200);
      }
    }

    // Measured against Firefox 147, the parent process publishes 53 shared-data
    // keys and 49 of them are extension payloads — manifests, locales, content
    // scripts. Reporting all 53 at four phases of every startup buries the
    // handful that matter, so two filters decide what a key's value is worth:
    //
    //   - the value is a boolean. navigator.webdriver is a boolean computed
    //     from booleans, so a key of that shape is the only kind that can be
    //     the source CAUSE-1 describes. On Firefox 147 there are four.
    //   - the name mentions an automation component. A build that used a
    //     number or a string would still be caught by name.
    //
    // The total key count is kept either way, so a build publishing far more
    // or far fewer keys than expected is still visible.
    //
    // Values are reduced to primitives, because one large or unserializable
    // entry must not cost the rest of the report.
    try {
      const interesting = /marionette|remote.?agent|webdriver|automation/i;
      const values = {};
      let count = 0;
      for (const name of Services.ppmm.sharedData.keys()) {
        const key = String(name);
        count += 1;
        let value;
        try {
          value = Services.ppmm.sharedData.get(name);
        } catch (e) {
          values[key] = "unreadable";
          continue;
        }
        const kind = typeof value;
        if (kind !== "boolean" && !interesting.test(key)) continue;
        if (kind === "boolean" || kind === "number") values[key] = value;
        else if (kind === "string") values[key] = value.slice(0, 200);
        else values[key] = kind;
      }
      report.shared = { count, values };
    } catch (e) {
      report.shared = { error: String((e && e.message) || e).slice(0, 200) };
    }

    const browserAutomationRunning = (contract, iface) => {
      try {
        if (!Ci[iface]) return "no such interface";
        const service = Cc[contract].getService(Ci[iface]);
        if (!service) return "no such service";
        // Added in Firefox 155, when Navigator.webdriver changed to consult
        // this narrower property. Older interfaces expose only running.
        if ("isBrowserAutomationRunning" in service) {
          return Boolean(service.isBrowserAutomationRunning);
        }
        return Boolean(service.running);
      } catch (e) {
        return String((e && e.message) || e).slice(0, 200);
      }
    };
    report.services.marionette = browserAutomationRunning(
      "@mozilla.org/remote/marionette;1", "nsIMarionette");
    report.services.remoteAgent = browserAutomationRunning(
      "@mozilla.org/remote/agent;1", "nsIRemoteAgent");

    const appinfo = (name) => {
      try {
        const value = Services.appinfo[name];
        return value === undefined ? null : value;
      } catch (e) {
        return String((e && e.message) || e).slice(0, 200);
      }
    };
    report.processes = {
      remoteTabs: appinfo("browserTabsRemoteAutostart"),
      fission: appinfo("fissionAutostart"),
      maxWebProcesses: appinfo("maxWebProcessCount"),
      children: (() => {
        try { return Services.ppmm.childCount; } catch (e) { return null; }
      })(),
    };
    return report;
  };


  const { PlacesUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/PlacesUtils.sys.mjs");
  const { Downloads } = ChromeUtils.importESModule(
    "resource://gre/modules/Downloads.sys.mjs");
  const ROOTS = {"toolbar_____":"Bookmarks toolbar","menu________":"Bookmarks menu","unfiled_____":"Other bookmarks","mobile______":"Mobile bookmarks"};

  // Newest first, and no further back than the reader can use. This is
  // nsINavHistoryService — the query the Library itself runs.
  const history = function ({ max }) {
    const service = PlacesUtils.history.QueryInterface(Ci.nsINavHistoryService);
    const query = service.getNewQuery();
    const options = service.getNewQueryOptions();
    options.sortingMode = options.SORT_BY_DATE_DESCENDING;
    options.resultType = options.RESULTS_AS_URI;
    options.maxResults = max;
    const root = service.executeQuery(query, options).root;
    root.containerOpen = true;
    const out = [];
    try {
      for (let i = 0; i < root.childCount; i++) {
        const node = root.getChild(i);
        out.push({
          title: String(node.title || ""),
          url: String(node.uri || ""),
          when: node.time ? Math.round(node.time / 1000) : null,
        });
      }
    } finally {
      root.containerOpen = false;
    }
    return Promise.resolve(out);
  };

  // The whole bookmark tree, flattened, each entry carrying the folders above
  // it. A tag is stored as a bookmark too — under the tags root, pointing at
  // the page it tags — so that subtree is left out: listing it shows every
  // tagged page once per tag, filed under folders the reader never made.
  const bookmarks = async function () {
    const tree = await PlacesUtils.promiseBookmarksTree();
    const out = [];
    const walk = (node, trail) => {
      if (!node) return;
      if (node.guid === PlacesUtils.bookmarks.tagsGuid) return;
      if (node.uri) {
        out.push({
          bookmarkGuid: String(node.guid || ""),
          title: String(node.title || ""),
          url: String(node.uri),
          folder: trail.join("/"),
          when: node.dateAdded ? Math.round(node.dateAdded / 1000) : null,
        });
        return;
      }
      const name = ROOTS[node.guid] || String(node.title || "");
      const here = name ? trail.concat([name]) : trail;
      for (const child of node.children || []) walk(child, here);
    };
    walk(tree, []);
    return out;
  };

  // Every download the browser still remembers, finished or not.
  const downloads = async function () {
    const list = await Downloads.getList(Downloads.ALL);
    const all = await list.getAll();
    return all.map((item) => {
      const target = (item.target && item.target.path) || "";
      const state = item.succeeded ? "complete"
        : item.canceled ? (item.hasPartialData ? "paused" : "cancelled")
        : item.error ? "failed"
        : item.stopped ? "stopped" : "in progress";
      return {
        title: target.split("/").pop() || target,
        file: target,
        url: String((item.source && item.source.url) || ""),
        state,
        bytes: Number(item.currentBytes) || 0,
        totalBytes: Number(item.totalBytes) || 0,
        when: item.startTime ? Number(new Date(item.startTime)) : null,
      };
    });
  };

  // Filing a bookmark, which is the one thing here that writes. It goes
  // through PlacesUtils like the reading does, because the bookmark tree is
  // the browser's own and its file is not ours to write into.
  //
  // A browser does not make a second bookmark of a page you have already
  // bookmarked; Firefox's own star opens the editor instead. So an existing
  // one is reported rather than duplicated. New ones are filed in "Other
  // bookmarks", which is where the star files one.
  const save = async function ({ url, title }) {
    const existing = await PlacesUtils.bookmarks.fetch({ url }).catch(() => null);
    if (existing) {
      const parent = await PlacesUtils.bookmarks.fetch(existing.parentGuid).catch(() => null);
      return {
        existed: true,
        title: String(existing.title || ""),
        folder: ROOTS[existing.parentGuid] || String((parent && parent.title) || ""),
      };
    }
    const guid = PlacesUtils.bookmarks.unfiledGuid;
    const made = await PlacesUtils.bookmarks.insert({ parentGuid: guid, url, title });
    return {
      existed: false,
      title: String(made.title || title || ""),
      folder: ROOTS[guid] || "Other bookmarks",
    };
  };

  const remove = async function ({ bookmarkGuid }) {
    if (!bookmarkGuid) throw new Error("bookmark has no browser identity");
    await PlacesUtils.bookmarks.remove(bookmarkGuid);
    return { removed: true };
  };

  // Some Firefox releases appear to publish automation state again while a
  // BiDi session starts. This agent outlives the Marionette session that
  // installed it, so diagnostics can observe each transition and the reader
  // can clear the keys after BiDi has finished. Keeping this in the parent
  // process avoids changing anything a webpage can inspect.
  //
  // automationState answers with the full report, because every caller of
  // automationState is asking why a clear did not take. clearAutomation
  // answers with the targeted keys it changed, plus one report of the state
  // it left behind.
  const targetedKeys = function () {
    const keys = ["RemoteAgent:Active","Marionette:Active","RemoteAgent:IsBrowserAutomationRunning","Marionette:IsBrowserAutomationRunning"];
    return Object.fromEntries(
      keys.map((key) => [key, Services.ppmm.sharedData.get(key) ?? false]));
  };
  const automationState = async function () {
    return automationReport();
  };
  const clearAutomation = async function () {
    const before = targetedKeys();
    for (const key of ["RemoteAgent:Active","Marionette:Active","RemoteAgent:IsBrowserAutomationRunning","Marionette:IsBrowserAutomationRunning"]) Services.ppmm.sharedData.set(key, false);
    Services.ppmm.sharedData.flush();
    return { before, after: targetedKeys(), report: automationReport() };
  };

  const answer = {
    bookmarks, history, downloads, save, remove, automationState, clearAutomation,
  };
  const { require: devtoolsRequire } = ChromeUtils.importESModule(
    "resource://devtools/shared/loader/Loader.sys.mjs");
  const { DebuggerTransport } = devtoolsRequire(
    "resource://devtools/shared/transport/transport.js");
  const clients = new Set();
  const server = Cc["@mozilla.org/network/server-socket;1"]
    .createInstance(Ci.nsIServerSocket);

  // An ephemeral loopback port. A normal page cannot open raw TCP, and the
  // DevTools packet reader rejects the GET line of HTTP and WebSocket before
  // it can become an object below.
  server.init(-1, true, -1);
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIServerSocketListener"]),
    onSocketAccepted(_server, socket) {
      const input = socket.openInputStream(0, 0, 0);
      const output = socket.openOutputStream(0, 0, 0);
      const transport = new DebuggerTransport(input, output);
      clients.add(transport);
      transport.hooks = {
        async onPacket(packet) {
          const data = packet && typeof packet === "object" ? packet : {};
          const kind = String(data.kind || "");
          const ask = answer[kind];
          if (!ask) {
            transport.send({ error: "unknown list" });
            return;
          }
          const request = {
            max: Math.max(1, Math.min(5000, Number(data.max) || 1000)),
            url: data.url == null ? null : String(data.url).slice(0, 10000),
            title: data.title == null ? null : String(data.title).slice(0, 1000),
            bookmarkGuid: data.bookmarkGuid == null
              ? null : String(data.bookmarkGuid).slice(0, 100),
          };
          try {
            transport.send({ result: await ask(request) });
          } catch (e) {
            transport.send({ error: String((e && e.message) || e) });
          }
        },
        onBulkPacket() { transport.close(); },
        onTransportClosed() { clients.delete(transport); },
      };
      transport.ready();
    },
    onStopListening() {},
  };
  server.asyncListen(listener);

  // The message manager outlives the Marionette sandbox and holds this
  // closure, which in turn holds the server, listener and active transports.
  Services.ppmm.addMessageListener("tweb:library-agent-keepalive", function () {
    return server.port;
  });

return server.port;
