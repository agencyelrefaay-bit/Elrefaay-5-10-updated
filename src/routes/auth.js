// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { get, run } = require('../db/database');
const { generateToken, authenticate } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { asyncHandler } = require('../utils/asyncHandler');
const multer = require('multer');
const { randomUUID } = require('crypto');

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('الصورة يجب أن تكون JPG أو PNG أو WEBP'));
  },
});

function getStorageConfig() {
  let url = process.env.SUPABASE_URL;
  if (!url && process.env.DATABASE_URL) {
    try {
      const host = new URL(process.env.DATABASE_URL).hostname;
      const match = host.match(/^db\.([^.]+)\.supabase\.co$/);
      if (match) url = 'https://' + match[1] + '.supabase.co';
    } catch (_) {}
  }
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  const key = secretKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    url = parsed.origin;
  } catch (_) { return null; }
  return { url, key, isModernSecret: Boolean(secretKey) };
}

function storageAuthHeaders(config, extra = {}) {
  const headers = { apikey: config.key, ...extra };
  if (!config.isModernSecret) headers.Authorization = 'Bearer ' + config.key;
  return headers;
}

async function uploadAvatarToStorage(userId, file) {
  const config = getStorageConfig();
  if (!config) throw Object.assign(new Error('إعداد Supabase Storage غير مكتمل على السيرفر'), { status: 503 });
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.mimetype];
  const objectPath = String(userId) + '/' + randomUUID() + '.' + ext;
  const response = await fetch(config.url + '/storage/v1/object/user-avatars/' + objectPath, {
    method: 'POST',
    headers: storageAuthHeaders(config, { 'Content-Type': file.mimetype, 'x-upsert': 'false' }),
    body: file.buffer,
  });
  if (!response.ok) {
    const status = response.status === 404 ? 503 : 502;
    throw Object.assign(new Error(response.status === 404 ? 'أنشئ bucket باسم user-avatars في Supabase Storage أولاً' : 'تعذر رفع الصورة إلى التخزين السحابي'), { status });
  }
  const publicPath = objectPath.split('/').map(encodeURIComponent).join('/');
  return { url: config.url + '/storage/v1/object/public/user-avatars/' + publicPath, objectPath, config };
}

async function deleteAvatarFromStorage(config, avatarUrl) {
  if (!config || !avatarUrl) return;
  try {
    const parsed = new URL(avatarUrl);
    const prefix = '/storage/v1/object/public/user-avatars/';
    if (parsed.origin !== new URL(config.url).origin || !parsed.pathname.startsWith(prefix)) return;
    const objectPath = parsed.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
    await fetch(config.url + '/storage/v1/object/user-avatars', {
      method: 'DELETE',
      headers: storageAuthHeaders(config, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: [objectPath] }),
    });
  } catch (_) {}
}

// POST /api/auth/login
router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });
  }

  const user = await get(`SELECT * FROM users WHERE username = ?`, [username]);

  if (!user) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  if (!user.is_active) {
    return res.status(403).json({ error: 'هذا الحساب معطّل، يرجى التواصل مع مدير النظام' });
  }

  const passwordMatches = bcrypt.compareSync(password, user.password_hash);
  if (!passwordMatches) {
    // أمان: تسجيل محاولات الدخول الفاشلة (لحساب موجود) في سجل التدقيق
    // لإتاحة رصد محاولات brute-force أو اختراق حسابات لاحقاً
    await logAction(user.id, 'login_failed', 'user', user.id, null);
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  const token = generateToken(user);
  await logAction(user.id, 'login', 'user', user.id, null);

  res.json({
    token,
    user: {
      id: user.id,
      full_name: user.full_name,
      username: user.username,
      role: user.role,
      can_view_cost_price: !!user.can_view_cost_price,
      avatar_url: user.avatar_url || null,
    },
  });
}));

// PUT /api/auth/profile — تغيير الاسم والصورة من إعدادات الحساب الشخصي.
router.put('/profile', authenticate, (req, res, next) => {
  avatarUpload.single('avatar')(req, res, err => {
    if (err) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'حجم الصورة بعد القص يجب ألا يتجاوز 5 ميجابايت' : err.message });
    }
    next();
  });
}, asyncHandler(async (req, res) => {
  const fullName = String(req.body.full_name || '').trim();
  if (!fullName || fullName.length > 100) return res.status(400).json({ error: 'الاسم مطلوب ويجب ألا يزيد عن 100 حرف' });

  const current = await get('SELECT id, full_name, username, role, can_view_cost_price, avatar_url FROM users WHERE id = ?', [req.user.id]);
  if (!current) return res.status(404).json({ error: 'الحساب غير موجود' });

  const removeAvatar = req.body.remove_avatar === 'true';
  let uploaded = null;
  if (req.file) uploaded = await uploadAvatarToStorage(req.user.id, req.file);
  const avatarUrl = uploaded ? uploaded.url : (removeAvatar ? null : current.avatar_url);
  try {
    await run('UPDATE users SET full_name = ?, avatar_url = ?, updated_at = datetime(\'now\') WHERE id = ?', [fullName, avatarUrl, req.user.id]);
  } catch (error) {
    if (uploaded) await deleteAvatarFromStorage(uploaded.config, uploaded.url);
    throw error;
  }

  if (uploaded || removeAvatar) await deleteAvatarFromStorage(uploaded?.config || getStorageConfig(), current.avatar_url);
  const user = { ...current, full_name: fullName, avatar_url: avatarUrl };
  const token = generateToken(user);
  await logAction(req.user.id, 'update_profile', 'user', req.user.id, { full_name: fullName, avatar_changed: Boolean(req.file || removeAvatar) });
  res.json({ token, user: { id: user.id, full_name: user.full_name, username: user.username, role: user.role, can_view_cost_price: !!user.can_view_cost_price, avatar_url: user.avatar_url } });
}));

// GET /api/auth/me
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const user = await get('SELECT id, full_name, username, role, can_view_cost_price, avatar_url, is_active FROM users WHERE id = ?', [req.user.id]);
  if (!user || !user.is_active) return res.status(401).json({ error: 'الحساب غير متاح، يرجى تسجيل الدخول مرة أخرى' });
  res.json({ user: { id: user.id, full_name: user.full_name, username: user.username, role: user.role, can_view_cost_price: !!user.can_view_cost_price, avatar_url: user.avatar_url || null } });
}));

module.exports = router;
