'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');

// Where a browser we started recorded its debugging port, so a later session
// can find it again.
//
// Both engines need this and for the same reason: a browser allows one
// instance per profile directory, so a second launch does not give you a
// second browser. Chrome hands its arguments to the running instance and
// exits, leaving nothing listening on the new port; Firefox refuses outright.
// Either way the answer is to join what is already running rather than to
// compete with it — and joining is also what makes a second session start in
// a twentieth of a second instead of four.
//
// The record is only a hint. It is believed exactly as far as a live port on
// the other end, because a browser that was killed leaves its record behind.

const ENDPOINT_FILE = 'tui-browser-endpoint.json';

function endpointRecordPath(profileDir) {
  return path.join(profileDir, ENDPOINT_FILE);
}

function readEndpointRecord(profileDir) {
  try {
    return JSON.parse(fs.readFileSync(endpointRecordPath(profileDir), 'utf8'));
  } catch {
    return null;
  }
}

function writeEndpointRecord(profileDir, record) {
  try {
    fs.writeFileSync(endpointRecordPath(profileDir), JSON.stringify(record));
  } catch { /* the browser still works without it */ }
}

function endpointReady(port) {
  return new Promise((resolve) => {
    const request = net.connect(port, '127.0.0.1');
    request.setTimeout(1000);
    request.on('connect', () => { request.destroy(); resolve(true); });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

async function waitForEndpoint(port, deadline) {
  while (Date.now() < deadline) {
    if (await endpointReady(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// The port a browser is already serving on this profile, or null.
async function runningEndpoint(profileDir) {
  const record = readEndpointRecord(profileDir);
  if (!record || !record.port) return null;
  if (!(await endpointReady(record.port))) return null;
  return record.port;
}

module.exports = {
  ENDPOINT_FILE, endpointRecordPath, readEndpointRecord, writeEndpointRecord,
  endpointReady, waitForEndpoint, runningEndpoint,
};
