// Live HubSpot: the demo accounts need real records in your (test) HubSpot account.
// On startup (and after "Reset demo data") this finds each company, contact and deal by domain,
// email and deal name, creates whatever is missing, and swaps the demo's made-up IDs for real ones.
// It also creates the custom deal fields the stage gates write to (reeco_pain, reeco_demo_date…).

import * as hubspot from './connectors/hubspot.js';
import { STAGE_GATES, db } from './store.js';
import { announce, withActivity } from './activity.js';

const cache = new Map(); // domain → { companyId, dealId } so a reset doesn't re-search everything

// Custom deal fields used by the hub (standard ones like closedate, closed_lost_reason already exist)
function neededProperties() {
  const fields = Object.values(STAGE_GATES).flatMap((g) => g.fields).filter((f) => f.hs.startsWith('reeco_'));
  const typeOf = (f) => (f.type === 'number' ? ['number', 'number'] : f.type === 'datetime-local' ? ['datetime', 'date'] : f.type === 'textarea' ? ['string', 'textarea'] : ['string', 'text']);
  return [
    ...fields.map((f) => ({ name: f.hs, label: `Reeco: ${f.label}`, type: typeOf(f)[0], fieldType: typeOf(f)[1], groupName: 'dealinformation' })),
    { name: 'discount_pct', label: 'Reeco: Discount %', type: 'number', fieldType: 'number', groupName: 'dealinformation' },
  ];
}

async function ensureProperties() {
  const list = await hubspot.listDealProperties();
  if (!list.ok) throw new Error(`HubSpot: ${list.response?.message ?? list.status}`);
  const have = new Set((list.response.results ?? []).map((p) => p.name));
  let created = 0;
  for (const p of neededProperties().filter((x) => !have.has(x.name))) {
    const r = await hubspot.createDealProperty(p);
    if (!r.ok) throw new Error(`HubSpot: couldn't create the deal field ${p.name} (${r.response?.message ?? r.status})`);
    created++;
  }
  return created;
}

const idOf = (r) => r.ok && r.response?.results?.[0]?.id;
async function findOrCreate(object, key, value, properties, associations) {
  const found = await hubspot.search(object, key, value);
  if (!found.ok) throw new Error(`HubSpot: ${found.response?.message ?? found.status}`);
  if (idOf(found)) return { id: idOf(found), created: false };
  const made = await hubspot.create(object, properties, associations);
  if (!made.ok) throw new Error(`HubSpot: couldn't create ${value} (${made.response?.message ?? made.status})`);
  return { id: made.response.id, created: true };
}
const assoc = (id, typeId) => ({ to: { id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }] });

export async function syncToHubspot(actor = 'Setup') {
  if (!hubspot.isLive()) return null;
  return withActivity(actor, async () => {
    const fieldsCreated = await ensureProperties();
    let made = 0;
    for (const a of db.accounts) {
      const hit = cache.get(a.domain);
      if (hit) { a.hubspotCompanyId = hit.companyId; a.deal.id = hit.dealId; continue; }
      const company = await findOrCreate('companies', 'domain', a.domain, { name: a.name, domain: a.domain });
      const [first, ...rest] = a.contact.name.split(' ');
      const contact = await findOrCreate('contacts', 'email', a.contact.email,
        { email: a.contact.email, firstname: first, lastname: rest.join(' '), jobtitle: a.contact.role }, [assoc(company.id, 279)]);
      const deal = await findOrCreate('deals', 'dealname', a.deal.name, {
        dealname: a.deal.name, amount: String(a.deal.amount), pipeline: 'default', dealstage: a.deal.stage,
        ...(a.deal.closeDate ? { closedate: a.deal.closeDate } : {}),
      }, [assoc(company.id, 341), assoc(contact.id, 3)]);
      made += company.created + contact.created + deal.created;
      a.hubspotCompanyId = company.id;
      a.deal.id = deal.id;
      cache.set(a.domain, { companyId: company.id, dealId: deal.id });
    }
    announce(`HubSpot is connected: ${db.accounts.length} demo accounts are linked${made ? ` (${made} records created)` : ''}${fieldsCreated ? `, and ${fieldsCreated} Reeco deal fields were added` : ''}.`, { icon: 'i-done', tone: 'good' });
    return { accounts: db.accounts.length, created: made, fieldsCreated };
  }, 'system');
}
