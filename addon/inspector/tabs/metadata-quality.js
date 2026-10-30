// Metadata → Schema → Data quality: profile a sample of records of the open
// object (fill rate, values, outliers, duplicates) with an optional AI review.
// Read-only: one SELECT, nothing is changed.
import {hasValidConfig} from "../../llm/llm-service.js";
import {safeCopyText} from "../../utils.js";
import {qualityFields, qualityQuery, profileFields, duplicateGroups, qualityIssues, qualityForPrompt} from "../../core/data-quality.js";
import {runSoql} from "../shared/query.js";
import {explainDataQuality} from "../shared/ai.js";
import {AnalysisReport} from "../shared/analysis-report.js";
import {useUnmountSignal} from "../shared/hooks.js";

const h = React.createElement;
const SAMPLE_SIZES = [200, 1000, 2000];

function openSettings() {
  try { chrome.runtime.sendMessage({message: "openOptions", host: ""}); }
  catch (e) { /* extension context only */ }
}

const tone = pct => (pct >= 80 ? "green" : pct >= 40 ? "blue" : "red");

export function DataQualityPanel({describe, onFilter}) {
  const unmount = useUnmountSignal();
  const [size, setSize] = React.useState(1000);
  const [state, setState] = React.useState(null); // {loading} | {error} | {profiles, dups, result, n}
  const [onlyIssues, setOnlyIssues] = React.useState(false);
  const [ai, setAi] = React.useState(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => { setState(null); setAi(null); }, [describe.name]);

  const analyze = async () => {
    setState({loading: true});
    setAi(null);
    try {
      const fields = qualityFields(describe);
      const res = await runSoql(qualityQuery(describe, fields, size));
      const records = res.records || [];
      const profiles = profileFields(records, describe, fields);
      const dups = duplicateGroups(records, fields);
      setState({profiles, dups, result: qualityIssues(profiles, dups, records.length), n: records.length});
    } catch (e) {
      if (!unmount.current.signal.aborted) setState({error: e.message});
    }
  };
  const review = async () => {
    if (!hasValidConfig()) { setAi({error: "NO_LLM_CONFIG"}); return; }
    setAi({loading: true});
    try {
      const text = await explainDataQuality(qualityForPrompt(describe.name, state.n, state.profiles, state.dups, state.result), {signal: unmount.current.signal});
      setAi({text});
    } catch (e) {
      if (!unmount.current.signal.aborted) setAi({error: e.message});
    }
  };

  const ready = state && state.profiles;
  const flagged = ready ? new Set(state.result.issues.map(i => i.field)) : new Set();
  const rows = ready ? state.profiles.filter(p => !onlyIssues || flagged.has(p.name)) : [];

  return h("div", {className: "dq"},
    h("div", {className: "insp-meta"},
      "Profiles the newest records of this object: how often each field is filled, repeated values, extreme numbers and " +
      "likely duplicates. Read-only — one query, nothing is changed."),
    h("div", {className: "dq-bar"},
      h("label", {className: "insp-field"},
        h("span", null, "Sample size"),
        h("select", {value: size, onChange: e => setSize(Number(e.target.value))},
          SAMPLE_SIZES.map(n => h("option", {key: n, value: n}, `${n} newest records`)))),
      h("button", {className: "btn btn-primary btn-sm", disabled: state && state.loading, onClick: analyze},
        state && state.loading ? "Analyzing…" : ready ? "Analyze again" : "Analyze data"),
      ready && h("button", {className: "btn btn-secondary btn-sm", disabled: ai && ai.loading, onClick: review},
        ai && ai.loading ? "Asking AI…" : "✨ AI review")),
    state && state.error && h("div", {className: "insp-error"}, state.error),
    ready && state.n === 0 && h("div", {className: "insp-meta"}, "No records to analyze."),
    ready && state.n > 0 && h("div", null,
      h("div", {className: "dq-stats"},
        h("div", {className: "dq-stat cov-tone-" + tone(state.result.score)},
          h("div", {className: "dq-stat-v"}, `${state.result.score}`, h("small", null, "/100")),
          h("div", {className: "dq-stat-l"}, "Quality score"),
          h("div", {className: "covdash-bar"}, h("div", {className: "covdash-bar-fill", style: {width: state.result.score + "%"}}))),
        h("div", {className: "dq-stat"}, h("div", {className: "dq-stat-v"}, state.n), h("div", {className: "dq-stat-l"}, "Records sampled")),
        h("div", {className: "dq-stat"}, h("div", {className: "dq-stat-v"}, state.profiles.length), h("div", {className: "dq-stat-l"}, "Fields profiled")),
        h("div", {className: "dq-stat"}, h("div", {className: "dq-stat-v"}, state.result.issues.length), h("div", {className: "dq-stat-l"}, "Issues"))),
      ai && ai.error === "NO_LLM_CONFIG" && h("div", {className: "insp-warn"},
        "AI review needs a provider + API key. ",
        h("button", {className: "field-action-btn", onClick: openSettings}, "Open Settings")),
      ai && ai.error && ai.error !== "NO_LLM_CONFIG" && h("div", {className: "insp-error"}, "AI request failed: " + ai.error),
      ai && ai.text && h(AnalysisReport, {
        text: ai.text, copied,
        onCopy: () => {
          try { safeCopyText(ai.text); } catch (e) { /* ignore */ }
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }
      }),
      state.result.issues.length > 0 && h("ul", {className: "dq-issues"},
        state.result.issues.slice(0, 30).map((i, k) => h("li", {key: k, className: "dq-issue dq-" + i.level},
          h("button", {className: "field-action-btn", title: "Show this field in the Fields view", onClick: () => onFilter && onFilter(i.field)}, i.field),
          " ", i.text))),
      state.dups.length > 0 && h("details", {className: "dq-dups"},
        h("summary", null, `Possible duplicates (${state.dups.length} group${state.dups.length > 1 ? "s" : ""})`),
        h("div", {className: "insp-table-wrap"},
          h("table", {className: "insp-table"},
            h("thead", null, h("tr", null, h("th", null, "Field"), h("th", null, "Value"), h("th", null, "Records"), h("th", null, ""))),
            h("tbody", null, state.dups.map((g, k) => h("tr", {key: k},
              h("td", {className: "ff-mono"}, g.field), h("td", null, g.value), h("td", null, g.ids.length),
              h("td", null, h("button", {
                className: "field-action-btn", title: "Copy a SOQL that lists these records",
                onClick: () => safeCopyText(`SELECT Id, ${g.field} FROM ${describe.name} WHERE Id IN ('${g.ids.join("','")}')`)
              }, "Copy SOQL")))))))),
      h("label", {className: "plan-check dq-only"},
        h("input", {type: "checkbox", checked: onlyIssues, onChange: e => setOnlyIssues(e.target.checked)}), " Only fields with issues"),
      h("div", {className: "insp-table-wrap"},
        h("table", {className: "insp-table dq-table"},
          h("thead", null, h("tr", null,
            h("th", null, "Field"), h("th", null, "Type"), h("th", null, "Filled"), h("th", null, "Distinct"), h("th", null, "Most common"), h("th", null, "Notes"))),
          h("tbody", null, rows.map(p => h("tr", {key: p.name, className: flagged.has(p.name) ? "dq-flag" : ""},
            h("td", null, h("div", null, p.label), h("div", {className: "ff-mono dq-api"}, p.name)),
            h("td", null, p.type),
            h("td", {className: "dq-fill cov-tone-" + tone(p.fillPct)},
              h("span", null, `${p.fillPct}%`),
              h("div", {className: "covdash-bar"}, h("div", {className: "covdash-bar-fill", style: {width: p.fillPct + "%"}}))),
            h("td", null, p.distinct),
            h("td", {className: "dq-top", title: p.top ? p.top.value : ""}, p.top ? `${p.top.value.slice(0, 40)} (${p.top.pct}%)` : "—"),
            h("td", null, [
              p.required && "required",
              p.outliers ? `${p.outliers} outlier(s)` : null,
              p.invalid ? `${p.invalid} inactive value(s)` : null
            ].filter(Boolean).join(" · ")))))))));
}
