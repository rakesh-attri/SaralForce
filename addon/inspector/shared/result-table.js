import {ffIsSfId, ffRecordUrl} from "./record-links.js";
import {fmtSfCell} from "./format.js";

const h = React.createElement;

function ResultTable({columns, rows, maxRows, onRowClick, rowHint, cellFmt,
  wrapClass, selectable, isSelected, onToggle, allChecked, onToggleAll,
  sortCol, sortDir, onSort, fieldTypes}) {
  const shown = rows.slice(0, maxRows || 200);
  if (!columns.length) return h("div", {className: "insp-empty"}, "No rows");
  // ↗ gets its own column, right after Name (or at the row end when the
  // query has no Name). Id-less grids render exactly as before.
  const idField = columns.includes("Id") ? "Id" : null;
  const showOpen = !!idField && shown.some(r => r && ffIsSfId(r[idField]));
  const openIdx = columns.includes("Name")
    ? columns.indexOf("Name") + 1
    : columns.length;
  const cells = showOpen
    ? columns.slice(0, openIdx).concat("__open", columns.slice(openIdx))
    : columns.slice();
  return h("div", {className: "insp-table-wrap" + (wrapClass ? " " + wrapClass : "")},
      h("table", {className: "insp-table"},
        h("thead", null,
          h("tr", null,
            selectable && h("th", {key: "__sel", className: "sq3-sel-col"},
              onToggleAll ? h("input", {
                type: "checkbox",
                checked: !!allChecked,
                onChange: onToggleAll,
                "aria-label": "Select all rows"
              }) : null),
            cells.map(c => {
              if (c === "__open") return h("th", {key: c, className: "insp-open-col"});
              const sorted = onSort && sortCol != null && sortCol === c;
              return h("th", {
                key: c,
                ...(onSort ? {
                  className: "sq3-sortable" + (sorted ? " sq3-sorted" : ""),
                  onClick: () => onSort(c),
                  title: "Sort by " + c
                } : {})
              },
                h("span", null, c),
                sorted && h("span", {className: "sq3-sort-arrow", "aria-hidden": "true"},
                  sortDir === -1 ? " ▼" : " ▲"));
            })
          )
        ),
        h("tbody", null,
          shown.map((row, i) =>
            h("tr", {
              key: i,
              className: onRowClick ? "insp-row-click" : "",
              title: onRowClick ? (rowHint || "Click to show all data") : undefined,
              onClick: onRowClick ? () => onRowClick(row, i) : undefined
            },
              selectable && h("td", {key: "__sel", className: "sq3-sel-col"},
                h("input", {
                  type: "checkbox",
                  checked: !!(isSelected && isSelected(row, i)),
                  onChange: (e) => {
                    e.stopPropagation();
                    if (onToggle) onToggle(row, i);
                  },
                  onClick: (e) => e.stopPropagation(),
                  "aria-label": "Select row"
                })),
              cells.map(c => {
              if (c === "__open") {
                return h("td", {key: c, className: "insp-open-col"},
                  ffIsSfId(row[idField]) && h("a", {
                    href: ffRecordUrl(row[idField]),
                    target: "_blank",
                    rel: "noreferrer",
                    className: "insp-open-link",
                    title: "Open in Salesforce",
                    onClick: (e) => e.stopPropagation()
                  }, "↗"));
              }
              const raw = row[c] == null ? "" : String(row[c]);
              const isId = String(c).toLowerCase() === "id";
              const isIdVal = isId && row[c] != null && String(row[c]).trim() !== "";
              const title = row[c] == null ? ""
                : (isId && onRowClick
                  ? `${raw} — ${rowHint || "click: open all record data in a popup"}`
                  : raw);
              const fmtVal = row[c] == null ? ""
                : (cellFmt && cellFmt[c] ? cellFmt[c](row[c], row)
                  : fmtSfCell(row[c], fieldTypes && fieldTypes[c]));
              return h("td", {
                key: c,
                title,
                ...(isIdVal ? {className: "sq3-id-cell"} : {})
              },
                fmtVal
              );
            })
          )
        )
      )
    ),
    rows.length > shown.length &&
      h("div", {className: "insp-more"}, `Showing ${shown.length} of ${rows.length} rows`)
  );
}

export {ResultTable};
