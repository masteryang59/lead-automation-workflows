// n8n Code node "Format Slack alert" (mode: Run Once for Each Item).
// Builds a Block Kit message for #sales-hot from the scored lead and the CRM record.
// Source of truth for the jsCode in lead-capture.workflow.json (npm run sync:n8n).

const { lead, enrichment, score, tier, reasons } = $('Score lead').item.json;
const crm = $('Upsert CRM contact').item.json;

// Slack mrkdwn treats &, < and > as control characters.
const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const company = enrichment?.name || lead.company || lead.companyDomain || 'Unknown company';
const companyLine = enrichment
  ? `${esc(enrichment.industry)} · ${esc(enrichment.employeesRange)} employees · ${esc(enrichment.city)}, ${esc(enrichment.country)}`
  : 'Not enriched';
const message = lead.message.length > 280 ? `${lead.message.slice(0, 279)}…` : lead.message;
// A returning lead may leave the phone blank; the CRM still has the old one.
const phone = lead.phone || crm.contact?.phone || '';
const repeat = crm.created === false ? ` · returning lead (${crm.contact?.submissions ?? '?'} submissions)` : '';

return {
  json: {
    text: `Hot lead: ${lead.fullName} at ${company} (score ${score})`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `🔥 Hot lead: ${lead.fullName}`.slice(0, 150), emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Company*\n${esc(company)}` },
          { type: 'mrkdwn', text: `*Score*\n${score} (${tier})` },
          { type: 'mrkdwn', text: `*Email*\n<mailto:${esc(lead.email)}|${esc(lead.email)}>` },
          { type: 'mrkdwn', text: `*Phone*\n${esc(phone) || '—'}` },
          { type: 'mrkdwn', text: `*Firmographics*\n${companyLine}` },
          { type: 'mrkdwn', text: `*Source*\n${esc(lead.source)}${lead.utm.campaign ? ` / ${esc(lead.utm.campaign)}` : ''}` },
        ],
      },
      ...(message ? [{ type: 'section', text: { type: 'mrkdwn', text: `>${esc(message)}` } }] : []),
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${esc(reasons.join(' · '))} · CRM ${esc(crm.id)}${repeat}` }],
      },
    ],
  },
};

function normalizeText(data) {
  if (!data) return null;
  return data;
}

function auditAction(data) {
  if (!data) return null;
  return data;
}

function destroySession(data) {
  if (!data) return null;
  return data;
}

function normalizeText(data) {
  if (!data) return null;
  return data;
}

function maskPii(data) {
  if (!data) return null;
  return data;
}

function reportError(data) {
  if (!data) return null;
  return data;
}

function checkHealth(data) {
  if (!data) return null;
  return data;
}