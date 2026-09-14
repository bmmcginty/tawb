'use strict';

// Naming a file to attach.
//
// A file input is the one control a reader cannot press: pressing it asks the
// desktop for a chooser that belongs to another process entirely, and on a
// machine with no portal there is no chooser at all. So the question is asked
// on the terminal instead, and a terminal is better at it than any dialog —
// as long as completion behaves the way a shell's does, and as long as a path
// that will not work is refused here rather than handed to a browser that
// takes it silently and gives the page a file that is not there.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  expandPath, completePath, fileToAttach, fileSize, attachedNote, restoreInvocationDirectory,
} = require('../src/index');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tawb-files-'));
fs.writeFileSync(path.join(dir, 'report.txt'), 'a report\n');
fs.writeFileSync(path.join(dir, 'report-two.txt'), 'another\n');
fs.writeFileSync(path.join(dir, 'photo.jpg'), 'not really a photo');
fs.mkdirSync(path.join(dir, 'archive'));

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('npm launch restores the directory where the reader invoked tawb', () => {
  const changed = [];
  assert.equal(restoreInvocationDirectory(
    { INIT_CWD: dir }, (target) => changed.push(target)), true);
  assert.deepEqual(changed, [dir]);
  assert.equal(restoreInvocationDirectory({ INIT_CWD: 'relative' }, () => {}), false);
  assert.equal(restoreInvocationDirectory({ INIT_CWD: dir }, () => { throw new Error('gone'); }), false);

  // The real process path, in a child so changing directory cannot interfere
  // with other tests: relative upload names resolve from INIT_CWD afterwards.
  const entry = path.join(__dirname, '..', 'src', 'index.js');
  const resolved = execFileSync(process.execPath, [
    '-e',
    `const tawb = require(${JSON.stringify(entry)}); tawb.restoreInvocationDirectory(); process.stdout.write(tawb.expandPath('upload.txt'));`,
  ], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, INIT_CWD: dir },
    encoding: 'utf8',
  });
  assert.equal(resolved, path.join(dir, 'upload.txt'));
});

test('a path is read the way the reader typed it', () => {
  assert.equal(expandPath('~'), os.homedir());
  assert.equal(expandPath('~/notes.txt'), path.join(os.homedir(), 'notes.txt'));
  // Relative to where tawb was started, which is where the reader was
  // standing when they typed the command.
  assert.equal(expandPath('notes.txt'), path.resolve('notes.txt'));
  assert.equal(expandPath('  /tmp/notes.txt  '), '/tmp/notes.txt');
  assert.equal(expandPath(''), '');
});

test('completion goes as far as it can without choosing', () => {
  // One match completes outright.
  assert.equal(completePath(path.join(dir, 'pho')).text, path.join(dir, 'photo.jpg'));

  // Two that share a prefix complete to the shared part and say so, rather
  // than picking one.
  const shared = completePath(path.join(dir, 'rep'));
  assert.equal(shared.text, path.join(dir, 'report'));
  assert.match(shared.note, /2 match/);
  assert.match(shared.note, /report\.txt/);

  // A directory completes with its separator, so the next Tab carries on
  // inside it.
  assert.equal(completePath(path.join(dir, 'arch')).text, path.join(dir, 'archive/'));

  // Nothing matching says so and leaves what was typed alone.
  const none = completePath(path.join(dir, 'zzz'));
  assert.equal(none.text, path.join(dir, 'zzz'));
  assert.match(none.note, /Nothing in/);

  // A directory nobody can read is a note, not a crash.
  assert.match(completePath('/does/not/exist/at/all').note, /not a directory/);
});

test('a path that will not work is refused before the browser sees it', () => {
  const good = fileToAttach(path.join(dir, 'report.txt'));
  assert.equal(good.error, undefined);
  assert.equal(good.name, 'report.txt');
  assert.equal(good.size, 9);

  assert.match(fileToAttach(path.join(dir, 'nope.txt')).error, /there is no/);
  assert.match(fileToAttach(dir).error, /is a directory/);
  assert.match(fileToAttach('').error, /no file named/);
});

test('what the reader is told afterwards names the file and its size', () => {
  const one = [{ name: 'report.txt', size: 9 }];
  assert.equal(attachedNote(one, 'Your document'), 'Attached report.txt (9 bytes) to "Your document".');
  const two = [{ name: 'a.txt', size: 1 }, { name: 'b.txt', size: 2 }];
  assert.match(attachedNote(two, 'Files'), /Attached 2 files to "Files": a\.txt, b\.txt/);
  assert.match(attachedNote([], 'Files'), /Nothing attached/);
  assert.equal(fileSize(2048), '2.0KB');
  assert.equal(fileSize(3 * 1024 * 1024), '3.0MB');
});
