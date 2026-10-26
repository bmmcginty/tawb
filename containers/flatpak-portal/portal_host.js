'use strict';

// TAWB's private session bus and file chooser, standing alone.
//
// This is the production path and not a model of it: `openAccessibilityBus`
// starts the same `dbus-daemon` with the same configuration TAWB gives a
// browser, and `servePortal` installs the same `serveFileChooser`. The only
// thing missing is a terminal, so the chooser answers with a fixed path
// instead of asking a reader.
//
// The script prints one JSON line per event on stdout and stays alive until
// stdin closes, so a shell script can hold the bus open while it runs a
// Flatpak application against the address printed on the `bus` line.

const { openAccessibilityBus } = require('/app/src/a11y_bus');

// What the chooser answers with. A test wants to see this exact path arrive in
// the application, so it is given rather than chosen.
const CHOSEN_FILE = process.env.PORTAL_CHOSEN_FILE || '/tmp/portal-answer/chosen file.txt';
const CHOSEN_DIR = process.env.PORTAL_CHOSEN_DIR || '/tmp/portal-answer';

function say(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`);
}

async function main() {
  process.env.TAWB_A11Y_BUS = 'private';
  // The document portal is what makes a chosen path reachable inside a
  // Flatpak sandbox, and a launcher asks for it only when the browser it is
  // about to start is a Flatpak one. The test asks for it the same way.
  const documents = process.env.PORTAL_DOCUMENTS === '1';
  const bus = await openAccessibilityBus({
    documents, log: (event, detail) => say(event, detail),
  });
  if (!bus.available) {
    say('bus.failed', { reason: bus.reason });
    process.exit(2);
  }
  const service = await bus.servePortal({
    ask: async (request) => {
      say('portal.asked', request);
      // The title is how the probe inside the sandbox says which answer it
      // wants, because the probe cannot reach this process any other way.
      const title = String(request.title || '');
      if (title.includes('cancel')) return null;
      if (title.includes('slow')) await new Promise((done) => setTimeout(done, 5000));
      if (request.directory) return [CHOSEN_DIR];
      if (request.saving) return [`${CHOSEN_DIR}/${request.name || 'saved.txt'}`];
      return [CHOSEN_FILE];
    },
  });
  say('bus', {
    documents,
    address: bus.address,
    owned: bus.owned,
    portal: service ? service.version : null,
    env: bus.env,
  });

  const leave = async (code) => {
    await bus.close();
    process.exit(code);
  };
  process.on('SIGTERM', () => { leave(0); });
  process.on('SIGINT', () => { leave(0); });
  // The shell script that started this holds its stdin. When that script is
  // finished, the bus goes away with it rather than outliving the test.
  process.stdin.resume();
  process.stdin.on('end', () => { leave(0); });
}

main().catch((err) => {
  say('failed', { error: String(err.stack || err) });
  process.exit(1);
});
