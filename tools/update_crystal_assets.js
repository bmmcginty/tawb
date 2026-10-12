'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { extractAxItems } = require('../src/ax_own');
const { readFieldStateInPage, SCROLL_TO_BOTTOM, RESTORE_SCROLL, TEXT_AT_FRAGMENT } = require('../src/core');
const { clickThrough, prepareRealClick, submitsAutofilled } = require('../src/click');
const { sliderStateOf } = require('../src/core');
const { sliderGeometry } = require('../src/driver_firefox');
const { sliderTrack } = require('../src/driver_chromium');
const chromiumLibrary = require('../src/library_chromium');
const { extractVisible } = require('../src/render_html');
const { extractSource } = require('../src/source_html');
const { OBSERVER_SCRIPT, DRAIN_SCRIPT, PULSE_SCRIPT } = require('../src/live');
const { CLEAR_SCRIPT, PIERCE_PARENT_SCRIPT, libraryParentScript } = require('../src/firefox');
const { describeElement, locateElement } = require('../src/place');

const assets = {
  'extract_ax_items.js': {
    source: 'src/ax_own.js extractAxItems',
    value: `(${extractAxItems.toString()})({layout:false})`,
  },
  'firefox_clear.js': { source: 'src/firefox.js CLEAR_SCRIPT', value: CLEAR_SCRIPT },
  'firefox_pierce.js': { source: 'src/firefox.js PIERCE_PARENT_SCRIPT', value: PIERCE_PARENT_SCRIPT },
  'firefox_library.js': { source: 'src/firefox.js libraryParentScript()', value: libraryParentScript() },
  'read_field_state.js': { source: 'src/core.js readFieldStateInPage', value: readFieldStateInPage.toString() },
  'click_through.js': { source: 'src/click.js clickThrough', value: clickThrough.toString() },
  'prepare_real_click.js': {
    source: 'src/click.js prepareRealClick', value: prepareRealClick.toString(),
  },
  'submits_autofilled.js': {
    source: 'src/click.js submitsAutofilled', value: submitsAutofilled.toString(),
  },
  'slider_state.js': { source: 'src/core.js sliderStateOf', value: sliderStateOf.toString() },
  'slider_geometry.js': {
    source: 'src/driver_firefox.js sliderGeometry', value: sliderGeometry.toString(),
  },
  'live_observer.js': { source: 'src/live.js OBSERVER_SCRIPT', value: OBSERVER_SCRIPT.toString() },
  'live_drain.js': { source: 'src/live.js DRAIN_SCRIPT', value: DRAIN_SCRIPT.toString() },
  'live_pulse.js': { source: 'src/live.js PULSE_SCRIPT', value: PULSE_SCRIPT.toString() },
  'scroll_to_bottom.js': {
    source: 'src/core.js SCROLL_TO_BOTTOM', value: SCROLL_TO_BOTTOM.toString(),
  },
  'restore_scroll.js': { source: 'src/core.js RESTORE_SCROLL', value: RESTORE_SCROLL.toString() },
  'text_at_fragment.js': {
    source: 'src/core.js TEXT_AT_FRAGMENT', value: TEXT_AT_FRAGMENT.toString(),
  },
  'describe_element.js': {
    source: 'src/place.js describeElement', value: describeElement.toString(),
  },
  'locate_element.js': {
    source: 'src/place.js locateElement', value: locateElement.toString(),
  },
  'slider_track.js': {
    source: 'src/driver_chromium.js sliderTrack', value: sliderTrack.toString(),
  },
  'chromium_bookmarks.js': {
    source: 'src/library_chromium.js readBookmarks',
    value: chromiumLibrary.READERS.bookmarks.toString(),
  },
  'chromium_history.js': {
    source: 'src/library_chromium.js readHistory',
    value: chromiumLibrary.READERS.history.toString(),
  },
  'chromium_downloads.js': {
    source: 'src/library_chromium.js readDownloads',
    value: chromiumLibrary.READERS.downloads.toString(),
  },
  'chromium_save_bookmark.js': {
    source: 'src/library_chromium.js saveBookmark',
    value: chromiumLibrary.saveBookmark.toString(),
  },
  'chromium_remove_bookmark.js': {
    source: 'src/library_chromium.js removeBookmark',
    value: chromiumLibrary.removeBookmark.toString(),
  },
  'chromium_ready_bookmarks.js': {
    source: 'src/library_chromium.js READY.bookmarks',
    value: chromiumLibrary.READY.bookmarks.toString(),
  },
  'chromium_ready_history.js': {
    source: 'src/library_chromium.js READY.history',
    value: chromiumLibrary.READY.history.toString(),
  },
  'chromium_ready_downloads.js': {
    source: 'src/library_chromium.js READY.downloads',
    value: chromiumLibrary.READY.downloads.toString(),
  },
  'extract_visible.js': {
    source: 'src/render_html.js extractVisible', value: extractVisible.toString(),
  },
  'extract_source.js': {
    source: 'src/source_html.js extractSource', value: extractSource.toString(),
  },
};

for (const [name, { source, value }] of Object.entries(assets)) {
  const target = path.join(__dirname, '..', 'crystal', 'assets', name);
  const header = `// Generated from ${source}; update with tools/update_crystal_assets.js.\n`;
  fs.writeFileSync(target, `${header}${value.trim()}\n`);
}
