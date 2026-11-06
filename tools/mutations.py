#!/usr/bin/env python3
"""Named regressions for the parity gates.

Each mutation is a deliberately small, single-hunk regression in code the
gates claim to cover. tools/test_mutations.sh applies one to a scratch copy of
the tree, rebuilds it when needed, and requires the named gate to fail. A
mutation that survives names a real coverage gap rather than a broken script.

Applying a mutation asserts that its target text appears exactly once, so a
refactor cannot silently turn the mutation into a no-op.
"""

import pathlib
import sys

MUTATIONS = {
    'privileged-media': {
        'summary': 'stop taking the privileged AX pass that carries Firefox native media controls',
        'build': True,
    },
    'native-control-field': {
        'summary': 'drop nativeControl from the canonical block contract',
        'build': True,
    },
    'live-refresh-guard': {
        'summary': 'refresh a live buffer while another refresh is already running',
        'build': True,
    },
    'browser-discovery': {
        'summary': 'omit the live-update browser differential from the discovered suite',
        'build': False,
    },
    'handle-dispose': {
        'summary': 'stop disowning the element handle a Firefox action held',
        'build': True,
    },
    'scroll-region-reset': {
        'summary': 'repaint the list without resetting the terminal scroll region',
        'build': True,
    },
}


def replace(root, relative, old, new):
    path = root / relative
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f'{relative}: mutation target appears {count} times, expected exactly one'
        )
    path.write_text(text.replace(old, new, 1))


def privileged_media(root):
    replace(
        root,
        'crystal/src/tawb/firefox_driver.cr',
        '        return items unless items.empty? || has_media_controls?(context_id)\n',
        '        return items\n',
    )


def native_control_field(root):
    replace(
        root,
        'crystal/src/tawb/conformance.cr',
        '          next if raw[name].raw.nil?\n',
        '          next if raw[name].raw.nil? || name == "nativeControl"\n',
    )


def live_refresh_guard(root):
    replace(
        root,
        'crystal/src/tawb/live.cr',
        '      return false unless live.enabled && live.dirty && !live.refreshing\n',
        '      return false unless live.enabled && live.dirty\n',
    )


def browser_discovery(root):
    replace(
        root,
        'tools/test_crystal_browser.sh',
        '    test/browser/live_crystal.test.js "$@"\n',
        '    "$@"\n',
    )


def handle_dispose(root):
    replace(
        root,
        'crystal/src/tawb/firefox_driver.cr',
        '        @session.command("script.disown", {\n',
        '        @session.command("script.disown-disabled", {\n',
    )


def scroll_region_reset(root):
    replace(
        root,
        'crystal/src/tawb/reader.cr',
        '      output.write("\\e[r")\n',
        '',
    )


APPLY = {
    'privileged-media': privileged_media,
    'native-control-field': native_control_field,
    'live-refresh-guard': live_refresh_guard,
    'browser-discovery': browser_discovery,
    'handle-dispose': handle_dispose,
    'scroll-region-reset': scroll_region_reset,
}


def names():
    return '\n'.join(MUTATIONS)


def main(argv):
    if len(argv) == 2 and argv[1] == 'names':
        print(names())
        return 0
    if len(argv) == 2 and argv[1] == 'list':
        for name, entry in MUTATIONS.items():
            print(f'{name}: {entry["summary"]}')
        return 0
    if len(argv) == 3 and argv[1] == 'needs-build':
        print('yes' if MUTATIONS[argv[2]]['build'] else 'no')
        return 0
    if len(argv) == 4 and argv[1] == 'apply':
        name, directory = argv[2], argv[3]
        if name not in APPLY:
            print(f'unknown mutation {name!r}; use --list to see them', file=sys.stderr)
            return 2
        APPLY[name](pathlib.Path(directory))
        return 0
    print('usage: mutations.py names|list|needs-build NAME|apply NAME DIR', file=sys.stderr)
    return 2


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
