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
  // One deadline for the whole operation, so a stalled request cannot hold the extension.
  const signal = AbortSignal.timeout(40000);
  // The page embeds several keys and only some allow Calendar methods; try each.
  const get = async (path, params = {}) => {
    let message;
    for (const key of keys) {
      const response = await fetch('https://clients6.google.com/calendar/v3/' + path + '?' + new URLSearchParams({ ...params, key }), { credentials: 'include', headers, signal });
      if (response.ok) return response.json();
      const body = await response.json().catch(() => ({}));
      message = body.error?.message || 'HTTP ' + response.status;
      if (response.status !== 400 && response.status !== 403) break;
    }
    throw new Error('Calendar API: ' + message);
  };
  // Google may return short or empty pages before the last one; follow pageToken up to the limit.
  const getAll = async (path, params, limit) => {
    const items = [];
    let page = {};
    for (let i = 0; i < 20 && (i === 0 || page.nextPageToken) && items.length < limit; i++) {
      page = await get(path, { ...params, maxResults: String(Math.min(250, limit - items.length)), ...(page.nextPageToken ? { pageToken: page.nextPageToken } : {}) });
      items.push(...(page.items || []));
    }
    return { timeZone: page.timeZone, items, more: Boolean(page.nextPageToken) };
  };
  try {
    const me = await get('calendars/primary');
    if (String(me.id).toLowerCase() !== expectedAccount) return { error: 'Calendar account identity missing or mismatched' };
    const account = expectedAccount;
    if (action === 'calendar_list') {
      const list = await getAll('users/me/calendarList', {}, 1000);
      return { account, more: list.more, calendars: list.items.map(c => ({ id: c.id, name: c.summaryOverride || c.summary, primary: c.primary || false, accessRole: c.accessRole, timeZone: c.timeZone })) };
    }
    const path = 'calendars/' + encodeURIComponent(calendarId) + '/events';
    const self = e => e.attendees?.find(a => a.self)?.responseStatus;
    const summary = e => ({ id: e.id, summary: e.summary, start: e.start, end: e.end, status: e.status, location: e.location,
      organizer: e.organizer?.email, myResponse: self(e), attendeeCount: e.attendees?.length || 0, meetLink: e.hangoutLink, recurringEventId: e.recurringEventId });
    if (action === 'calendar_events') {
      const params = { singleEvents: 'true', orderBy: 'startTime', timeMin, timeMax };
      if (query) params.q = query;
      const list = await getAll(path, params, limit);
      return { account, calendarId, timeZone: list.timeZone, events: list.items.map(summary), more: list.more };
    }
    const e = await get(path + '/' + encodeURIComponent(eventId));
    return { account, calendarId, event: { ...summary(e), description: e.description?.slice(0, 20000), link: e.htmlLink,
      attendees: e.attendees?.map(a => ({ email: a.email, name: a.displayName, response: a.responseStatus, optional: a.optional || undefined, self: a.self || undefined })),
      conference: e.conferenceData?.entryPoints?.map(p => ({ type: p.entryPointType, uri: p.uri })), attachments: e.attachments?.map(a => ({ title: a.title, url: a.fileUrl })) } };
  } catch (error) {
    return { error: error.message };
  }
}
