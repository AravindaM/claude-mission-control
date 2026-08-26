async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
  return res.json();
}

export const fetchState = () => req('GET', '/api/state');
export const fetchBrief = (id) => req('GET', `/api/tasks/${id}/brief`);
export const fetchSessions = (id) => req('GET', `/api/tasks/${id}/sessions`);
// Routine brief saves are hidden unless `all` — see the endpoint's comment.
export const fetchEvents = (id, limit = 30, all = false) =>
  req('GET', `/api/tasks/${id}/events?limit=${limit}${all ? '&all=1' : ''}`);
export const createTask = (payload) => req('POST', '/api/tasks', payload);
export const patchTask = (id, patch) => req('PATCH', `/api/tasks/${id}`, patch);
export const trashTask = (id) => req('DELETE', `/api/tasks/${id}`);
export const restoreTrash = (id) => req('POST', `/api/tasks/${id}/restore-trash`, {});
export const bindSession = (uuid, payload) => req('POST', `/api/sessions/${uuid}/bind`, payload);
// `about: true` also rewrites the stable sections; the default refresh only
// rewrites Status, which is the cheap path.
export const refreshBrief = (id, { about = false } = {}) =>
  req('POST', `/api/tasks/${id}/refresh-brief`, { about });
