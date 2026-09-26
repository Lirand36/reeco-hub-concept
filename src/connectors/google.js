// Google Calendar + Meet. Docs: https://developers.google.com/calendar/api/v3/reference/events/insert
//
// Live mode connects one Google account (a personal Gmail works) with OAuth: an admin clicks
// "Connect Google" on the Connections page, approves, and the hub keeps a refresh token
// (GOOGLE_REFRESH_TOKEN, so it survives restarts). Meetings are created on that calendar.
// Without it, everything runs in mock mode like the other systems.
//
// EMAIL SAFETY (live mode): Google only ever emails GOOGLE_INVITE_EMAIL. Every other attendee
// (customers, team) is left out of the invite and listed in its description instead. If
// GOOGLE_INVITE_EMAIL is not set, no invite emails are sent at all. `assertSafe` re-checks the
// final request right before it leaves, and blocks it if any other address slipped in.

import { randomUUID } from 'node:crypto';
import { send } from './http.js';

const clientId = () => process.env.GOOGLE_CLIENT_ID;
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET;
let refreshToken = process.env.GOOGLE_REFRESH_TOKEN || null; // also set at runtime by "Connect Google"
let connectedEmail = null;
let access = null; // { token, exp }

export const isConfigured = () => Boolean(clientId() && clientSecret());
export const isLive = () => Boolean(isConfigured() && refreshToken);
export const connectedAs = () => connectedEmail;
export const inviteEmail = () => (process.env.GOOGLE_INVITE_EMAIL || '').trim().toLowerCase() || null;
const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/userinfo.email', 'openid'];

// ---------------------------------------------------------------- OAuth ("Connect Google")

export function authUrl(redirectUri, state) {
  const q = new URLSearchParams({ client_id: clientId(), redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function exchangeCode(code, redirectUri) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId(), client_secret: clientSecret(), redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) throw new Error(data.error_description || data.error || 'Google did not return a refresh token');
  refreshToken = data.refresh_token;
  access = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  await whoAmI();
  return refreshToken;
}

async function accessToken() {
  if (access && access.exp > Date.now() + 60_000) return access.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId(), client_secret: clientSecret(), grant_type: 'refresh_token' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${data.error_description ?? data.error}`);
  access = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return access.token;
}
const auth = async () => (isLive() ? { Authorization: `Bearer ${await accessToken()}` } : {});

export async function whoAmI() {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${await accessToken()}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || `Google answered ${res.status}`);
  connectedEmail = data.email;
  return data.email;
}

// ---------------------------------------------------------------- email safety

// Who Google may email in live mode: only GOOGLE_INVITE_EMAIL. Everyone else is described, not invited.
export function safeInvite(attendees) {
  if (!isLive()) return { attendees, sendUpdates: 'all', note: '' };
  const mine = inviteEmail();
  const intended = attendees.map((a) => `${a.name}${a.email ? ` <${a.email}>` : ''}`).join(', ');
  return {
    attendees: mine ? [{ email: mine, displayName: 'Demo inbox' }] : [],
    sendUpdates: mine ? 'all' : 'none',
    note: `\n\n— Demo mode: this invite would go to ${intended}. For safety it was sent only to ${mine ?? 'nobody (no GOOGLE_INVITE_EMAIL set)'}.`,
  };
}

// Last check before anything leaves: in live mode, the only address allowed in a request is ours.
export function assertSafe(body, sendUpdates) {
  if (!isLive()) return;
  const mine = inviteEmail();
  const emails = (body.attendees ?? []).map((a) => String(a.email).trim().toLowerCase());
  const bad = emails.filter((e) => e !== mine);
  if (bad.length || (sendUpdates !== 'none' && !mine)) {
    throw new Error(`Blocked: this invite would have emailed ${bad.join(', ') || 'someone'}; in demo mode only GOOGLE_INVITE_EMAIL may be emailed.`);
  }
}

// ---------------------------------------------------------------- Calendar

// Mock Meet codes look like the real ones: abc-defg-hij
const meetCode = () => {
  const l = () => String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return `${l()}${l()}${l()}-${l()}${l()}${l()}${l()}-${l()}${l()}${l()}`;
};

async function insertEvent({ summary, description, start, end, attendees, sendUpdates, action, summaryText }) {
  const body = {
    summary, description,
    start: { dateTime: start }, end: { dateTime: end },
    attendees: attendees.map((a) => ({ email: a.email, ...(a.displayName || a.name ? { displayName: a.displayName ?? a.name } : {}) })),
    conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    reminders: { useDefault: true },
  };
  assertSafe(body, sendUpdates);
  const code = meetCode();
  return send({
    system: 'google', action, summary: summaryText,
    method: 'POST',
    url: `https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=${sendUpdates}`,
    headers: await auth(), body,
    live: isLive(),
    mockResponse: () => ({ id: randomUUID().replace(/-/g, '').slice(0, 26), status: 'confirmed', htmlLink: 'https://calendar.google.com/calendar/event?eid=mock', hangoutLink: `https://meet.google.com/${code}`, summary, start: { dateTime: start }, end: { dateTime: end } }),
  });
}

// A Calendar event with a Google Meet link. In mock mode the invite "goes" to everyone; live, see safeInvite.
export function createEvent({ summary, description, start, end, attendees }) {
  const inv = safeInvite(attendees);
  const who = isLive() ? (inv.attendees.length ? 'your demo inbox' : 'nobody (no invite email set)') : `${attendees.length} ${attendees.length === 1 ? 'person' : 'people'}`;
  return insertEvent({
    summary, description: `${description}${inv.note}`, start, end, attendees: inv.attendees, sendUpdates: inv.sendUpdates,
    action: 'Create calendar event', summaryText: `Booked “${summary}” with a Google Meet link and emailed the invite to ${who}`,
  });
}

// A Meet link for "let's jump on a call right now": a 30-minute event on our calendar, no invitees, no emails.
export async function createSpace() {
  const start = new Date();
  const entry = await insertEvent({
    summary: 'Quick call', description: 'Created from Reeco Hub for a quick call.', start: start.toISOString(), end: new Date(+start + 30 * 60_000).toISOString(),
    attendees: [], sendUpdates: 'none', action: 'Create Meet room', summaryText: 'Created a Google Meet room for a quick call',
  });
  if (entry.ok) entry.response = { ...entry.response, meetingUri: entry.response.hangoutLink, meetingCode: entry.response.hangoutLink?.split('/').pop() };
  return entry;
}
