// api.js — طبقة الاتصال بالسيرفر. بتشارك نفس جلسة الـ ERP (arToken) فمفيش تسجيل دخول مرتين.
const TOKEN_KEY = 'arToken', USER_KEY = 'arUser';

export const auth = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  get user() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } },
  set(user, token) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); },
  clear() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); },
};

export class ApiError extends Error {
  constructor(message, code, status, data) { super(message); this.code = code; this.status = status; this.data = data || {}; }
}
const NETWORK_MSG = 'النت واقف أو ضعيف. مفيش حاجة ضاعت — جرّب تاني.';

async function request(method, path, body, timeout = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch('/api' + path, {
      method, signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(auth.token ? { Authorization: 'Bearer ' + auth.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(NETWORK_MSG, 'NETWORK', 0);
  } finally { clearTimeout(timer); }
  let data = {};
  try { data = await res.json(); } catch { /* مش JSON */ }
  if (res.status === 401 && path !== '/auth/login') {
    window.dispatchEvent(new CustomEvent('auth-expired'));
    throw new ApiError('الجلسة خلصت — ادخل تاني.', 'AUTH', 401);
  }
  if (!res.ok) {
    const code = data.code || (res.status === 503 ? 'NETWORK' : 'ERROR');
    throw new ApiError(data.error || 'حصلت مشكلة. جرّب تاني.', code, res.status, data);
  }
  return data;
}

export const api = {
  login: (username, password) => request('POST', '/auth/login', { username, password }),
  me: () => request('GET', '/game/me'),
  team: () => request('GET', '/game/team'),
  categories: () => request('GET', '/game/categories'),
  next: mode => request('POST', '/game/tasks/next', { mode }),
  answer: (id, payload) => request('POST', `/game/tasks/${id}/answer`, payload),
  skip: (id, request_id) => request('POST', `/game/tasks/${id}/skip`, { request_id }),
  heartbeat: id => request('POST', `/game/tasks/${id}/heartbeat`, {}),
  release: id => request('POST', `/game/tasks/${id}/release`, {}).catch(() => {}),
  invLocations: () => request('GET', '/game/inventory/locations'),
  invStart: location_id => request('POST', '/game/inventory/start', { location_id }),
  invNext: session_id => request('POST', '/game/inventory/next', { session_id }),
  invAnswer: (id, payload) => request('POST', `/game/inventory/tasks/${id}/answer`, payload),
  admin: () => request('GET', '/game/admin/stats'),

  // رفع الصورة بـ XHR عشان نعرض نسبة التقدّم
  upload(id, blob, requestId, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/game/tasks/${id}/image`);
      xhr.timeout = 60000;
      if (auth.token) xhr.setRequestHeader('Authorization', 'Bearer ' + auth.token);
      xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* */ }
        if (xhr.status === 401) { window.dispatchEvent(new CustomEvent('auth-expired')); return reject(new ApiError('الجلسة خلصت — ادخل تاني.', 'AUTH', 401)); }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        reject(new ApiError(data.error || 'الرفع فشل. جرّب تاني.', data.code || 'ERROR', xhr.status, data));
      };
      xhr.onerror = xhr.ontimeout = () => reject(new ApiError(NETWORK_MSG, 'NETWORK', 0));
      const fd = new FormData();
      fd.append('request_id', requestId);
      fd.append('image', blob, 'photo.jpg');
      xhr.send(fd);
    });
  },
};
