// Namespace-agnostic DOM helpers for Metadata SOAP responses. Server
// responses mix prefixes (met:/sf:/unprefixed), so match on localName.
// Pure functions over a DOM tree — no globals are touched at import time.
import {escXml} from "./metadata-xml.js";

export function domLocal(el) {
  if (!el) return "";
  return el.localName || String(el.tagName || "").split(":").pop();
}

export function domChildren(el) {
  if (!el || !el.childNodes) return [];
  return Array.from(el.childNodes).filter(n => n.nodeType === 1);
}

export function domFind(root, local) {
  if (!root) return null;
  if (domLocal(root) === local) return root;
  const stack = domChildren(root);
  while (stack.length > 0) {
    const el = stack.shift();
    if (domLocal(el) === local) return el;
    stack.unshift(...domChildren(el));
  }
  return null;
}

export function domFindAll(root, local, out = []) {
  if (!root) return out;
  if (domLocal(root) === local) out.push(root);
  for (const c of domChildren(root)) domFindAll(c, local, out);
  return out;
}

export function domMakeEl(doc, tag, text) {
  const el = doc.createElement(tag);
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

// Serialize a response DOM element to met:-prefixed Metadata XML. Operates
// on the raw readMetadata records so a full round-trip preserves every
// field byte-for-byte (no wipe risk on Profile/Layout updates).
export function domToMetXml(el) {
  const tag = domLocal(el);
  let attrs = "";
  if (el.attributes) {
    for (const a of Array.from(el.attributes)) {
      if (a.name === "xmlns" || a.name.startsWith("xmlns:")) continue;
      attrs += ` ${a.name}="${escXml(a.value)}"`;
    }
  }
  const kids = domChildren(el);
  let text = "";
  for (const n of Array.from(el.childNodes || [])) {
    if (n.nodeType === 3 || n.nodeType === 4) text += n.data;
  }
  if (kids.length > 0) {
    if (text.trim() === "") text = "";
    else text = escXml(text);
    return `<met:${tag}${attrs}>${text}${kids.map(domToMetXml).join("")}</met:${tag}>`;
  }
  if (text === "") return `<met:${tag}${attrs}/>`;
  return `<met:${tag}${attrs}>${escXml(text)}</met:${tag}>`;
}
