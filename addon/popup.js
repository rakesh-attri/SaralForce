import {sfConn, apiVersion} from "./inspector.js";
import {hasValidConfig, getSavedConfig, getProviderConfig} from "./llm/llm-service.js";

let h = React.createElement;
let sfHost = null;

function getFilteredLocalStorage() {
  const host = new URLSearchParams(window.location.search).get("host");
  const domainStart = host?.split(".")[0];
  const storedData = {...localStorage};
  return Object.fromEntries(
    Object.entries(storedData).filter(([key]) => key.startsWith(domainStart) && !key.endsWith("_access_token"))
  );
}

{
  parent.postMessage(
    {insextInitRequest: true, iFrameLocalStorage: getFilteredLocalStorage()},
    "*"
  );
  addEventListener("message", function initResponseHandler(e) {
    if (e.source == parent) {
      if (e.data.insextInitResponse) {
        init(e.data);
      } else if (e.data.updateLocalStorage) {
        localStorage.setItem(e.data.key, e.data.value);
      }
    }
  });
  chrome.runtime.onMessage.addListener((request) => {
    if (request.msg === "shortcut_pressed") {
      if (request.command === "open-object-creator") {
        parent.postMessage({insextOpenPopup: true}, "*");
      }
    } else if (request.message === "tokenUpdated" && request.sfHost) {
      const newToken = localStorage.getItem(request.sfHost + "_access_token");
      if (newToken) {
        sfConn.sessionId = newToken;
        init({sfHost: request.sfHost});
      }
    }
  });
}

function closePopup() {
  parent.postMessage({insextClosePopup: true}, "*");
}

function init({sfHost: host}) {
  sfHost = host;

  sfConn.getSession(sfHost).then(() => {
    ReactDOM.render(
      h(App, {sfHost}),
      document.getElementById("root")
    );
  });
}

class App extends React.PureComponent {
  constructor(props) {
    super(props);
    this.state = {
      llmConfigured: hasValidConfig(),
      orgInfo: null
    };
  }

  componentDidMount() {
    this.fetchOrgInfo();
    window.addEventListener("focus", () => {
      this.setState({llmConfigured: hasValidConfig()});
    });
  }

  async fetchOrgInfo() {
    try {
      const res = await sfConn.rest("/services/data/v" + apiVersion + "/query/?q=SELECT+Name,OrganizationType,InstanceName+FROM+Organization");
      if (res.records && res.records[0]) {
        this.setState({orgInfo: res.records[0]});
      }
    } catch (e) {
      console.error("Error fetching org info:", e);
    }
  }

  openObjectCreator(e) {
    const linkTarget = (e.ctrlKey || e.metaKey) ? "_blank" : "_top";
    const url = `object-creator.html?host=${sfHost}`;
    window.open(url, linkTarget);
  }

  openOptions(e) {
    const linkTarget = (e.ctrlKey || e.metaKey) ? "_blank" : "_top";
    const url = `options.html?host=${sfHost}`;
    window.open(url, linkTarget);
  }

  render() {
    const {llmConfigured, orgInfo} = this.state;
    const config = getSavedConfig();
    const providerInfo = config?.provider ? getProviderConfig(config.provider) : null;

    return h("div", {className: "popup-container"},
      h("div", {className: "popup-header"},
        h("h1", null, "ForceForge"),
        h("p", null, "AI Object Builder & Org Toolkit")
      ),

      orgInfo && h("div", {className: "org-info"},
        h("strong", null, orgInfo.Name),
        orgInfo.OrganizationType && ` (${orgInfo.OrganizationType})`,
        orgInfo.InstanceName && ` - ${orgInfo.InstanceName}`
      ),

      !llmConfigured && h("div", {className: "config-warning"},
        "LLM not configured. ",
        h("a", {
          href: "#",
          onClick: (e) => { e.preventDefault(); this.openOptions(e); }
        }, "Set up your API key")
      ),

      h("div", {className: "popup-actions"},
        h("button", {
          className: "popup-btn primary",
          onClick: (e) => this.openObjectCreator(e)
        },
          h("span", {className: "btn-icon"}, "\u2728"),
          "AI Object Builder"
        ),
        h("button", {
          className: "popup-btn",
          onClick: (e) => this.openOptions(e)
        },
          h("span", {className: "btn-icon"}, "\u2699"),
          `Options${providerInfo ? ` (${providerInfo.name})` : ""}`
        )
      ),

      h("div", {className: "popup-footer"},
        "v1.1.0 | ",
        h("a", {href: "#", onClick: (e) => { e.preventDefault(); this.openOptions(e); }}, "Configure LLM Provider")
      )
    );
  }
}
