'use strict';

const CONSTRUCTS = [
  ['a plain paragraph', 'read', '<p>M01</p>'],
  ['a display:contents wrapper', 'read', '<div style="display:contents"><p>M02</p></div>'],
  ['nested display:contents wrappers', 'read',
    '<div style="display:contents"><div style="display:contents"><p>M03</p></div></div>'],
  ['a list that generates no box', 'read', '<ul style="display:contents"><li>M04</li></ul>'],
  ['bare text in a display:contents wrapper', 'read', '<div style="display:contents">M05</div>'],
  ['visibility:hidden', 'skip', '<div style="visibility:hidden"><p>M06</p></div>'],
  // visibility is inherited but a descendant may set it back, and the browser
  // then renders that descendant alone. A walk that stops at the ancestor
  // never finds it.
  ['a visible child of a visibility:hidden parent', 'read',
    '<div style="visibility:hidden"><p style="visibility:visible">M07</p></div>'],
  ['content-visibility:hidden', 'skip', '<div style="content-visibility:hidden"><p>M08</p></div>'],
  // Content the browser has merely not got to yet is the off-screen text this
  // program exists to reach, so it is read rather than skipped.
  ['content-visibility:auto', 'read',
    '<div style="content-visibility:auto;contain-intrinsic-size:200px"><p>M09</p></div>'],
  ['the hidden attribute', 'skip', '<div hidden><p>M10</p></div>'],
  // Inert content is on screen, and no live overlay explains the lock here:
  // sites apply inert while a sign-in card is open and often leave it behind
  // after the card has gone. Reading it is the difference between the page
  // and an empty buffer. A live overlay is covered separately below.
  ['an inert subtree', 'read', '<div inert><p>M12</p><button>M13</button></div>'],
  ['aria-hidden', 'skip', '<div aria-hidden="true"><p>M14</p></div>'],
  // The accessibility tree carries text painted at zero opacity; the view of
  // what is on screen does not. The two disagree on purpose.
  ['opacity:0', { ax: 'read', render: 'skip' }, '<div style="opacity:0"><p>M15</p></div>'],
  ['the visually-hidden pattern', 'read',
    '<p style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">M16</p>'],
  ['content positioned off screen', 'read', '<p style="position:absolute;left:-9999px">M17</p>'],
  ['content in a zero-sized clipping box', 'read',
    '<div style="width:0;height:0;overflow:hidden"><p>M18</p></div>'],
  ['the summary of a closed disclosure', 'read', '<details><summary>M19</summary><p>M20x</p></details>'],
  ['the body of a closed disclosure', 'skip', '<details><summary>M21x</summary><p>M20</p></details>'],
  ['the body of an open disclosure', 'read', '<details open><summary>M21</summary><p>M22</p></details>'],
  ['a visibility:collapse table row', 'skip',
    '<table><tr style="visibility:collapse"><td>M23</td></tr><tr><td>M24x</td></tr></table>'],
  ['a template', 'skip', '<template><p>M25</p></template>'],
  ['a dialog that is not open', 'skip', '<dialog><p>M27</p></dialog>'],
  ['a closed popover', 'skip', '<div popover><p>M30</p></div>'],
  ['content in an open shadow root', 'read', '<div id="sr1"></div>'],
  ['the fallback content of an empty slot', 'read', '<div id="sr2"></div>'],
];

const CONSTRUCT_PAGE = `<!doctype html><meta charset="utf-8"><title>constructs</title>
${CONSTRUCTS.map(([, , html]) => html).join('\n')}
<script>
  document.getElementById('sr1').attachShadow({ mode: 'open' }).innerHTML = '<p>M31</p>';
  document.getElementById('sr2').attachShadow({ mode: 'open' }).innerHTML = '<slot><p>M32</p></slot>';
</script>`;

const MARKERS = {
  'a plain paragraph': ['M01'],
  'a display:contents wrapper': ['M02'],
  'nested display:contents wrappers': ['M03'],
  'a list that generates no box': ['M04'],
  'bare text in a display:contents wrapper': ['M05'],
  'visibility:hidden': ['M06'],
  'a visible child of a visibility:hidden parent': ['M07'],
  'content-visibility:hidden': ['M08'],
  'content-visibility:auto': ['M09'],
  'the hidden attribute': ['M10'],
  'an inert subtree': ['M12', 'M13'],
  'aria-hidden': ['M14'],
  'opacity:0': ['M15'],
  'the visually-hidden pattern': ['M16'],
  'content positioned off screen': ['M17'],
  'content in a zero-sized clipping box': ['M18'],
  'the summary of a closed disclosure': ['M19'],
  'the body of a closed disclosure': ['M20'],
  'the body of an open disclosure': ['M22'],
  'a visibility:collapse table row': ['M23'],
  'a template': ['M25'],
  'a dialog that is not open': ['M27'],
  'a closed popover': ['M30'],
  'content in an open shadow root': ['M31'],
  'the fallback content of an empty slot': ['M32'],
};

const INERT_OVERLAY_PAGE = `<!doctype html><meta charset="utf-8"><title>inert overlay</title>
<div inert><p>M33 behind the frame</p><button>M34 behind the frame</button></div>
<iframe title="Sign in" style="position:fixed; left:20px; top:20px; width:300px; height:150px"
        srcdoc="<p>M35 inside the frame</p><button>M36 close</button>"></iframe>`;

const HIDDEN_OVERLAY_PAGE = `<!doctype html><meta charset="utf-8"><title>hidden overlay</title>
<div aria-hidden="true"><iframe title="Hidden prompt"
  style="position:fixed; left:20px; top:20px; width:300px; height:150px"
  srcdoc="<p>M37 hidden prompt</p>"></iframe></div>
<div inert><p>M38 behind the hidden prompt</p></div>`;

const PSEUDO_PAGE = `<!doctype html><meta charset="utf-8"><title>pseudo</title>
<style>
  #b::before { content: "Save"; }
  #l::after { content: " (opens in a new window)"; }
  #c::before { content: counter(nope); }
</style>
<button id="b"></button>
<a id="l" href="/x">Docs</a>
<button id="c">Plain</button>
<style>#w span::before { content: attr(data-content); display: block; height: 0; visibility: hidden; }</style>
<a id="w" href="/w"><span data-content="Insights">Insights</span></a>`;

const LABELLEDBY_PAGE = `<!doctype html><meta charset="utf-8"><title>labelledby</title>
<button aria-labelledby="whole">unused</button>
<span id="whole" style="display:none">alpha <span>beta</span></span>
<button aria-labelledby="part">unused</button>
<span id="part">gamma <span style="display:none">delta</span></span>`;

const NESTED_CONTROLS_PAGE = `<!doctype html><meta charset="utf-8"><title>nested controls</title>
<div role="button" aria-label="Player" tabindex="0">
  <div role="slider" aria-label="Volume" aria-valuemin="0" aria-valuemax="100"
       aria-valuenow="35" aria-orientation="vertical" tabindex="0">
    <div role="button" aria-label="Mute" tabindex="0"></div>
  </div>
</div>`;

const POINTER_SLIDER_PAGE = `<!doctype html><meta charset="utf-8"><title>pointer slider</title>
<div role="slider" aria-label="Pointer volume" aria-valuemin="0" aria-valuemax="100"
     aria-valuenow="0" tabindex="0" style="width:20px;height:100px;background:#ccc"></div>
<script>
  const slider = document.querySelector('[role=slider]');
  slider.addEventListener('click', event => {
    const box = slider.getBoundingClientRect();
    const value = Math.round(100 * (1 - (event.clientY - box.top) / box.height));
    slider.setAttribute('aria-valuenow', Math.max(0, Math.min(100, value)));
  });
</script>`;

const TWO_LABELS_PAGE = `<!doctype html><meta charset="utf-8"><title>labels</title>
<label for="dob">Date of birth</label>
<label for="dob">(day, month, year)</label>
<input id="dob">`;

const MEDIA_PAGE = `<!doctype html><meta charset="utf-8"><title>media</title>
<audio id="a" controls></audio>
<script>
  window.__ready = false;
  const rate = 8000, seconds = 3, samples = rate * seconds;
  const buf = new ArrayBuffer(44 + samples);
  const view = new DataView(buf);
  const str = (at, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + samples, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  str(36, 'data'); view.setUint32(40, samples, true);
  for (let i = 0; i < samples; i += 1) view.setUint8(44 + i, 128);
  let binary = '';
  for (const byte of new Uint8Array(buf)) binary += String.fromCharCode(byte);
  const el = document.getElementById('a');
  el.addEventListener('loadedmetadata', () => { el.currentTime = 1; window.__ready = true; }, { once: true });
  el.src = 'data:audio/wav;base64,' + btoa(binary);
</script>`;

const MODAL_PAGE = `<!doctype html><meta charset="utf-8"><title>modal</title>
<p>D01 ordinary prose</p>
<button>D02 a button on the page</button>
<dialog id="d"><p>D03 inside the dialog</p><button>D04 in the dialog</button></dialog>
<script>document.getElementById('d').showModal();</script>`;

const DECORATION_PAGE = `<!doctype html><meta charset="utf-8"><title>decoration</title>
<style>
  .parent a { background: url(/images/s5_menu_arrow.png) no-repeat right center; padding-right: 18px; }
  #tile { background-image: url(/images/hero_banner.jpg); width: 300px; height: 120px; }
  #grad { background-image: linear-gradient(#fff, #000); width: 40px; height: 40px; }
  #both { background-image: linear-gradient(#fff, #000), url(/images/star_filled.png); width: 40px; height: 40px; }
  #gen::after { content: url(/images/external_link.png); }
  #iconbtn .icon { background-image: url(/images/floppy_disk.png); width: 16px; height: 16px; display: inline-block; }
</style>
<ul>
  <li class="parent"><a href="javascript:;">About Us</a></li>
  <li class="parent"><a href="javascript:;">Concerts</a></li>
  <li><a href="/links">Links</a></li>
</ul>
<div id="tile"></div>
<div id="grad"></div>
<div id="both"></div>
<a id="gen" href="/spec">Specification</a>
<button id="iconbtn"><span class="icon"></span>Save</button>
<img src="/images/welsh_harpist.jpg" width="40" height="40">
<img src="/images/spacer.gif" alt="" width="40" height="40">
<img src="/images/crowd.jpg" alt="A festival crowd" width="40" height="40">
<svg aria-hidden="true" width="16" height="16"><path d="M0 0"></path></svg>`;

const IMAGE_CONTROL_PAGE = `<!doctype html><meta charset="utf-8"><title>image controls</title>
<style>#chip { background-image: url(/images/paper_plane.png); width: 16px; height: 16px; display: block; }</style>
<a id="home" href="/"><img src="/images/ccc_logo.png" alt="ccc logo" width="40" height="40"></a>
<a id="prev" href="/prev"><img src="/images/prev.png" alt="Previous" width="16" height="16"></a>
<a id="plain" href="/photo"><img src="/images/welsh_harpist.jpg" width="40" height="40"></a>
<button id="send"><span id="chip"></span></button>`;

const WRAPPER_PAGE = `<!doctype html><meta charset="utf-8"><title>wrapper</title>
<div style="display:contents"><p>Read through a wrapper that generates no box.</p></div>
<details><summary>Shipping notes</summary><div style="display:contents">
  Hidden behind a closed disclosure
</div></details>`;

// Every extraction fixture exercised by views.test.js. A runtime differential
// consumes this same catalog, so adding a view scenario cannot silently leave
// the native implementation on the old representative page.
const VIEW_SCENARIOS = [
  { id: 'wrapper', html: WRAPPER_PAGE, views: ['ax', 'render'] },
  { id: 'constructs', html: CONSTRUCT_PAGE, views: ['ax', 'render'] },
  { id: 'inert-overlay', html: INERT_OVERLAY_PAGE, views: ['ax', 'render'] },
  { id: 'hidden-overlay', html: HIDDEN_OVERLAY_PAGE, views: ['ax', 'render'] },
  { id: 'pseudo-content', html: PSEUDO_PAGE, views: ['ax'] },
  { id: 'svg-link-name', html: '<a href="/"><svg role="img" aria-label="Home"><path d="M0 0"></path></svg></a>', views: ['ax'] },
  { id: 'labelledby', html: LABELLEDBY_PAGE, views: ['ax'] },
  { id: 'nested-controls', html: NESTED_CONTROLS_PAGE, views: ['ax', 'render', 'inspect'] },
  { id: 'pointer-slider', html: POINTER_SLIDER_PAGE, views: ['ax'] },
  { id: 'two-labels', html: TWO_LABELS_PAGE, views: ['ax'] },
  { id: 'embedded-media', html: MEDIA_PAGE, views: ['ax', 'render', 'inspect', 'source'] },
  { id: 'modal', html: MODAL_PAGE, views: ['ax', 'render'] },
  { id: 'decoration', html: DECORATION_PAGE, views: ['ax', 'render'] },
  { id: 'image-controls', html: IMAGE_CONTROL_PAGE, views: ['ax', 'render'] },
];

module.exports = {
  CONSTRUCTS, CONSTRUCT_PAGE, MARKERS, INERT_OVERLAY_PAGE, HIDDEN_OVERLAY_PAGE,
  PSEUDO_PAGE, LABELLEDBY_PAGE, NESTED_CONTROLS_PAGE, POINTER_SLIDER_PAGE,
  TWO_LABELS_PAGE, MEDIA_PAGE, MODAL_PAGE, DECORATION_PAGE, IMAGE_CONTROL_PAGE,
  VIEW_SCENARIOS,
};
