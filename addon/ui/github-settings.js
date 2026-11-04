// Settings → GitHub (optional): token, repository, branch and folder used by
// Release Center to commit releases and snapshots and to deploy from Git.
import {githubConfig, saveGithubConfig, testGithub, GITHUB_ORIGIN} from "../inspector/shared/github.js";

const h = React.createElement;

function requestAccess() {
  // Must start inside the click (user gesture).
  if (typeof chrome === "undefined" || !chrome.permissions || !chrome.permissions.request) return Promise.resolve(true);
  return new Promise(resolve => {
    try { chrome.permissions.request({origins: [GITHUB_ORIGIN]}, ok => resolve(!!ok)); } catch (e) { resolve(false); }
  });
}

export function GitHubCard() {
  const saved = githubConfig();
  const [token, setToken] = React.useState(saved ? saved.token : "");
  const [repo, setRepo] = React.useState(saved ? saved.repo : "");
  const [branch, setBranch] = React.useState(saved ? saved.branch : "main");
  const [base, setBase] = React.useState(saved ? saved.base : "force-app/main/default");
  const [show, setShow] = React.useState(false);
  const [state, setState] = React.useState({kind: saved ? "ok" : "", text: saved ? `Connected to ${saved.repo}` : ""});
  const [busy, setBusy] = React.useState(false);
  const cleanRepo = repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");

  const connect = () => {
    const access = requestAccess();
    setBusy(true);
    setState({kind: "", text: "Checking…"});
    access.then(async granted => {
      if (!granted) throw new Error("SaralForce needs permission to reach api.github.com. Allow it when the browser asks.");
      const cfg = {token: token.trim(), repo: cleanRepo, branch: branch.trim() || "main", base: base.trim().replace(/^\/+|\/+$/g, "")};
      const info = await testGithub(cfg);
      saveGithubConfig(cfg);
      setRepo(cfg.repo);
      setState({kind: info.canPush ? "ok" : "warn", text: info.canPush
        ? `Connected to ${info.fullName}${info.private ? " (private)" : ""}. Default branch: ${info.defaultBranch}.`
        : `Connected to ${info.fullName}, but this token can't push. Commits will fail; reading a branch works.`});
    }).catch(e => setState({kind: "err", text: e.message || String(e)})).finally(() => setBusy(false));
  };
  const remove = () => {
    saveGithubConfig(null);
    setToken("");
    setState({kind: "", text: "Removed from this browser."});
  };

  return h("section", {className: "opt-card"},
    h("div", {className: "opt-card-h"},
      h("div", null,
        h("h2", null, "GitHub ", h("span", {className: "opt-optional"}, "optional")),
        h("p", null, "Release Center can commit each release and snapshot to a repository (Salesforce DX source format) and deploy from a branch.")),
      h("span", {className: "opt-status " + (saved ? "on" : "off")},
        h("span", {className: "opt-dot", "aria-hidden": "true"}), saved ? "Connected" : "Not set up")),
    h("div", {className: "opt-step"},
      h("div", {className: "opt-step-h"}, h("span", {className: "opt-num"}, "1"), "Personal access token",
        h("a", {className: "opt-link", href: "https://github.com/settings/personal-access-tokens/new", target: "_blank", rel: "noopener noreferrer"}, "Create a token ↗")),
      h("p", {className: "opt-help"}, "A fine-grained token for one repository with Contents: Read and write. It stays in this browser and is sent only to api.github.com."),
      h("div", {className: "opt-inline"},
        h("input", {type: show ? "text" : "password", className: "opt-input", value: token, autoComplete: "off", spellCheck: false,
          onChange: e => setToken(e.target.value), placeholder: "github_pat_…", "aria-label": "GitHub token"}),
        h("button", {className: "opt-btn opt-btn-ghost", onClick: () => setShow(!show)}, show ? "Hide" : "Show"))),
    h("div", {className: "opt-step"},
      h("div", {className: "opt-step-h"}, h("span", {className: "opt-num"}, "2"), "Repository"),
      h("div", {className: "opt-gh-grid"},
        h("label", null, h("span", {className: "opt-help"}, "owner/name"),
          h("input", {className: "opt-input", value: repo, onChange: e => setRepo(e.target.value), placeholder: "acme/salesforce", "aria-label": "Repository"})),
        h("label", null, h("span", {className: "opt-help"}, "Branch"),
          h("input", {className: "opt-input", value: branch, onChange: e => setBranch(e.target.value), placeholder: "main", "aria-label": "Branch"})),
        h("label", null, h("span", {className: "opt-help"}, "Folder"),
          h("input", {className: "opt-input", value: base, onChange: e => setBase(e.target.value), placeholder: "force-app/main/default", "aria-label": "Folder"})))),
    h("div", {className: "opt-actions"},
      h("button", {className: "opt-btn opt-btn-primary", disabled: busy || !token.trim() || !/^[\w.-]+\/[\w.-]+$/.test(cleanRepo), onClick: connect}, busy ? "Checking…" : "Connect & test"),
      saved && h("button", {className: "opt-btn opt-btn-ghost", onClick: remove}, "Remove")),
    state.text && h("div", {className: "opt-alert " + (state.kind === "err" ? "err" : state.kind === "warn" ? "warn" : "ok"), role: "status"}, state.text));
}
