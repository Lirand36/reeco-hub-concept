// Demo safety: with Google connected, the hub may only ever ask Google to email GOOGLE_INVITE_EMAIL.
// Run with `npm test`. Uses a fake Google (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function liveGoogle(inviteEmail) {
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_REFRESH_TOKEN: 'test' });
  if (inviteEmail) process.env.GOOGLE_INVITE_EMAIL = inviteEmail; else delete process.env.GOOGLE_INVITE_EMAIL;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'x', expires_in: 3600 }));
    requests.push({ url: new URL(String(url)), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'e1', hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc' }));
  };
  const google = await import(`../src/connectors/google.js?${Math.random()}`);
  return { google, requests };
}
const people = [
  { name: 'Laura Chen', email: 'laura.chen@harborlinehotels.com.invalid' },
  { name: 'Maya K.', email: 'maya.k@reeco.com.invalid' },
];
const event = { summary: 'Demo', description: 'x', start: new Date().toISOString(), end: new Date(Date.now() + 1800000).toISOString(), attendees: people };

test('invites go only to GOOGLE_INVITE_EMAIL', async () => {
  const { google, requests } = await liveGoogle('me@demo-inbox.invalid');
  await google.createEvent(event);
  assert.deepEqual(requests[0].body.attendees.map((a) => a.email), ['me@demo-inbox.invalid']);
  assert.match(requests[0].body.description, /Laura Chen/); // intended people are listed, not emailed
});

test('without GOOGLE_INVITE_EMAIL nobody is emailed', async () => {
  const { google, requests } = await liveGoogle(null);
  await google.createEvent(event);
  assert.deepEqual(requests[0].body.attendees, []);
  assert.equal(requests[0].url.searchParams.get('sendUpdates'), 'none');
});

test('instant calls email nobody', async () => {
  const { google, requests } = await liveGoogle('me@demo-inbox.invalid');
  await google.createSpace();
  assert.deepEqual(requests[0].body.attendees, []);
  assert.equal(requests[0].url.searchParams.get('sendUpdates'), 'none');
});

test('any other address is blocked before sending', async () => {
  const { google } = await liveGoogle('me@demo-inbox.invalid');
  assert.throws(() => google.assertSafe({ attendees: [{ email: 'stranger@example.com.invalid' }] }, 'all'), /Blocked/);
});
