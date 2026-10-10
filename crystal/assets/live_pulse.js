// Generated from src/live.js PULSE_SCRIPT; update with tools/update_crystal_assets.js.
() => ({
  observing: !!(window[Symbol.for('tweb.observer')] && window[Symbol.for('tweb.observerRoot')] === document),
  href: location.href,
  print: [
    document.getElementsByTagName('*').length,
    document.title,
    location.href,
  ].join('|'),
})
