'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { tempDir, removeTempDir } = require('../tmpdir');

const { openDriver } = require('../../src/driver');
const { sendFieldEdit } = require('../../src/edit');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-edit-');
let driver;

test.after(async () => {
  if (driver) await driver.close();
  removeTempDir(profile);
});

test('typing and readline editing operate a browser text field', async () => {
  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto('data:text/html,<input value="alpha beta gamma">');
  await page.evaluate(() => {
    const field = document.querySelector('input');
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  });

  await sendFieldEdit(page.keyboard, 'word-backward');
  assert.equal(await page.evaluate(() => document.querySelector('input').selectionStart), 11);
  await sendFieldEdit(page.keyboard, 'delete-word-backward');
  assert.equal(await page.evaluate(() => document.querySelector('input').value), 'alpha gamma');
  await sendFieldEdit(page.keyboard, 'delete-line-forward');
  assert.equal(await page.evaluate(() => document.querySelector('input').value), 'alpha ');

  await page.evaluate(() => {
    const field = document.querySelector('input');
    field.value = '';
    field.focus();
  });
  const printableAscii = Array.from({ length: 95 }, (_, index) =>
    String.fromCharCode(0x20 + index)).join('');
  await page.keyboard.type(printableAscii);
  assert.equal(await page.evaluate(() => document.querySelector('input').value), printableAscii);
});
