// SOQL lexer: comments → strings → numbers → identifiers (contextualized by
// keyword / function / table-after-FROM / alias-after-AS / column) →
// operators → punctuation. Output mirrors apexHighlight (escaped HTML).
const SOQL_KEYWORDS = new Set((
  "select from where and or not order by group having limit offset asc desc " +
  "nulls first last like in is null exists between includes excludes with for " +
  "view update typeof end else when then case as union all inner left right " +
  "full outer join on distinct using"
).split(" "));
const SOQL_LOGIC = new Set(["and", "or", "not", "like", "in", "is", "null",
  "exists", "between", "includes", "excludes"]);

function soqlHighlight(src) {
  const text = String(src == null ? "" : src);
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const re = /(\/\/[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:''|[^'])*'|"(?:\\.|[^"\\])*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([=<>!]+|[-+*/%^])|([(),;.])/g;
  let out = "";
  let last = 0;
  let prev = "";
  let m;
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    if (m[1]) out += `<span class="tok-c">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-s">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-n">${esc(m[3])}</span>`;
    else if (m[4]) {
      const w = m[4];
      const lw = w.toLowerCase();
      const isCall = /^\s*\(/.test(text.slice(m.index + w.length));
      if (isCall && !SOQL_KEYWORDS.has(lw)) out += `<span class="tok-fn">${esc(w)}</span>`;
      else if (SOQL_KEYWORDS.has(lw)) out += `<span class="${SOQL_LOGIC.has(lw) ? "tok-k2" : "tok-k"}">${esc(w)}</span>`;
      else if (prev === "from" || prev === "join" || prev === "into" || prev === "update") out += `<span class="tok-t">${esc(w)}</span>`;
      else if (prev === "as") out += `<span class="tok-al">${esc(w)}</span>`;
      else out += `<span class="tok-col">${esc(w)}</span>`;
      prev = lw;
    }
    else if (m[5]) out += `<span class="tok-op">${esc(m[5])}</span>`;
    else if (m[6]) out += `<span class="tok-p">${esc(m[6])}</span>`;
    last = m.index + m[0].length;
  }
  out += esc(text.slice(last));
  return out;
}

// ─── Apex tab (Execute Anonymous, Dev-Console style) ───────
// Runs anonymous Apex through the Tooling API (the same endpoint the
// Developer Console's "Open Execute Anonymous Window" uses) and pulls
// the resulting debug log — no Dev Console needed.
const APEX_KEYWORDS = new Set((
  "abstract and as before boolean break byte case cast catch char class const continue " +
  "currency date datetime decimal default delete desc do double else enum export extends " +
  "false final finally float for from global goto group having if implements import in inner " +
  "insert instanceof int integer interface into like limit list long loop map merge new not " +
  "null object on or outer override package private protected public return returning search " +
  "select set short static super switch synchronized testmethod this throw throws transient " +
  "trigger try undelete update upsert using virtual void webservice when where while with without"
).split(" "));

function apexHighlight(src) {
  const text = String(src == null ? "" : src);
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([=<>!]+|[-+*/%^])|([(),;.[\]{}])/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    if (m[1]) out += `<span class="tok-c">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-s">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-n">${esc(m[3])}</span>`;
    else if (m[4]) {
      const w = m[4];
      if (APEX_KEYWORDS.has(w.toLowerCase())) out += `<span class="tok-k">${esc(w)}</span>`;
      else if (/^\s*\(/.test(text.slice(m.index + w.length))) out += `<span class="tok-fn">${esc(w)}</span>`;
      else if (/^[A-Z]/.test(w)) out += `<span class="tok-t">${esc(w)}</span>`;
      else out += esc(w);
    }
    else if (m[5]) out += `<span class="tok-op">${esc(m[5])}</span>`;
    else if (m[6]) out += `<span class="tok-p">${esc(m[6])}</span>`;
    last = m.index + m[0].length;
  }
  out += esc(text.slice(last));
  return out;
}

export {soqlHighlight, apexHighlight};
