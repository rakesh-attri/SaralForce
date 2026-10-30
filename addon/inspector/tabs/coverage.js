import {sfConn, apiVersion} from "../../inspector.js";
import {safeCopyText} from "../../utils.js";
import {escapeSoqlString, escapeSoqlLike} from "../../core/soql.js";
import {useUnmountSignal} from "../shared/hooks.js";
import {fmtNum} from "../shared/format.js";
import {useTestRun, TestRunPanel, CoverageLines} from "./coverage-run.js";

const h = React.createElement;

function CoverageTab() {
  const [seq, setSeq] = React.useState(0);
  const [runMsg, setRunMsg] = React.useState(null);
  const [resolving, setRunning] = React.useState(false);
  const [linesOf, setLinesOf] = React.useState(null);
  const [filterNote, setFilterNote] = React.useState(null);
  const [quickName, setQuickName] = React.useState("");
  const [suggest, setSuggest] = React.useState([]);
  const [suggestOpen, setSuggestOpen] = React.useState(false);
  const suggestTimer = React.useRef(null);
  const unmountRef = useUnmountSignal();
  // Test runs follow their job id; coverage reloads when a run finishes.
  const testRun = useTestRun(unmountRef.current.signal, (final) => {
    const r = final.results;
    setRunMsg(final.status === "done"
      ? `Run complete: ${r.passed} passed, ${r.failed} failed${r.skipped ? `, ${r.skipped} skipped` : ""} — coverage refreshed.`
      : "Still running — results so far are shown below.");
    setSeq(x => x + 1);
  });
  const running = resolving || testRun.running;

  React.useEffect(() => () => {
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
  }, []);

  React.useEffect(() => {
    if (!suggestOpen) return;
    const onDoc = (e) => {
      if (e.target.closest && e.target.closest(".ff-multi")) return;
      setSuggestOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [suggestOpen]);

  const searchClasses = (term) => {
    const t = term.trim();
    if (t.length < 2) { setSuggest([]); setSuggestOpen(false); return; }
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    suggestTimer.current = setTimeout(async () => {
      try {
        const r = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
          encodeURIComponent(`SELECT Id, Name FROM ApexClass WHERE Name LIKE '%${escapeSoqlLike(t)}%' ORDER BY Name LIMIT 20`),
          {useCache: false});
        setSuggest(r.records || []);
        setSuggestOpen(true);
      } catch (e) {
        setSuggest([]);
        setSuggestOpen(false);
      }
    }, 300);
  };

  const runTests = async (body, label) => {
    setRunMsg(null);
    await testRun.start(body, label);
  };

  const pctOf = (r) => {
    const c = r.NumLinesCovered || 0, u = r.NumLinesUncovered || 0;
    return c + u > 0 ? Math.round(c / (c + u) * 100) : null;
  };
  const nm = (r) => (r.ApexClassOrTrigger && r.ApexClassOrTrigger.Name) || r.ApexClassOrTriggerId || "(unknown)";

  const quickRun = async () => {
    const name = quickName.trim();
    if (!name || running) return;
    setRunning(true);
    setRunMsg(`Resolving ${name}…`);
    try {
      const q = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
        encodeURIComponent(`SELECT Id FROM ApexClass WHERE Name = '${escapeSoqlString(name)}'`),
        {useCache: false});
      const id = q.records && q.records[0] && q.records[0].Id;
      if (!id) {
        setRunMsg(`No Apex class named ${name}.`);
        return;
      }
      setRunning(false);
      await runTests({tests: [{classId: id}]}, name);
    } finally {
      if (!unmountRef.current.signal.aborted) setRunning(false);
    }
  };

  // ─── Dashboard shell — presentation only. Every query, threshold and
  //     handler above is exactly what the coverage tab always used.
  const runAll = () => runTests({testLevel: "RunLocalTests"}, "all tests");

  return h("div", {className: "covdash"},
    linesOf && h(CoverageLines, {target: linesOf, onClose: () => setLinesOf(null)}),
    h("aside", {className: "covdash-side"},
      h("div", {className: "covdash-side-head"},
        h("span", {className: "covdash-side-ico", "aria-hidden": "true"}, "</>"),
        h("div", {className: "covdash-side-id"},
          h("h2", {className: "covdash-side-t"}, "Code Coverage"),
          h("p", {className: "covdash-side-sub"},
            "View and analyse Apex code coverage for your org.")
        )
      ),
      h("div", {className: "covdash-split"},
        h("button", {
          className: "covdash-run",
          disabled: running,
          title: "Run all org tests, then reload the table",
          onClick: runAll
        },
          h("span", {className: "covdash-run-ico", "aria-hidden": "true"}, "▶"),
          running ? "Running…" : "Run All Tests"),
        h("button", {
          className: "covdash-run-chev",
          disabled: running,
          tabIndex: -1,
          "aria-label": "Run all org tests",
          title: "Run all org tests, then reload the table",
          onClick: runAll
        }, "▾")
      ),
      running && h("div", {className: "cov-progress"},
        h("div", {className: "cov-progress-fill"})
      ),
      (runMsg || filterNote) && h("div", {className: "covdash-status"},
        runMsg && h("p", null, runMsg),
        filterNote && h("p", {className: "covdash-status-note"}, filterNote)
      ),
      h("hr", {className: "covdash-rule"}),
      h("h3", {className: "covdash-side-h"}, "Run specific test class"),
      h("div", {className: "ff-multi covdash-search"},
        h("input", {
          className: "covdash-input",
          value: quickName,
          placeholder: "Search test class…",
          "aria-label": "Search test class",
          disabled: running,
          onChange: e => { setQuickName(e.target.value); searchClasses(e.target.value); },
          onKeyDown: e => {
            if (e.key === "Enter") quickRun();
            if (e.key === "Escape") setSuggestOpen(false);
          }
        }),
        suggestOpen && h("div", {className: "ff-multi-panel covdash-panel"},
          h("div", {className: "ff-multi-list"},
            suggest.map(c => h("button", {
              key: c.Id,
              type: "button",
              className: "ff-suggest-row",
              title: `Run ${c.Name}`,
              onClick: () => { setQuickName(c.Name); setSuggestOpen(false); }
            }, c.Name)),
            suggest.length === 0 && h("div", {className: "insp-empty"}, "No matching classes")
          )
        )
      ),
      h("button", {
        className: "covdash-runclass",
        disabled: running || !quickName.trim(),
        title: "Find the class and run its tests",
        onClick: quickRun
      },
        h("span", {className: "covdash-run-ico", "aria-hidden": "true"}, "▶"),
        "Run Class")
    ),
    h(CoverageDataPanel, {
      topSlot: h(TestRunPanel, {testRun}),
      onLines: setLinesOf,
      key: "cov-" + seq,
      tooling: true,
      soql: "SELECT ApexClassOrTriggerId, ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered, LastModifiedDate FROM ApexCodeCoverageAggregate ORDER BY ApexClassOrTrigger.Name",
      postFetch: async (rows) => {
        let trig = {};
        try {
          const t = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
            encodeURIComponent("SELECT Id FROM ApexTrigger"), {useCache: false});
          (t.records || []).forEach(x => { trig[x.Id] = true; });
        } catch (e) { /* unknown types */ }
        rows.forEach(r => { r._isTrigger = !!trig[r.ApexClassOrTriggerId]; });
        try {
          const s = await sfConn.rest(`/services/data/v${apiVersion}/search/?q=` +
            encodeURIComponent("FIND {@IsTest} IN ALL FIELDS RETURNING ApexClass(Id, Name)"),
            {useCache: false});
          const testIds = {};
          (s.searchRecords || []).forEach(x => { testIds[x.Id] = true; });
          setFilterNote(null);
          return rows.filter(r => r._isTrigger || !testIds[r.ApexClassOrTriggerId]);
        } catch (e) {
          setFilterNote("Could not check @IsTest classes — showing all rows.");
          return rows;
        }
      },
      emptyText: "No coverage data yet — run your tests first.",
      placeholder: (n) => `Filter ${fmtNum(n)} classes…`,
      match: (r, needle) => nm(r).toLowerCase().includes(needle),
      nameOf: nm,
      pctOf,
      running,
      runRow: (r) => runTests({tests: [{classId: r.ApexClassOrTriggerId}]}, nm(r), nm(r))
    })
  );
}

// ─── Code Coverage dashboard body ─────────────────────────────────────────
// Same data flow as OrgLogCard (load → postFetch → filter → copy → run),
// rendered as a summary card plus a sortable, paginated table. Nothing here
// changes what is queried or counted: "Above 75%" is still coverage >= 76%.
const COV_PAGE_SIZE = 10;

// Relative "Last updated" label, derived from the rows' LastModifiedDate.
function covAgo(ms) {
  if (!ms) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function CoverageDataPanel({tooling, soql, postFetch, emptyText, placeholder,
  match, nameOf, pctOf, running, runRow, topSlot, onLines}) {
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [copied, setCopied] = React.useState(null);
  const [sortDir, setSortDir] = React.useState(0); // 0 = the SOQL name order
  const [page, setPage] = React.useState(1);
  const [, setTick] = React.useState(0);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await sfConn.rest(`/services/data/v${apiVersion}/${tooling ? "tooling/" : ""}query/?q=` +
        encodeURIComponent(soql), {useCache: false});
      let recs = (res && res.records) || [];
      if (postFetch) recs = await postFetch(recs);
      setRows(recs);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };
  React.useEffect(() => { load(); }, []);
  // "Last updated" ages along on its own — no extra query.
  React.useEffect(() => {
    const t = setInterval(() => setTick(v => v + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const copy = (key, text) => {
    try { safeCopyText(text); } catch (e) { /* ignore */ }
    setCopied(key);
    setTimeout(() => setCopied(null), 1200);
  };

  const list = rows || [];
  const needle = filter.trim().toLowerCase();
  const shown = needle ? list.filter(r => match(r, needle)) : list;

  const linesOf = (r) => (r.NumLinesCovered || 0) + (r.NumLinesUncovered || 0);

  // Summary maths — the numbers the old stats list showed, as tiles.
  let cov = 0, uncov = 0, ok = 0, low = 0;
  list.forEach(r => {
    cov += r.NumLinesCovered || 0;
    uncov += r.NumLinesUncovered || 0;
    const p = pctOf(r);
    if (p == null) return;
    if (p >= 76) ok++; else low++;
  });
  const allLines = cov + uncov;
  const avg = allLines > 0 ? Math.round(cov / allLines * 100) : null;
  const share = (n) => list.length ? Math.round(n / list.length * 100) : 0;
  const lastMs = list.reduce((m, r) => Math.max(m, Date.parse(r.LastModifiedDate) || 0), 0);

  // Client-side coverage sort (name order stays the default) + pagination.
  const sorted = sortDir
    ? shown.slice().sort((a, b) => {
        const pa = pctOf(a), pb = pctOf(b);
        if (pa == null && pb == null) return 0;
        if (pa == null) return 1; // n/a sinks to the bottom either way
        if (pb == null) return -1;
        return (pa - pb) * sortDir;
      })
    : shown;
  const pages = Math.max(1, Math.ceil(sorted.length / COV_PAGE_SIZE));
  const cur = Math.min(page, pages);
  const slice = sorted.slice((cur - 1) * COV_PAGE_SIZE, cur * COV_PAGE_SIZE);
  const firstIdx = sorted.length ? (cur - 1) * COV_PAGE_SIZE + 1 : 0;
  const lastIdx = Math.min(cur * COV_PAGE_SIZE, sorted.length);

  // Windowed pager — 1 2 3 4 5 … 9 for a 9-page list on page 1.
  const pageNums = [];
  if (pages <= 7) {
    for (let p = 1; p <= pages; p++) pageNums.push(p);
  } else {
    const start = Math.max(1, Math.min(cur - 2, pages - 4));
    const end = Math.min(pages, start + 4);
    if (start > 1) pageNums.push("…");
    for (let p = start; p <= end; p++) pageNums.push(p);
    if (end < pages) pageNums.push("…");
  }

  const tiles = [
    {key: "total", ico: "📄", tone: "blue", label: "Total Classes",
      value: fmtNum(list.length), sub: "Classes & Triggers"},
    {key: "above", ico: "✅", tone: "green", label: "Above 75%",
      value: fmtNum(ok), sub: `${share(ok)}% of total`, bar: share(ok)},
    {key: "below", ico: "❌", tone: "red", label: "Below 75%",
      value: fmtNum(low), sub: `${share(low)}% of total`, bar: share(low)},
    {key: "overall", ico: "📈", tone: "violet", label: "Overall Coverage",
      value: avg == null ? "—" : avg + "%", bar: avg == null ? 0 : avg}
  ];

  return h("div", {className: "covdash-main"},
    topSlot,
    h("section", {className: "covdash-card"},
      h("div", {className: "covdash-sum-h"},
        h("span", {className: "covdash-sum-ico", "aria-hidden": "true"}, "📊"),
        h("h2", {className: "covdash-sum-t"}, "Code Coverage Summary"),
        h("span", {
          className: "covdash-i",
          title: "Per-class coverage from ApexCodeCoverageAggregate — refreshed after every test run."
        }, "i"),
        h("span", {className: "covdash-tip"},
          h("span", {className: "covdash-tip-i", "aria-hidden": "true"}, "i"),
          "Coverage trend means how overall code coverage changes over time across test runs."),
        h("div", {className: "audit-actions"},
          h("span", {className: "covdash-at"}, "Last updated: " + covAgo(lastMs)),
          h("button", {
            className: "covdash-refresh",
            disabled: busy,
            title: "Reload the coverage table",
            onClick: load
          },
            h("span", {"aria-hidden": "true"}, "⟳ "),
            busy ? (rows ? "Refreshing…" : "Loading…") : "Refresh")
        )
      ),
      error && h("div", {className: "insp-error"}, error),
      rows === null && !error &&
        h("div", {className: "insp-status-info"}, "Loading code coverage…"),
      rows !== null && h("div", {className: "covdash-tiles"},
        tiles.map(t => h("div", {key: t.key, className: "covdash-tile cov-tone-" + t.tone},
          h("div", {className: "covdash-tile-top"},
            h("span", {className: "covdash-tile-ico", "aria-hidden": "true"}, t.ico),
            h("span", {className: "covdash-tile-label"}, t.label)),
          h("div", {className: "covdash-tile-val"}, t.value),
          t.sub && h("div", {className: "covdash-tile-sub"}, t.sub),
          t.bar != null && h("div", {className: "covdash-bar"},
            h("div", {
              className: "covdash-bar-fill",
              style: {width: Math.max(0, Math.min(100, t.bar)) + "%"}
            }))
        ))
      )
    ),
    h("section", {className: "covdash-card"},
      h("div", {className: "covdash-tab-h"},
        h("h3", {className: "covdash-tab-t"}, `Classes & Triggers (${fmtNum(list.length)})`),
        rows !== null && list.length > 0 && h("input", {
          className: "covdash-filter",
          type: "search",
          placeholder: placeholder(list.length),
          "aria-label": "Filter classes",
          value: filter,
          onChange: (e) => { setFilter(e.target.value); setPage(1); }
        })
      ),
      rows === null && !error &&
        h("div", {className: "insp-status-info"}, "Loading rows…"),
      rows !== null && list.length === 0 &&
        h("div", {className: "insp-empty"}, emptyText || "No records found."),
      rows !== null && list.length > 0 && (slice.length === 0
        ? h("div", {className: "insp-empty"}, "No matches")
        : h("div", {className: "covdash-tablewrap"},
          h("table", {className: "covdash-table"},
            h("thead", null,
              h("tr", null,
                h("th", {className: "covdash-c-n", scope: "col"}, "#"),
                h("th", {scope: "col"}, "Name"),
                h("th", {className: "covdash-c-type", scope: "col"}, "Type"),
                h("th", {className: "covdash-c-num", scope: "col"}, "Lines"),
                h("th", {className: "covdash-c-num", scope: "col"}, "Covered"),
                h("th", {
                  className: "covdash-c-cov" + (sortDir ? " sorted" : ""),
                  scope: "col",
                  title: "Sort by coverage",
                  onClick: () => { setSortDir(d => d === 1 ? -1 : 1); setPage(1); }
                },
                  "Coverage ",
                  h("span", {"aria-hidden": "true"},
                    sortDir ? (sortDir === 1 ? "▲" : "▼") : "⇅")),
                h("th", {className: "covdash-c-act", scope: "col"}, "Actions")
              )
            ),
            h("tbody", null,
              slice.map((r, i) => {
                const p = pctOf(r);
                const key = r.ApexClassOrTriggerId || nameOf(r);
                const total = linesOf(r);
                const line = `${nameOf(r)} — ${p == null ? "n/a" : p + "%"} ` +
                  `(${fmtNum(r.NumLinesCovered || 0)}/${fmtNum(total)} lines)`;
                const tone = p == null ? "none" : p >= 76 ? "ok" : p < 1 ? "bad" : "warn";
                return h("tr", {
                  key,
                  className: "covdash-row covt-" + tone,
                  title: "Click to copy: " + line,
                  onClick: () => copy(key, line)
                },
                  h("td", {className: "covdash-c-n"}, fmtNum(firstIdx + i)),
                  h("td", {className: "covdash-name"},
                    h("span", {className: "covdash-name-t"}, nameOf(r)),
                    copied === key && h("span", {className: "covdash-copied"}, "✓ copied")),
                  h("td", {className: "covdash-c-type"},
                    r._isTrigger ? "Apex Trigger" : "Apex Class"),
                  h("td", {className: "covdash-c-num"}, fmtNum(r.NumLinesCovered || 0)),
                  h("td", {className: "covdash-c-num"}, fmtNum(total)),
                  h("td", {className: "covdash-c-cov"},
                    h("span", {className: "covdash-pct"}, p == null ? "n/a" : p + "%"),
                    h("span", {className: "covdash-rowbar"},
                      h("span", {
                        className: "covdash-rowbar-fill",
                        style: {width: (p == null ? 0 : p) + "%"}
                      }))),
                  h("td", {className: "covdash-c-act"},
                    onLines && h("button", {
                      className: "covdash-runbtn covdash-linesbtn",
                      title: `Show covered and uncovered lines of ${nameOf(r)}`,
                      onClick: (e) => {
                        e.stopPropagation();
                        onLines({id: r.ApexClassOrTriggerId, name: nameOf(r), isTrigger: !!r._isTrigger});
                      }
                    }, "Lines"),
                    r._isTrigger
                      ? h("span", {
                          className: "covdash-noact",
                          title: "Triggers are covered through their test classes — run the class instead"
                        }, "—")
                      : h("button", {
                          className: "covdash-runbtn",
                          title: `Run tests in ${nameOf(r)}`,
                          onClick: (e) => {
                            e.stopPropagation();
                            runRow(r);
                          }
                        }, running ? "…" : "Run"))
                );
              })
            )
          ),
          list.length >= 200 &&
            h("div", {className: "perm-more"}, "Showing the newest 200 rows.")
        )),
      sorted.length > 0 && h("div", {className: "covdash-foot"},
        h("span", {className: "covdash-foot-t"},
          `Showing ${fmtNum(firstIdx)}–${fmtNum(lastIdx)} of ${fmtNum(sorted.length)} classes`),
        pages > 1 && h("div", {className: "covdash-pager"},
          h("button", {
            className: "covdash-page covdash-step",
            disabled: cur <= 1,
            "aria-label": "Previous page",
            onClick: () => setPage(cur - 1)
          }, "‹"),
          pageNums.map((pn, i) => pn === "…"
            ? h("span", {key: "d" + i, className: "covdash-page-dots"}, "…")
            : h("button", {
                key: pn,
                className: "covdash-page" + (pn === cur ? " cur" : ""),
                "aria-label": "Page " + pn,
                "aria-current": pn === cur ? "page" : undefined,
                onClick: () => setPage(pn)
              }, pn)),
          h("button", {
            className: "covdash-page covdash-step",
            disabled: cur >= pages,
            "aria-label": "Next page",
            onClick: () => setPage(cur + 1)
          }, "›")
        )
      )
    )
  );
}

export {CoverageTab};
