// Custom Metadata Types: list types, read records, and create / update /
// delete types or records through the Metadata API (SOAP) — the Tooling and
// REST APIs cannot write custom metadata.
import {sfConn, apiVersion} from "../../inspector.js";
import {buildSoapEnvelope} from "../../builder/metadata-soap.js";
import {createMetadataBody, upsertMetadataBody, deleteMetadataBody, parseCreateResult} from "../../core/cmdt.js";
import {queryAll} from "./query.js";
import {ffGetObjects, ffDescribeObject} from "./describe.js";

async function soapCall(bodyXml) {
  const res = await fetch(`https://${sfConn.instanceHostname}/services/Soap/m/${apiVersion}`, {
    method: "POST",
    headers: {"Content-Type": "text/xml", "SOAPAction": '""'},
    body: buildSoapEnvelope(sfConn.sessionId, bodyXml)
  });
  const result = parseCreateResult(await res.text());
  if (!result.success) throw new Error(result.errors.join("; "));
  return result;
}

const soapCreate = metadataXml => soapCall(createMetadataBody(metadataXml));
const soapUpsert = metadataXml => soapCall(upsertMetadataBody(metadataXml));
const soapDelete = (type, fullName) => soapCall(deleteMetadataBody(type, fullName));

// Types as list rows ({Id, name, label}); Id is the API name.
async function listCmdtTypes() {
  const all = await ffGetObjects(true);
  return all.filter(o => /__mdt$/.test(o.name)).map(o => ({Id: o.name, name: o.name, label: o.label}));
}

// Fields records carry: every custom field of the type (describe, fresh so
// newly added fields show up).
async function cmdtFields(typeName) {
  const d = await ffDescribeObject(typeName);
  return {describe: d, fields: (d.fields || []).filter(f => f.custom || /__c$/.test(f.name))};
}

// Every record with every custom field value (like Setup → Manage Records).
async function cmdtRecords(typeName, fields) {
  const cols = ["Id", "DeveloperName", "MasterLabel", "NamespacePrefix", ...fields.map(f => f.name)];
  return queryAll(`SELECT ${[...new Set(cols)].join(", ")} FROM ${typeName} ORDER BY MasterLabel LIMIT 5000`);
}

export {soapCreate, soapUpsert, soapDelete, listCmdtTypes, cmdtFields, cmdtRecords};
