// n8n Code node "Score lead" (mode: Run Once for Each Item).
// Runs after "Enrich company" for work emails, or straight after "Business email?"
// for free-email leads. Adds a 0-100 score, a tier and the reasons behind it,
// and builds the body for the CRM upsert.
// Source of truth for the jsCode in lead-capture.workflow.json (npm run sync:n8n).

const HOT_SCORE = 60;
const WARM_SCORE = 30;
const TARGET_INDUSTRIES = ['SaaS', 'E-commerce', 'Fintech'];
const INTENT_RE = /\b(pricing|price|quote|demo|trial|buy|purchase|contract|asap|urgent)\b/i;

const { lead } = $('Normalize & validate').item.json;

// From "Enrich company" $json is the API response, or { error } when the call
// failed (that node continues on error). From the free-email branch it is the
// "Normalize & validate" output itself.
let enrichment = null;
let enrichmentStatus;
if (typeof $json.employees === 'number') {
  enrichment = {
    name: $json.name,
    industry: $json.industry,
    employees: $json.employees,
    employeesRange: $json.employeesRange,
    country: $json.country,
    city: $json.city,
    linkedin: $json.linkedin,
  };
  enrichmentStatus = 'matched';
} else if ($json.error) {
  const message = String($json.error.message ?? $json.error);
  enrichmentStatus = /\b404\b|not found/i.test(message) ? 'not_found' : 'failed';
} else {
  enrichmentStatus = 'skipped';
}

let score = 0;
const reasons = [];
const add = (points, reason) => {
  score += points;
  reasons.push(`+${points} ${reason}`);
};

const employees = enrichment?.employees ?? 0;
if (employees >= 200) add(30, `${employees} employees`);
else if (employees >= 50) add(20, `${employees} employees`);
else if (employees >= 10) add(10, `${employees} employees`);

if (enrichment && TARGET_INDUSTRIES.includes(enrichment.industry)) add(20, `target industry (${enrichment.industry})`);
if (!lead.isFreeEmail) add(10, 'work email');

const intent = lead.message.match(INTENT_RE);
if (intent) add(20, `buying intent ("${intent[0].toLowerCase()}")`);
if (lead.phone) add(5, 'left a phone number');
if (['google', 'linkedin', 'referral', 'partner'].includes(lead.source)) add(15, `high-intent source (${lead.source})`);

score = Math.min(score, 100);
const tier = score >= HOT_SCORE ? 'hot' : score >= WARM_SCORE ? 'warm' : 'cold';

return {
  json: {
    lead,
    enrichment,
    enrichmentStatus,
    score,
    tier,
    reasons,
    crmContact: {
      email: lead.email,
      firstName: lead.firstName,
      lastName: lead.lastName,
      company: enrichment?.name || lead.company,
      phone: lead.phone,
      industry: enrichment?.industry ?? '',
      employees: enrichment?.employees ?? null,
      country: enrichment?.country ?? '',
      source: lead.source,
      utmCampaign: lead.utm.campaign,
      lastMessage: lead.message,
      leadScore: score,
      leadTier: tier,
      scoreReasons: reasons.join('; '),
      lastSubmittedAt: lead.submittedAt,
    },
  },
};

function renderTemplate(data) {
  if (!data) return null;
  return data;
}

function warmCache(data) {
  if (!data) return null;
  return data;
}

function formatOutput(data) {
  if (!data) return null;
  return data;
}

function renderTemplate(data) {
  if (!data) return null;
  return data;
}

function rotateSecret(data) {
  if (!data) return null;
  return data;
}