// Runs in a calendar.google.com tab. Calls the Calendar API the way the Calendar web app does:
// with the tab's session (SAPISIDHASH) and the API key that the page embeds. Read-only.
// Returns {ready:false} while the page loads and {error} on failure, so only loading is retried.
export async function calendarPageOperation({ action, expectedAccount, calendarId = 'primary', timeMin, timeMax, query, limit = 50, eventId }) {
  if (!['calendar_list', 'calendar_events', 'calendar_event'].includes(action)) return { error: 'Action not allowed' };
  const authuser = location.pathname.match(/^\/calendar\/u\/(\d+)\//)?.[1];
  const cookies = Object.fromEntries(document.cookie.split('; ').map(c => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
  const sapisid = cookies.SAPISID || cookies['__Secure-3PAPISID'];
  const keys = [...new Set(document.documentElement.innerHTML.match(/AIza[0-9A-Za-z_-]{35}/g) || [])];
  if (!authuser || !sapisid || !keys.length) return { ready: false };
  const ts = Math.floor(Date.now() / 1000);
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ts + ' ' + sapisid + ' ' + location.origin));
  const headers = { Authorization: 'SAPISIDHASH ' + ts + '_' + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join(''), 'X-Goog-AuthUser': authuser };
  // The page embeds several keys and only some allow Calendar methods; try each.
  const get = async (path, params = {}) => {
    let message;
    for (const key of keys) {
      const response = await fetch('https://clients6.google.com/calendar/v3/' + path + '?' + new URLSearchParams({ ...params, key }), { credentials: 'include', headers });
      const body = await response.json().catch(() => ({}));
      if (response.ok) return body;
      message = body.error?.message || 'HTTP ' + response.status;
      if (response.status !== 400 && response.status !== 403) break;
    }
    throw new Error('Calendar API: ' + message);
  };
  try {
    const me = await get('calendars/primary');
    if (String(me.id).toLowerCase() !== expectedAccount) return { error: 'Calendar account identity missing or mismatched' };
    const account = expectedAccount;
    if (action === 'calendar_list') {
      const list = await get('users/me/calendarList', { maxResults: '250' });
      return { account, calendars: (list.items || []).map(c => ({ id: c.id, name: c.summaryOverride || c.summary, primary: c.primary || false, accessRole: c.accessRole, timeZone: c.timeZone })) };
    }
    const path = 'calendars/' + encodeURIComponent(calendarId) + '/events';
    const self = e => e.attendees?.find(a => a.self)?.responseStatus;
    const summary = e => ({ id: e.id, summary: e.summary, start: e.start, end: e.end, status: e.status, location: e.location,
      organizer: e.organizer?.email, myResponse: self(e), attendeeCount: e.attendees?.length || 0, meetLink: e.hangoutLink, recurringEventId: e.recurringEventId });
    if (action === 'calendar_events') {
      const params = { singleEvents: 'true', orderBy: 'startTime', timeMin, timeMax, maxResults: String(limit) };
      if (query) params.q = query;
      const list = await get(path, params);
      return { account, calendarId, timeZone: list.timeZone, events: (list.items || []).map(summary), more: Boolean(list.nextPageToken) };
    }
    const e = await get(path + '/' + encodeURIComponent(eventId));
    return { account, calendarId, event: { ...summary(e), description: e.description?.slice(0, 20000), link: e.htmlLink,
      attendees: e.attendees?.map(a => ({ email: a.email, name: a.displayName, response: a.responseStatus, optional: a.optional || undefined, self: a.self || undefined })),
      conference: e.conferenceData?.entryPoints?.map(p => ({ type: p.entryPointType, uri: p.uri })), attachments: e.attachments?.map(a => ({ title: a.title, url: a.fileUrl })) } };
  } catch (error) {
    return { error: error.message };
  }
}
