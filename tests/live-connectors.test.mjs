// Live HubSpot and Slack against fake servers (no network): records get linked, DMs come to you.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HUBSPOT_TOKEN = 'test';
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_DM_USER_ID = 'UME';

const calls = [];
let nextId = 1000;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, body });
  const json = (x) => new Response(JSON.stringify(x));
  if (u.hostname === 'slack.com') return json({ ok: true, channel: body.channel, ts: '1.1' });
  if (u.pathname === '/crm/v3/properties/deals' && init.method === 'GET') return json({ results: [{ name: 'dealname' }] });
  if (u.pathname.endsWith('/search')) return json({ results: [] });
  return json({ id: String(nextId++) });
};

const { db } = await import('../src/store.js');
const { syncToHubspot } = await import('../src/hubspot-sync.js');
const slack = await import('../src/connectors/slack.js');

test('HubSpot: demo records are created and linked with real IDs', async () => {
  const before = db.accounts.find((a) => a.id === 'harborline').deal.id;
  const r = await syncToHubspot();
  assert.equal(r.accounts, db.accounts.length);
  assert.ok(r.fieldsCreated > 5, 'custom Reeco deal fields are created');
  const a = db.accounts.find((x) => x.id === 'harborline');
  assert.notEqual(a.deal.id, before);
  const deal = calls.find((c) => c.path === '/crm/v3/objects/deals' && c.body.properties.dealname === a.deal.name);
  assert.equal(deal.body.properties.dealstage, 'contractsent');
  assert.equal(deal.body.associations.length, 2); // company + contact
});

test('HubSpot: a second sync re-uses the links (no duplicates)', async () => {
  const n = calls.length;
  await syncToHubspot();
  const creates = calls.slice(n).filter((c) => c.method === 'POST' && /objects\/(companies|contacts|deals)$/.test(c.path));
  assert.equal(creates.length, 0);
});

test('Slack: every DM comes to SLACK_DM_USER_ID, labelled with who it was for', async () => {
  await slack.dm('U04DANAS', 'Dana S.', 'Usage anomaly at Meridian', [slack.section('x')]);
  const msg = calls.filter((c) => c.path === '/api/chat.postMessage').at(-1).body;
  assert.equal(msg.channel, 'UME');
  assert.match(msg.text, /^For Dana S\.:/);
  assert.match(JSON.stringify(msg.blocks[0]), /For \*Dana S\.\*/);
});
