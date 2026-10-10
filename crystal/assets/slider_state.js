// Generated from src/core.js sliderStateOf; update with tools/update_crystal_assets.js.
function sliderStateOf(el) {
  return {
    value: el.getAttribute('aria-valuenow') ?? (typeof el.value === 'string' ? el.value : null),
    min: el.getAttribute('aria-valuemin') ?? (el.min || 0),
    max: el.getAttribute('aria-valuemax') ?? (el.max || 100),
    step: el.getAttribute('aria-valuestep') ?? (el.step || null),
    orientation: el.getAttribute('aria-orientation') || null,
  };
}
