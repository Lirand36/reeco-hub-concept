// Google Calendar + Meet. Docs: https://developers.google.com/calendar/api/v3/reference/events/insert
// and https://developers.google.com/meet/api/reference/rest/v2/spaces/create
//
// Meetings are created on the calendar of the person who books them. In production that uses a
// Google Workspace service account with domain-wide delegation (it acts as that user), set via
// GOOGLE_SERVICE_ACCOUNT_JSON. Without it, everything runs in mock mode like the other systems.

import { createSign, randomUUID } from 'node:crypto';
import { send } from './http.js';

const serviceAccount = () => {
  try { return process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : null; } catch { return null; }
};
export const isLive = () => Boolean(serviceAccount());

const b64url = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
const tokens = new Map(); // `${user}|${scope}` → { token, exp }

// OAuth2 service-account flow: a signed JWT with `sub` = the booking user, exchanged for an access token.
async function accessToken(userEmail, scope) {
  const key = `${userEmail}|${scope}`;
  const cached = tokens.get(key);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iss: sa.client_email, sub: userEmail, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${data.error_description ?? data.error}`);
  tokens.set(key, { token: data.access_token, exp: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}
const auth = async (userEmail, scope) => (isLive() ? { Authorization: `Bearer ${await accessToken(userEmail, scope)}` } : {});

// Mock Meet codes look like the real ones: abc-defg-hij
const meetCode = () => {
  const l = () => String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return `${l()}${l()}${l()}-${l()}${l()}${l()}${l()}-${l()}${l()}${l()}`;
};

// A Calendar event with a Google Meet link; Google emails the invite to every attendee.
export async function createEvent({ organizer, summary, description, start, end, attendees }) {
  const code = meetCode();
  return send({
    system: 'google',
    action: 'Create calendar event',
    summary: `Booked “${summary}” with a Google Meet link and emailed the invite to ${attendees.length} ${attendees.length === 1 ? 'person' : 'people'}`,
    method: 'POST',
    url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all',
    headers: await auth(organizer, 'https://www.googleapis.com/auth/calendar.events'),
    body: {
      summary, description,
      start: { dateTime: start }, end: { dateTime: end },
      attendees: attendees.map((a) => ({ email: a.email, displayName: a.name })),
      conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      reminders: { useDefault: true },
    },
    live: isLive(),
    mockResponse: () => ({
      id: randomUUID().replace(/-/g, '').slice(0, 26), status: 'confirmed',
      htmlLink: 'https://calendar.google.com/calendar/event?eid=mock', hangoutLink: `https://meet.google.com/${code}`,
      organizer: { email: organizer, self: true }, summary, start: { dateTime: start }, end: { dateTime: end },
    }),
  });
}

// An instant Meet room (no calendar event), for "let's jump on a call right now".
export async function createSpace(organizer) {
  const code = meetCode();
  return send({
    system: 'google',
    action: 'Create Meet room',
    summary: 'Created a Google Meet room for a quick call',
    method: 'POST',
    url: 'https://meet.googleapis.com/v2/spaces',
    headers: await auth(organizer, 'https://www.googleapis.com/auth/meetings.space.created'),
    body: { config: { accessType: 'TRUSTED' } },
    live: isLive(),
    mockResponse: () => ({ name: `spaces/${code.replace(/-/g, '')}`, meetingUri: `https://meet.google.com/${code}`, meetingCode: code }),
  });
}
