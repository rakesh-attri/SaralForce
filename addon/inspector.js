// Session/authentication layer derived in part from Salesforce-Inspector-reloaded
// (https://github.com/tprouvot/Salesforce-Inspector-reloaded)
// MIT License, Copyright (c) 2023 Thomas Prouvot. See LICENSE.
import {getRedirectUri, getClientId, getPKCEParameters, isSettingEnabled, Constants} from "./utils.js";

export let defaultApiVersion = "67.0";
export let apiVersion = localStorage.getItem("apiVersion") == null ? defaultApiVersion : localStorage.getItem("apiVersion");

export let sessionError;

function getCallOptionsClientId() {
  return "ForceForge";
}

export let sfConn = {

  async getSession(sfHost) {
    const url = new URL(window.location.href);
    const searchParams = new URLSearchParams(url.search);
    const authorizationCode = searchParams.get("code");
    const state = searchParams.get("state");

    if (authorizationCode && state) {
      try {
        const stateData = JSON.parse(decodeURIComponent(state));
        sfHost = stateData.sfHost;
      } catch (error) {
        console.error("Error parsing state parameter:", error);
      }
    }

    sfHost = getMyDomain(sfHost);
    const oldToken = localStorage.getItem(sfHost + Constants.ACCESS_TOKEN);
    this.instanceHostname = sfHost;

    if (authorizationCode) {
      try {
        const codeVerifier = localStorage.getItem(sfHost + Constants.CODE_VERIFIER);
        if (!codeVerifier) {
          throw new Error("Code verifier not found. Please restart the authorization flow.");
        }
        const accessToken = await this.exchangeCodeForToken(sfHost, authorizationCode, codeVerifier);
        this.sessionId = accessToken;
        localStorage.setItem(sfHost + Constants.ACCESS_TOKEN, accessToken);
        chrome.runtime.sendMessage({message: "tokenUpdated", sfHost});
        localStorage.removeItem(sfHost + Constants.CODE_VERIFIER);
        const cleanUrl = url.origin + url.pathname + "?host=" + sfHost + url.hash;
        window.history.replaceState({}, document.title, cleanUrl);
      } catch (error) {
        console.error("Error exchanging authorization code for token:", error);
        sessionError = {text: error.message, type: "error", icon: "error"};
      }
    } else if (oldToken) {
      this.sessionId = oldToken;
    } else {
      let message = await new Promise(resolve =>
        chrome.runtime.sendMessage({message: "getSession", sfHost}, resolve));
      if (message) {
        this.instanceHostname = getMyDomain(message.hostname);
        this.sessionId = message.key;
      }
    }
    if (localStorage.getItem(sfHost + "_trialExpirationDate") == null) {
      sfConn.rest("/services/data/v" + apiVersion + "/query/?q=SELECT+IsSandbox,+InstanceName+,TrialExpirationDate+FROM+Organization").then(res => {
        localStorage.setItem(sfHost + "_isSandbox", res.records[0].IsSandbox);
        localStorage.setItem(sfHost + "_orgInstance", res.records[0].InstanceName);
        localStorage.setItem(sfHost + "_trialExpirationDate", res.records[0].TrialExpirationDate);
      });
    }
    return this.sessionId;
  },

  async exchangeCodeForToken(sfHost, authorizationCode, codeVerifier) {
    const redirectUri = getRedirectUri("object-creator.html");
    const clientId = getClientId(sfHost);

    if (!redirectUri || !redirectUri.includes("-extension://")) {
      throw new Error("Failed to generate redirect URI. Extension context may be invalidated. Please reload this page and try again.");
    }

    const tokenUrl = `https://${sfHost}/services/oauth2/token`;
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error_description || "Failed to exchange code for token");
    }

    const tokenData = await response.json();
    return tokenData.access_token;
  },

  async rest(url, {logErrors = true, method = "GET", body = undefined, bodyType = "json", responseType = "json", headers = {}, useCache = true, suppressSessionError = false} = {}) {
    if (!this.instanceHostname) {
      throw new Error("Instance Hostname not found");
    }

    let xhr = new XMLHttpRequest();
    if (useCache) {
      url += (url.includes("?") ? "&" : "?") + "cache=" + Math.random();
    }
    const sfHost = "https://" + this.instanceHostname;
    const fullUrl = new URL(url, sfHost);
    xhr.open(method, fullUrl.toString(), true);

    xhr.setRequestHeader("Authorization", "Bearer " + this.sessionId);

    for (let [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }

    if (body !== undefined && !headers.hasOwnProperty("Content-Type")) {
      xhr.setRequestHeader("Content-Type", "application/json; charset=UTF-8");
    }

    if (body !== undefined) {
      if (bodyType == "json") {
        body = JSON.stringify(body);
      }
    }

    if (!headers.hasOwnProperty("Accept")) {
      xhr.setRequestHeader("Accept", "application/json; charset=UTF-8");
    }

    xhr.setRequestHeader("Sforce-Call-Options", `client=${getCallOptionsClientId()}`);

    xhr.responseType = responseType;
    await new Promise((resolve, reject) => {
      xhr.onreadystatechange = () => {
        if (xhr.readyState == 4) {
          resolve();
        }
      };
      xhr.send(body);
    });

    if (xhr.status >= 200 && xhr.status < 400) {
      return xhr.response;
    } else if (xhr.status == 0) {
      if (!logErrors) { console.error("Received no response from Salesforce REST API", xhr); }
      let err = new Error();
      err.name = "SalesforceRestError";
      err.message = "Network error, offline or timeout";
      throw err;
    } else if (xhr.status == 401) {
      let error = xhr.response.length > 0 ? xhr.response[0].message : "New access token needed";
      if (!suppressSessionError && localStorage.getItem(this.instanceHostname + Constants.ACCESS_TOKEN)){
        sessionError = {text: "Access Token Expired", title: "Generate New Token", type: "warning", icon: "warning"};
      }
      let err = new Error();
      err.name = "Unauthorized";
      err.message = error;
      throw err;
    } else if (xhr.status == 403) {
      let error = xhr.response.length > 0 ? xhr.response[0].message : "Error";
      if (!suppressSessionError) {
        sessionError = {text: error, type: "error", icon: "error"};
      }
      let err = new Error();
      err.name = "Forbidden";
      err.message = error;
      throw err;
    } else {
      if (!logErrors) { console.error("Received error response from Salesforce REST API", xhr); }
      let err = new Error();
      err.name = "SalesforceRestError";
      err.detail = xhr.response;
      try {
        err.message = err.detail.map(err => `${err.errorCode}: ${err.message}${err.fields && err.fields.length > 0 ? ` [${err.fields.join(", ")}]` : ""}`).join("\n");
      } catch (ex) {
        err.message = JSON.stringify(xhr.response);
      }
      throw err;
    }
  },

  wsdl(apiVersion, apiName) {
    let wsdl = {
      Partner: {
        servicePortAddress: "/services/Soap/u/" + apiVersion,
        targetNamespaces: ' xmlns="urn:partner.soap.sforce.com" xmlns:sf="urn:sobject.partner.soap.sforce.com"',
        apiName: "Partner"
      },
      Metadata: {
        servicePortAddress: "/services/Soap/m/" + apiVersion,
        targetNamespaces: ' xmlns="http://soap.sforce.com/2006/04/metadata"',
        apiName: "Metadata"
      },
      Tooling: {
        servicePortAddress: "/services/Soap/T/" + apiVersion,
        targetNamespaces: ' xmlns="urn:tooling.soap.sforce.com" xmlns:sf="urn:sobject.tooling.soap.sforce.com" xmlns:mns="urn:metadata.tooling.soap.sforce.com"',
        apiName: "Tooling"
      }
    };
    if (apiName) {
      wsdl = wsdl[apiName];
    }
    return wsdl;
  },

  async soap(wsdl, method, args, {headers} = {}) {
    if (!this.instanceHostname || !this.sessionId) {
      throw new Error("Session not found");
    }

    let xhr = new XMLHttpRequest();
    xhr.open("POST", "https://" + this.instanceHostname + wsdl.servicePortAddress + "?cache=" + Math.random(), true);
    xhr.setRequestHeader("Content-Type", "text/xml");
    xhr.setRequestHeader("SOAPAction", '""');

    let sessionHeaderKey = wsdl.apiName == "Metadata" ? "met:SessionHeader" : "SessionHeader";
    let sessionIdKey = wsdl.apiName == "Metadata" ? "met:sessionId" : "sessionId";
    let requestMethod = wsdl.apiName == "Metadata" ? `met:${method}` : method;
    let requestAttributes = [
      'xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
      'xmlns:xsd="http://www.w3.org/2001/XMLSchema"',
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    ];
    if (wsdl.apiName == "Metadata") {
      requestAttributes.push('xmlns:met="http://soap.sforce.com/2006/04/metadata"');
    }

    let requestBody = XML.stringify({
      name: "soapenv:Envelope",
      attributes: ` ${requestAttributes.join(" ")}${wsdl.targetNamespaces}`,
      value: {
        "soapenv:Header": Object.assign({}, {[sessionHeaderKey]: {[sessionIdKey]: this.sessionId}}, headers),
        "soapenv:Body": {[requestMethod]: args}
      }
    });

    xhr.responseType = "document";
    await new Promise(resolve => {
      xhr.onreadystatechange = () => {
        if (xhr.readyState == 4) {
          resolve(xhr);
        }
      };
      xhr.send(requestBody);
    });

    if (xhr.status == 200) {
      let responseBody = xhr.response.querySelector(method + "Response");
      let parsed = XML.parse(responseBody).result;
      return parsed;
    } else {
      let err = new Error();
      err.name = "SalesforceSoapError";
      err.detail = xhr.response;
      try {
        err.message = xhr.response.querySelector("faultstring").textContent;
      } catch (ex) {
        err.message = `HTTP error ${xhr.status} ${xhr.statusText}`;
      }
      throw err;
    }
  },

  asArray(x) {
    if (!x) return [];
    if (x instanceof Array) return x;
    return [x];
  },

};

export class XML {
  static stringify({name, attributes, value}) {
    function buildRequest(el, params) {
      if (params == null) {
        el.setAttribute("xsi:nil", "true");
      } else if (typeof params == "object") {
        for (let [key, value] of Object.entries(params)) {
          if (key == "_") {
            if (value == null) {
              el.setAttribute("xsi:nil", "true");
            } else {
              el.textContent = value;
            }
          } else if (key == "$xsi:type") {
            el.setAttribute("xsi:type", value);
          } else if (value === undefined) {
            // ignore
          } else if (Array.isArray(value)) {
            for (let element of value) {
              let x = doc.createElement(key);
              buildRequest(x, element);
              el.appendChild(x);
            }
          } else {
            let x = doc.createElement(key);
            buildRequest(x, value);
            el.appendChild(x);
          }
        }
      } else {
        el.textContent = params;
      }
    }
    let doc = new DOMParser().parseFromString("<" + name + attributes + "/>", "text/xml");
    buildRequest(doc.documentElement, value);
    return '<?xml version="1.0" encoding="UTF-8"?>' + new XMLSerializer().serializeToString(doc).replace(/ xmlns=""/g, "");
  }

  static parse(element) {
    function parseResponse(element) {
      let str = "";
      let obj = null;
      if (element.getAttribute("xsi:nil") == "true") {
        return null;
      }
      let type = element.getAttribute("xsi:type");
      if (type) {
        obj = {
          "$xsi:type": type
        };
      }
      for (let child = element.firstChild; child != null; child = child.nextSibling) {
        if (child instanceof CharacterData) {
          str += child.data;
        } else if (child instanceof Element) {
          if (obj == null) {
            obj = {};
          }
          let name = child.localName;
          let content = parseResponse(child);
          if (name in obj) {
            if (obj[name] instanceof Array) {
              obj[name].push(content);
            } else {
              obj[name] = [obj[name], content];
            }
          } else {
            obj[name] = content;
          }
        } else {
          throw new Error("Unknown child node type");
        }
      }
      return obj || str;
    }
    return parseResponse(element);
  }
}

function getMyDomain(host) {
  if (host) {
    const myDomain = host
      .replace(/\.lightning\.force\./, ".my.salesforce.")
      .replace(/\.lightning\.([^.]+)\.force\.com$/, ".my.$1.salesforce.com")
      .replace(/\.mcas\.ms$/, "");
    return myDomain;
  }
  return host;
}

// Starts the OAuth Authorization Code + PKCE login (fallback for when no
// Salesforce session cookie is available). Navigates this page to the org's
// login; Salesforce redirects back to the extension with ?code=&state=,
// which sfConn.getSession() exchanges for a token.
// Requires an External Client App whose callback URL whitelists
// chrome-extension://<extension-id>/object-creator.html, with "Require
// Secret for Web Server Flow" OFF and PKCE required.
export async function startSalesforceLogin(sfHost) {
  const host = getMyDomain(sfHost);
  if (!host) throw new Error("No Salesforce host to log in to.");
  const clientId = getClientId(host);
  const redirectUri = getRedirectUri("object-creator.html");
  const pkce = await getPKCEParameters(host);
  if (!pkce || !pkce.code_verifier || !pkce.code_challenge) {
    throw new Error("Could not obtain PKCE parameters from the org.");
  }
  localStorage.setItem(host + Constants.CODE_VERIFIER, pkce.code_verifier);
  const state = encodeURIComponent(JSON.stringify({sfHost: host}));
  const authUrl = `https://${host}/services/oauth2/authorize?response_type=code`
    + `&client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&scope=${encodeURIComponent("api")}`
    + `&state=${state}`
    + `&code_challenge=${encodeURIComponent(pkce.code_challenge)}`
    + `&code_challenge_method=S256`;
  window.location.assign(authUrl);
}
