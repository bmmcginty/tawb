// Generated from src/click.js submitsAutofilled; update with tools/update_crystal_assets.js.
function submitsAutofilled(el) {
  const form = el && (el.form || (el.closest && el.closest('form')));
  if (!form || !form.elements) return false;
  for (const field of form.elements) {
    for (const selector of [':autofill', ':-webkit-autofill']) {
      try {
        if (field.matches(selector)) return true;
      } catch { /* an engine that does not know this pseudo-class */ }
    }
  }
  return false;
}
