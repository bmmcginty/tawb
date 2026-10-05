'use strict';

// The two lists Lynx keeps about the reader rather than about the page: the
// links followed in this session (VLINKS) and the documents it has been
// through (HISTORY). The browser owns the real history; these are the
// session's own record of what has been read. They live here rather than in
// the terminal loop so no part of the ordinary interface has to know Lynx
// keeps them at all.

// How many links and pages a session remembers. A session is not a browser
// profile: what matters is the recent past, and a list nobody can reach the
// bottom of is not more useful for being longer.
const VISITED_LIMIT = 200;

// VLINKS: the links followed in this session, newest first, each one once.
// What identifies it is where it goes, so following the same link twice moves
// it to the top rather than listing it twice.
function noteVisitedLink(state, item) {
  const href = item.href;
  if (!state.visitedLinks) state.visitedLinks = [];
  const list = state.visitedLinks;
  const at = list.findIndex((entry) => entry.href === href);
  if (at >= 0) list.splice(at, 1);
  list.unshift({ name: item.name || href, href });
  if (list.length > VISITED_LIMIT) list.length = VISITED_LIMIT;
}

// HISTORY is the stack of documents Lynx is holding. Reading the same page
// again is not a new place to go back to, so its entry keeps its position and
// takes the fresh title; a blank tab is not a document anybody wants listed.
function notePageVisit(state, url, title) {
  if (!url || /^about:blank$/i.test(url)) return;
  if (!state.pageLog) state.pageLog = [];
  const log = state.pageLog;
  if (log.length && log[0].url === url) log[0].title = title || log[0].title;
  else log.unshift({ url, title: title || url });
  if (log.length > VISITED_LIMIT) log.length = VISITED_LIMIT;
}

module.exports = { VISITED_LIMIT, noteVisitedLink, notePageVisit };
