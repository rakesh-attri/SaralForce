// Small original line-art for empty panes: a soft circle, one motif, a couple
// of sparkles. Static SVG strings (no user data), drawn on a 160×120 canvas
// with the app's blues and one violet accent. Pure.

const SPARKLES = `<path d="M128 24l2.2 5.8 5.8 2.2-5.8 2.2-2.2 5.8-2.2-5.8-5.8-2.2 5.8-2.2z" fill="#a78bfa"/>
<path d="M30 30l1.4 3.6 3.6 1.4-3.6 1.4-1.4 3.6-1.4-3.6-3.6-1.4 3.6-1.4z" fill="#7cb4f5"/>
<circle cx="138" cy="84" r="2.5" fill="#cfe0f7"/><circle cx="22" cy="78" r="2" fill="#cfe0f7"/>`;
const BLOB = `<ellipse cx="80" cy="62" rx="50" ry="46" fill="#eaf2fd"/>`;
const SHADOW = `<ellipse cx="80" cy="108" rx="34" ry="4" fill="#dfe8f5"/>`;

const MOTIFS = {
  // A profile card under a magnifying glass.
  users: `<rect x="44" y="34" width="62" height="58" rx="10" fill="#fff" stroke="#9cc3f2" stroke-width="2"/>
<circle cx="64" cy="54" r="9" fill="#cfe2fb"/><path d="M52 78c2-8 22-8 24 0" stroke="#9cc3f2" stroke-width="3" fill="none" stroke-linecap="round"/>
<path d="M82 52h14M82 60h10M82 70h14" stroke="#cfe0f7" stroke-width="3" stroke-linecap="round"/>
<circle cx="104" cy="78" r="12" fill="#fff" stroke="#0176d3" stroke-width="3"/><path d="M113 87l9 9" stroke="#0176d3" stroke-width="4" stroke-linecap="round"/>`,
  // Two permission cards side by side, one row that differs.
  compare: `<rect x="38" y="32" width="38" height="58" rx="8" fill="#fff" stroke="#9cc3f2" stroke-width="2"/>
<rect x="84" y="32" width="38" height="58" rx="8" fill="#fff" stroke="#9cc3f2" stroke-width="2"/>
<path d="M46 46h22M46 56h22M46 76h22M92 46h22M92 56h22M92 76h22" stroke="#cfe0f7" stroke-width="3" stroke-linecap="round"/>
<rect x="44" y="62" width="72" height="8" rx="4" fill="#ede7fe"/><path d="M46 66h22M92 66h14" stroke="#a78bfa" stroke-width="3" stroke-linecap="round"/>
<circle cx="80" cy="96" r="7" fill="#0176d3"/><path d="M76.5 96h7M80 92.5v7" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`,
  // A shield with a tick and two signal arcs.
  shield: `<path d="M80 28l26 9v19c0 18-11 30-26 36-15-6-26-18-26-36V37z" fill="#fff" stroke="#0176d3" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M80 36l18 6v14c0 13-8 22-18 27-10-5-18-14-18-27V42z" fill="#e6f0fd"/>
<path d="M71 60l7 7 13-14" stroke="#0176d3" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M116 44a24 24 0 010 30M124 38a34 34 0 010 42" stroke="#c4b5fd" stroke-width="2.5" fill="none" stroke-linecap="round"/>`,
  // An inbox tray with a ticked card.
  inbox: `<rect x="56" y="30" width="48" height="40" rx="6" fill="#fff" stroke="#9cc3f2" stroke-width="2"/>
<path d="M70 50l7 7 13-13" stroke="#22a06b" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M40 64h22l6 10h24l6-10h22v22a6 6 0 01-6 6H46a6 6 0 01-6-6z" fill="#e6f0fd" stroke="#0176d3" stroke-width="2.5" stroke-linejoin="round"/>`,
  // A run button over code lines.
  run: `<rect x="40" y="34" width="80" height="56" rx="10" fill="#fff" stroke="#9cc3f2" stroke-width="2"/>
<path d="M50 48h20M50 58h34M50 68h26M50 78h16" stroke="#cfe0f7" stroke-width="3" stroke-linecap="round"/>
<circle cx="104" cy="74" r="14" fill="#0176d3"/><path d="M100 67v14l11-7z" fill="#fff"/>`,
  // A log page with a sparkle (AI reads it).
  log: `<path d="M52 28h40l16 16v48a6 6 0 01-6 6H52a6 6 0 01-6-6V34a6 6 0 016-6z" fill="#fff" stroke="#9cc3f2" stroke-width="2"/>
<path d="M92 28v16h16" fill="#e6f0fd" stroke="#9cc3f2" stroke-width="2" stroke-linejoin="round"/>
<path d="M56 54h28M56 64h40M56 74h22M56 84h32" stroke="#cfe0f7" stroke-width="3" stroke-linecap="round"/>
<path d="M104 70l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="#7c5cff"/>`,
  // A small result table.
  table: `<rect x="38" y="34" width="84" height="56" rx="8" fill="#fff" stroke="#9cc3f2" stroke-width="2"/>
<path d="M38 48h84" stroke="#9cc3f2" stroke-width="2"/><rect x="39" y="35" width="82" height="12" rx="7" fill="#e6f0fd"/>
<path d="M66 48v42M94 48v42" stroke="#e3ebf6" stroke-width="2"/>
<path d="M46 60h12M74 60h12M102 60h12M46 72h12M74 72h12M102 72h12M46 84h12M74 84h8" stroke="#cfe0f7" stroke-width="3" stroke-linecap="round"/>`,
  // A request going out and a reply coming back.
  api: `<rect x="34" y="36" width="44" height="30" rx="7" fill="#fff" stroke="#9cc3f2" stroke-width="2"/>
<path d="M42 47h18M42 55h26" stroke="#cfe0f7" stroke-width="3" stroke-linecap="round"/>
<rect x="82" y="58" width="44" height="34" rx="7" fill="#fff" stroke="#c4b5fd" stroke-width="2"/>
<path d="M90 68h8M90 76h22M90 84h14" stroke="#ddd6fe" stroke-width="3" stroke-linecap="round"/>
<path d="M84 44h22l-6-6M106 44l-6 6" stroke="#0176d3" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M76 84H58l6-6M58 84l6 6" stroke="#a78bfa" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  // Stacked log lines with a clock (a time window).
  logs: `<rect x="38" y="30" width="70" height="16" rx="6" fill="#fff" stroke="#9cc3f2" stroke-width="2"/>
<rect x="38" y="52" width="70" height="16" rx="6" fill="#fff" stroke="#9cc3f2" stroke-width="2"/>
<rect x="38" y="74" width="70" height="16" rx="6" fill="#fff" stroke="#9cc3f2" stroke-width="2"/>
<path d="M46 38h8M60 38h36M46 60h8M60 60h28M46 82h8M60 82h32" stroke="#cfe0f7" stroke-width="3" stroke-linecap="round"/>
<circle cx="114" cy="78" r="15" fill="#0176d3"/><path d="M114 70v9l6 4" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  // Four app tiles, one highlighted.
  apps: `<rect x="50" y="32" width="26" height="26" rx="7" fill="#fff" stroke="#9cc3f2" stroke-width="2"/>
<rect x="84" y="32" width="26" height="26" rx="7" fill="#0176d3"/>
<rect x="50" y="66" width="26" height="26" rx="7" fill="#fff" stroke="#9cc3f2" stroke-width="2"/>
<rect x="84" y="66" width="26" height="26" rx="7" fill="#fff" stroke="#c4b5fd" stroke-width="2"/>
<path d="M91 45h12M97 39v12" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`
};

export const EMPTY_ARTS = Object.keys(MOTIFS);

// → the inner markup of a 160×120 SVG (unknown names fall back to "table").
export function emptyArtSvg(name) {
  return BLOB + SHADOW + (MOTIFS[name] || MOTIFS.table) + SPARKLES;
}
