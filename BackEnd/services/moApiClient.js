const fs = require('fs');
const path = require('path');

const MO_API_CONFIG_PATH = path.join(__dirname, '..', 'API_Info_folder', 'MO_API.txt');

// Static query parameters for the "GETMOITEM" dynamic query (see MO_API.txt / GetDynamicData op).
const DYN_QUERY_ID = 'GETMOITEM';
const CRITERIA_NAME = 'MO';
const CRITERIA_VALUE_PREFIX = '0000';

// Some hosts resolve sfcs13.wymy.wiwynn.com to unrelated public IPs (confirmed
// 2026-07-24 on the AI-BOM-online deployment: their DNS path lacks Wiwynn's
// internal split-DNS zone, landing on a public WAF that 403s every request).
// The corporate DNS server correctly resolves it to 10.251.12.11. Connect to
// that IP directly and send the real hostname as the Host header (IIS routes
// by Host header for virtual sites) to make this immune to DNS misresolution
// everywhere, not just on the affected host.
const MO_API_HOST = 'sfcs13.wymy.wiwynn.com';
const MO_API_IP = '10.251.12.11';

// MO_API.txt holds the .asmx docs URL (e.g. ".../WebService.asmx?op=GetDynamicData").
// The ASMX "HTTP POST protocol" invoke URL for an operation is the base .asmx path
// with the operation name appended as a path segment (no query string).
function getOperationUrl(operation) {
  const raw = fs.readFileSync(MO_API_CONFIG_PATH, 'utf8').trim();
  const baseUrl = raw.split('?')[0];
  return `${baseUrl}/${operation}`;
}

// Builds the GetDynamicData request parameters for an MO Number lookup.
// CriteriaValue = static "0000" prefix + the MO Number entered by the user.
function buildMoLookupParams(moNumber) {
  const mo = String(moNumber).trim();
  return {
    DynQueryID: DYN_QUERY_ID,
    CriteriaName: CRITERIA_NAME,
    CriteriaValue: CRITERIA_VALUE_PREFIX + mo
  };
}

// Invokes the GetDynamicData operation via the ASMX HTTP POST protocol
// (application/x-www-form-urlencoded body, one field per parameter).
// Returns the raw XML response text — parsing it into structured item data is Phase 2,
// once the actual response schema has been observed.
async function fetchMoItem(moNumber) {
  const params = buildMoLookupParams(moNumber);
  const url = getOperationUrl('GetDynamicData').replace(MO_API_HOST, MO_API_IP);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Host': MO_API_HOST,
    },
    body: new URLSearchParams(params)
  });

  const xmlText = await response.text();
  if (!response.ok) {
    throw new Error(`MO API request failed (HTTP ${response.status}): ${xmlText.slice(0, 300)}`);
  }

  return { params, xml: xmlText };
}

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function readTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXmlEntities(m[1].trim()) : '';
}

// Parses the flat <Table><MO/><UPN/><CPN/><DESCRIPTION/><QUANTITY/></Table>
// rows out of the GETMOITEM diffgram (schema confirmed 2026-07-25 from live
// L10/L11 samples). The service returns each component as two byte-identical
// rows — an upstream duplication, not something this app introduces — so
// rows are collapsed here to one per distinct (UPN, CPN, Description,
// Quantity), keeping an `occurrences` count rather than silently dropping
// the duplicate so nothing in the raw response is hidden.
function parseMoItems(xml) {
  const blocks = xml.match(/<Table\b[^>]*>[\s\S]*?<\/Table>/g) || [];
  const rows = blocks.map(block => ({
    mo: readTag(block, 'MO'),
    upn: readTag(block, 'UPN'),
    cpn: readTag(block, 'CPN'),
    description: readTag(block, 'DESCRIPTION'),
    quantity: parseFloat(readTag(block, 'QUANTITY')) || 0,
  }));

  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.upn}|${row.cpn}|${row.description}|${row.quantity}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrences += 1;
    } else {
      byKey.set(key, { ...row, occurrences: 1 });
    }
  }

  return {
    upn: rows[0]?.upn || null,
    rawRowCount: rows.length,
    rows: [...byKey.values()],
  };
}

module.exports = { buildMoLookupParams, fetchMoItem, getOperationUrl, parseMoItems };
