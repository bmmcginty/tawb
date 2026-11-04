'use strict';

// The order screens are raised in.
//
// The page is the base and is never popped. A screen above it owns the
// keyboard until it leaves; what it draws and how it restores the page are
// its own business. Keeping only the order here is what lets a library, a
// chooser and, later, the wizard share one rule about who receives a key
// without sharing their drawing or their underlay strategy.
//
// This is deliberately not a history. A screen pop is the screen's own leave
// path; the stack only refuses to pop the page and refuses to pop a screen
// that is not on top.

class ScreenStack {
  constructor({ base = 'page' } = {}) {
    this.base = base;
    this.screens = [{ mode: base, kind: base }];
  }

  depth() {
    return this.screens.length - 1;
  }

  top() {
    return this.screens[this.screens.length - 1];
  }

  below() {
    return this.screens.length > 1 ? this.screens[this.screens.length - 2] : null;
  }

  has(mode) {
    return this.screens.some((screen) => screen.mode === mode);
  }

  push(screen) {
    if (!screen || !screen.mode) throw new Error('a screen needs a mode');
    if (screen.mode === this.base) throw new Error(`the ${this.base} screen is the base`);
    const entry = { ...screen, kind: screen.kind || screen.mode };
    this.screens.push(entry);
    return entry;
  }

  pop(mode = null) {
    if (this.screens.length <= 1) return null;
    const top = this.top();
    if (mode && top.mode !== mode) return null;
    return this.screens.pop();
  }
}

module.exports = { ScreenStack };
