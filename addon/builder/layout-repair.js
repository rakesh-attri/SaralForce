// Page-layout DOM helpers for the read-merge-write layout update: repair
// known-bad shapes from prior runs, pick a target column, build items.
// Operate on a readMetadata <records> DOM; no network, no globals.
import {domLocal, domChildren, domFind, domFindAll, domMakeEl} from "./metadata-dom.js";

const XSI = "http://www.w3.org/2001/XMLSchema-instance";

// Layout metadata requires every layoutItems to carry a customLink child
// (valued or xsi:nil). Some readMetadata responses omit it on untouched
// rows; updateMetadata validates the whole layout, so one bare row fails
// the entire write with "Required field is missing: customLink".
export function ensureLayoutCustomLinks(root) {
  for (const li of domFindAll(root, "layoutItems")) {
    let has = false;
    const fieldEl = domFind(li, "field");
    const hasField = !!(fieldEl && fieldEl.textContent);
    for (const c of domChildren(li)) {
      if (domLocal(c) === "customLink") {
        has = true;
        // Field rows: customLink must be nil. Link rows (no field): keep value.
        if (hasField) {
          c.textContent = "";
          c.setAttributeNS(XSI, "xsi:nil", "true");
        }
      }
    }
    if (!has) {
      const cl = li.ownerDocument.createElement("customLink");
      cl.setAttributeNS(XSI, "xsi:nil", "true");
      const fieldNode = domFind(li, "field");
      const beh = domFind(li, "behavior");
      if (fieldNode) li.insertBefore(cl, fieldNode);
      else if (beh) li.insertBefore(cl, beh.nextSibling);
      else li.appendChild(cl);
    }
  }
}

// Drop empty layoutColumns (updateMetadata rejects / mis-validates them).
export function removeEmptyLayoutColumns(root) {
  for (const sec of domFindAll(root, "layoutSections")) {
    for (const col of domChildren(sec)) {
      if (domLocal(col) !== "layoutColumns") continue;
      if (domChildren(col).length === 0) sec.removeChild(col);
    }
  }
}

// A CustomLinks section must only hold link items. Prior runs appended
// field rows into the trailing CustomLinks column — that combination fails
// updateMetadata with "Required field is missing: customLink". Rewrite the
// style so field rows validate as a normal detail section.
export function fixCustomLinksWithFields(root) {
  for (const sec of domFindAll(root, "layoutSections")) {
    const styleEl = domFind(sec, "style");
    if (!styleEl || styleEl.textContent !== "CustomLinks") continue;
    const fieldItems = domFindAll(sec, "layoutItems").filter(li => {
      const f = domFind(li, "field");
      return f && f.textContent;
    });
    if (fieldItems.length > 0) {
      styleEl.textContent = "TwoColumnsTopToBottom";
      // Ensure section has a label (some CustomLinks sections omit it).
      if (!domFind(sec, "label")) {
        const label = sec.ownerDocument.createElement("label");
        label.textContent = "Fields";
        const heading = domFind(sec, "editHeading") || domFind(sec, "detailHeading");
        if (heading && heading.nextSibling) sec.insertBefore(label, heading.nextSibling);
        else sec.insertBefore(label, sec.firstChild);
      }
    }
  }
}

// Does this layout need structural repair before we decide whether a no-op
// update is safe? Must run BEFORE the fixers above are applied.
export function layoutNeedsRepair(records) {
  let needsRepair = false;
  for (const sec of domFindAll(records, "layoutSections")) {
    const st = domFind(sec, "style");
    if (st && st.textContent === "CustomLinks" &&
        domFindAll(sec, "layoutItems").some(li => {
          const f = domFind(li, "field");
          return f && f.textContent;
        })) {
      needsRepair = true;
    }
  }
  if (domFindAll(records, "layoutColumns").some(c => domChildren(c).length === 0)) {
    needsRepair = true;
  }
  for (const li of domFindAll(records, "layoutItems")) {
    const f = domFind(li, "field");
    if (f && f.textContent && !domFind(li, "customLink")) {
      needsRepair = true;
      break;
    }
  }
  return needsRepair;
}

// Pick a column in a section that actually holds field items — never a
// pure CustomLinks section (field rows there fail customLink validation).
export function pickLayoutFieldColumn(records) {
  const sections = domFindAll(records, "layoutSections");
  let fallback = null;
  for (const sec of sections) {
    const styleEl = domFind(sec, "style");
    const style = styleEl ? styleEl.textContent : "";
    const cols = domChildren(sec).filter(n => domLocal(n) === "layoutColumns");
    if (!cols.length) continue;
    const hasFieldItem = cols.some(col =>
      domFindAll(col, "layoutItems").some(li => {
        const f = domFind(li, "field");
        return f && f.textContent;
      }));
    if (style === "CustomLinks" && !hasFieldItem) continue;
    if (hasFieldItem) {
      for (let i = cols.length - 1; i >= 0; i--) {
        if (domChildren(cols[i]).length > 0) return cols[i];
      }
      return cols[cols.length - 1];
    }
    if (!fallback) fallback = cols[cols.length - 1];
  }
  if (fallback) return fallback;
  const all = domFindAll(records, "layoutColumns").filter(c => domChildren(c).length > 0);
  return all.length ? all[all.length - 1] : null;
}

// Template = first existing field item. Cloning its exact shape preserves
// schema order and required elements: reads carry
// <customLink xsi:nil="true"/> (required-but-nullable), so a hand-built
// (behavior, field) item is rejected with "Required field is missing:
// customLink". A valued customLink is reset to nil so we never duplicate
// another row's link.
export function findLayoutItemTemplate(records) {
  for (const li of domFindAll(records, "layoutItems")) {
    const f = domFind(li, "field");
    if (f && f.textContent) return li;
  }
  return null;
}

export function buildLayoutItem(doc, template, fieldName) {
  // Never emit "Object.Field" in layoutItems — Metadata API wants the bare
  // API name here (qualified names fail with "no CustomField named …").
  const short = String(fieldName || "").split(".").pop();
  fieldName = short;
  // Metadata API rejects layoutItems without a valued-or-nil customLink
  // ("Required field is missing: customLink"). The Name field must also be
  // behavior=Required when authoring a fresh layout ("Field Name must be
  // Required"). Clone templates still force both so round-trips are safe.
  const behavior = fieldName === "Name" ? "Required" : "Edit";
  let item;
  if (template) {
    item = template.cloneNode(true);
    let hasCustomLink = false;
    for (const c of domChildren(item)) {
      const ln = domLocal(c);
      if (ln === "field") c.textContent = fieldName;
      else if (ln === "behavior") c.textContent = behavior;
      else if (ln === "customLink") {
        hasCustomLink = true;
        c.textContent = "";
        c.setAttributeNS(XSI, "xsi:nil", "true");
      }
    }
    if (!hasCustomLink) {
      const cl = doc.createElement("customLink");
      cl.setAttributeNS(XSI, "xsi:nil", "true");
      const beh = domFind(item, "behavior");
      if (beh && beh.nextSibling) item.insertBefore(cl, beh.nextSibling);
      else item.appendChild(cl);
    }
  } else {
    item = domMakeEl(doc, "layoutItems");
    item.appendChild(domMakeEl(doc, "behavior", behavior));
    const cl = doc.createElement("customLink");
    cl.setAttributeNS(XSI, "xsi:nil", "true");
    item.appendChild(cl);
    item.appendChild(domMakeEl(doc, "field", fieldName));
  }
  return item;
}
