// Generated from src/firefox.js CLEAR_SCRIPT; update with tools/update_crystal_assets.js.
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

  const keys = ["RemoteAgent:Active","Marionette:Active","RemoteAgent:IsBrowserAutomationRunning","Marionette:IsBrowserAutomationRunning"];
  const state = () => Object.fromEntries(
    keys.map((key) => [key, Services.ppmm.sharedData.get(key) ?? false]));
  const before = state();
  for (const key of keys) Services.ppmm.sharedData.set(key, false);
  Services.ppmm.sharedData.flush();
  return { before, after: state(), report: automationReport() };
