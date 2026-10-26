'use strict';

// TAWB starting a Flatpak browser, through its own launcher and nothing else.
//
// `launchFirefox` is the production path: it finds the browser, decides where
// the profile goes, starts the private bus, starts the document portal because
// the browser is a Flatpak one, builds the `flatpak run` command line, and
// waits for the browser's remote debugging port. Everything this probe knows
// is what came back from it.
//
// Then the two questions a launch has to answer to be worth anything:
//
//   * is the browser on the accessibility bus, and findable as the browser
//     this program started — which is a process match, and the pid the bus
//     reports for a sandboxed connection is the proxy's, not the browser's;
//   * is the chooser's answer reachable inside the sandbox, which is the
//     document portal's job.
//
// Run as a user who is not root: TAWB refuses to launch a browser as root.

const { launchFirefox, findFirefox } = require('/app/src/firefox');
const { openAccessibility } = require('/app/src/atspi');

function say(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`);
}

async function main() {
  process.env.TAWB_A11Y_BUS = 'private';

  const found = findFirefox();
  say('found', found ? {
    executable: found.executable, name: found.name, appId: found.flatpak && found.flatpak.appId,
  } : null);
  if (!found) process.exit(2);

  const started = await launchFirefox({ log: (event, detail) => say(event, detail) });
  say('launched', {
    port: started.port,
    marionettePort: started.marionettePort,
    profileDir: started.profileDir,
    rejoined: started.rejoined,
    a11yAvailable: started.a11y.available,
    a11yAddress: started.a11y.address,
    pid: started.child ? started.child.pid : null,
  });

  // The browser, as this program finds it: by process, on the accessibility
  // bus. A Flatpak browser reaches the bus through a proxy, so the pid the bus
  // reports is the proxy's — and the match is on the process *group*, which
  // the proxy shares with the `flatpak run` this program started.
  if (started.a11y.available && started.child) {
    const tree = await openAccessibility({ address: started.a11y.address });
    const application = await tree.applicationFor({ pid: started.child.pid });
    say('application', application ? {
      name: application.name, role: application.role, bus: application.bus,
    } : null);
    const everything = await tree.applications();
    say('applications', { count: everything.length, names: everything.map((each) => each.name) });
    tree.close();
  }

  // Leave nothing behind: the browser, the bus, and the document portal.
  if (started.child) {
    try { process.kill(-started.child.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await started.a11y.close();
  say('done', {});
  process.exit(0);
}

main().catch((err) => {
  say('failed', { error: String(err.stack || err) });
  process.exit(1);
});
