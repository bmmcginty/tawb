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
    'frame-target-top': {
        'summary': 'press a hidden frame control in the tab\'s top document instead of its own',
        'build': True,
    },
    'navigation-subscription': {
        'summary': 'stop subscribing to and following the load navigation event',
        'build': True,
    },
    'early-status-fallback': {
        'summary': 'paint the link fallback at the start of an action instead of after it',
        'build': True,
    },
    'keymap-action': {
        'summary': 'drop the next-line action from the browse keymap dispatch',
        'build': True,
    },
    'update-rename-failure': {
        'summary': 'report a failed update replacement as a completed install',
        'build': True,
    },
    'typed-row-generation': {
        'summary': 'keep the old caret column after a write invalidated the typed-row patch',
        'build': True,
    },
    'repaint-scope': {
        'summary': 'repaint the whole list where only a few rows changed',
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
        '''        @session.command("script.disown", {
          "handles" => JSON::Any.new([JSON::Any.new(@handle)]),
          "target"  => JSON::Any.new({"context" => JSON::Any.new(@context_id)}),
        })
''',
        '        # mutation: the held element is never disowned\n',
    )


def scroll_region_reset(root):
    replace(
        root,
        'crystal/src/tawb/reader.cr',
        '      output.write("\\e[r")\n',
        '',
    )


def frame_target_top(root):
    replace(
        root,
        'crystal/src/tawb/actions.cr',
        '      frame = page.frame_for(frame_id)\n',
        '      frame = page.frame_for(page.document_id)\n',
    )


def navigation_subscription(root):
    replace(
        root,
        'crystal/src/tawb/firefox_driver.cr',
        '      "browsingContext.load",\n',
        '',
    )


def early_status_fallback(root):
    replace(
        root,
        'crystal/src/tawb/reader_keys.cr',
        '      Reader.note_input(state)\n      actions = mode_actions(output, page.url, keyboard)\n',
        '      Reader.note_input(state)\n      Reader.draw_status(output, state, page.url)\n'
        '      actions = mode_actions(output, page.url, keyboard)\n',
    )


def keymap_action(root):
    replace(
        root,
        'crystal/src/tawb/keys.cr',
        '              @sequence_actions[sequence] = action.id if keyboards.includes?("browse")\n',
        '              @sequence_actions[sequence] = action.id '
        'if keyboards.includes?("browse") && action.id != "next-line"\n',
    )


def update_rename_failure(root):
    replace(
        root,
        'crystal/src/tawb/update.cr',
        '''        unless replace_installed(temporary_path, target)
          raise Error.new("could not replace #{target}: the rename failed")
        end
        installed = true
''',
        '''        replace_installed(temporary_path, target)
        installed = true
''',
    )


def typed_row_generation(root):
    replace(
        root,
        'crystal/src/tawb/reader_keys.cr',
        '        current_col: output.generation == output_generation ? old_caret_col : nil,\n',
        '        current_col: old_caret_col,\n',
    )


def repaint_scope(root):
    replace(
        root,
        'crystal/src/tawb/reader.cr',
        '        if scroll == state.scroll && height == viewport_height(state)\n',
        '        if false && scroll == state.scroll && height == viewport_height(state)\n',
    )


APPLY = {
    'privileged-media': privileged_media,
    'native-control-field': native_control_field,
    'live-refresh-guard': live_refresh_guard,
    'browser-discovery': browser_discovery,
    'handle-dispose': handle_dispose,
    'scroll-region-reset': scroll_region_reset,
    'frame-target-top': frame_target_top,
    'navigation-subscription': navigation_subscription,
    'early-status-fallback': early_status_fallback,
    'keymap-action': keymap_action,
    'update-rename-failure': update_rename_failure,
    'typed-row-generation': typed_row_generation,
    'repaint-scope': repaint_scope,
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
