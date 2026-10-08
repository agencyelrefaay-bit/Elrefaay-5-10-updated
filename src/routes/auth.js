// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { get, run, all } = require('../db/database');
const nodemailer = require('nodemailer');
const { generateToken, authenticate, JWT_SECRET } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
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
  const isModernSecret = key.startsWith('sb_secret_');
  const isLegacyServiceRole = key.startsWith('eyJ') && key.split('.').length === 3;
  if (!isModernSecret && !isLegacyServiceRole) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    url = parsed.origin;
  } catch (_) { return null; }
  return { url, key, isModernSecret };
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
    const responseText = (await response.text()).slice(0, 700);
    let details = responseText;
    try { const parsed = JSON.parse(responseText); details = parsed.message || parsed.error || parsed.error_description || responseText; } catch (_) {}
    const missingBucket = response.status === 404 || /bucket.*not found/i.test(details);
    const message = missingBucket
      ? 'Bucket باسم user-avatars غير موجود في Supabase Storage'
      : (response.status === 401 || response.status === 403
        ? 'Supabase رفض مفتاح الرفع أو صلاحياته'
        : 'تعذر رفع الصورة إلى التخزين السحابي (HTTP ' + response.status + ')');
    throw Object.assign(new Error(message), { status: missingBucket ? 503 : 502, storageStatus: response.status, storageError: String(details).slice(0, 500) });
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

  if (user.role === 'owner') {
    let to;
    const lastSentAt = user.owner_email_otp_sent_at ? Date.parse(user.owner_email_otp_sent_at) : 0;
    if (lastSentAt && Date.now() - lastSentAt < 60_000) {
      return res.status(429).json({ error: 'تم إرسال رمز مؤخرًا. انتظر دقيقة قبل طلب رمز جديد.' });
    }
    const code = String(crypto.randomInt(100000, 1000000));
    try {
      to = getOwnerEmail();
      await sendOwnerLoginCode(to, code);
    } catch (error) {
      console.error('Owner email OTP delivery failed', { code: error.code || null, responseCode: error.responseCode || null, command: error.command || null });
      await logAction(user.id, 'login_email_otp_send_failed', 'user', user.id, { code: error.code || null, response_code: error.responseCode || null });
      if (error.code === 'OWNER_EMAIL_NOT_CONFIGURED') return res.status(503).json({ error: 'إعداد بريد الإرسال غير مكتمل على الخادم' });
      if (error.code === 'EAUTH' || [534, 535].includes(Number(error.responseCode))) return res.status(503).json({ error: 'Gmail رفض بيانات الدخول. تأكد من GMAIL_USER وأن GMAIL_APP_PASSWORD هي كلمة مرور تطبيق صالحة.' });
      if (error.code === 'ERESEND' && [401, 403].includes(Number(error.responseCode))) return res.status(503).json({ error: 'مفتاح Resend غير صالح أو لا يملك صلاحية إرسال البريد.' });
      if (error.code === 'ERESEND' && [400, 422].includes(Number(error.responseCode))) return res.status(503).json({ error: 'عنوان الإرسال في Resend غير مقبول. استخدم عنوانًا تابعًا لنطاق موثّق في Resend.' });
      if (error.code === 'ERESEND') return res.status(503).json({ error: 'Resend لم يقبل إرسال الرسالة. راجع حالة الخدمة وسجلاتها.' });
      if (['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNREFUSED', 'ENETUNREACH'].includes(error.code)) return res.status(503).json({ error: 'الخادم لم يستطع الاتصال بخادم البريد. راجع اتصال الشبكة والسجلات.' });
      if (error.code === 'ERESEND_NETWORK') return res.status(503).json({ error: 'تعذر اتصال الخادم بواجهة Resend عبر HTTPS. راجع اتصال الشبكة والسجلات.' });
      return res.status(503).json({ error: 'تعذر إرسال الرمز. كود التشخيص: ' + String(error.code || error.responseCode || 'UNKNOWN') });
    }
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    await run('UPDATE users SET owner_email_otp_hash=?, owner_email_otp_expires_at=?, owner_email_otp_sent_at=?, owner_email_otp_attempts=0 WHERE id=?', [hashOwnerEmailCode(code), expiresAt, new Date().toISOString(), user.id]);
    const challenge_token = jwt.sign({ id: user.id, username: user.username, purpose: 'owner_email_otp' }, JWT_SECRET, { expiresIn: '5m' });
    await logAction(user.id, 'login_email_otp_sent', 'user', user.id, null);
    return res.json({ requires_2fa: true, challenge_token, destination: maskOwnerEmail(to), user: { username: user.username } });
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

// بريد المالك: رمز OTP قصير العمر، محفوظ كـ HMAC ولا يُخزَّن كنص صريح.
function getOwnerEmail() {
  const email = String(process.env.OWNER_EMAIL || 'oalaaofficial@gmail.com').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('Invalid owner email'), { code: 'OWNER_EMAIL_NOT_CONFIGURED' });
  return email;
}
function maskOwnerEmail(email) { const [name, domain] = email.split('@'); return (name[0] || '*') + '*'.repeat(Math.max(2, Math.min(name.length - 1, 8))) + '@' + domain; }
function hashOwnerEmailCode(code) { return crypto.createHmac('sha256', JWT_SECRET).update(String(code)).digest('hex'); }
async function sendOwnerLoginCode(to, code) {
  const subject = 'رمز التحقق لحساب المالك';
  const text = 'رمز التحقق الخاص بتسجيل الدخول هو: ' + code + '\nصالح لمدة 5 دقائق. إذا لم تطلبه، تجاهل هذه الرسالة.';
  const html = '<div dir="rtl" style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#241b24"><h2>رمز التحقق</h2><p>استخدم الرمز التالي لإكمال تسجيل الدخول إلى حساب المالك:</p><div style="font-size:30px;font-weight:700;letter-spacing:8px;text-align:center;padding:18px;background:#f8eff6;border-radius:12px">' + code + '</div><p>الرمز صالح لمدة 5 دقائق، ولا تشاركه مع أي شخص.</p><small>إذا لم تطلب هذا الرمز، يمكنك تجاهل الرسالة.</small></div>';

  // Railway Free/Trial/Hobby blocks outbound SMTP; its HTTPS API remains available.
  const resendKey = String(process.env.RESEND_API_KEY || '').trim();
  if (resendKey) {
    const sender = String(process.env.RESEND_FROM_EMAIL || '').trim();
    if (!sender) throw Object.assign(new Error('RESEND_FROM_EMAIL is missing'), { code: 'OWNER_EMAIL_NOT_CONFIGURED' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: sender, to: [to], subject, text, html }),
        signal: controller.signal,
      });
      if (!response.ok) throw Object.assign(new Error('Resend rejected owner OTP'), { code: 'ERESEND', responseCode: response.status });
      return;
    } catch (error) {
      if (error.code) throw error;
      throw Object.assign(new Error('Resend HTTPS request failed'), { code: error.name === 'AbortError' ? 'ETIMEDOUT' : (error.cause && error.cause.code) || 'ERESEND_NETWORK' });
    } finally {
      clearTimeout(timeout);
    }
  }

  const sender = String(process.env.GMAIL_USER || to).trim();
  const appPassword = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!appPassword) throw Object.assign(new Error('Gmail App Password or Resend API key is missing'), { code: 'OWNER_EMAIL_NOT_CONFIGURED' });
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: sender, pass: appPassword }, connectionTimeout: 12000, greetingTimeout: 10000, socketTimeout: 15000 });
  try {
    await transporter.sendMail({ from: { name: 'الرفاعي ERP', address: sender }, to, subject, text, html });
  } finally {
    transporter.close();
  }
}
async function getOwnerEmailChallenge(req, res) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) { res.status(401).json({ error: 'جلسة التحقق غير صالحة' }); return null; }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    if (payload.purpose !== 'owner_email_otp') throw new Error();
    const user = await get('SELECT id,username,role,is_active,owner_email_otp_hash,owner_email_otp_expires_at,owner_email_otp_attempts FROM users WHERE id=?', [payload.id]);
    if (!user || user.role !== 'owner' || !user.is_active) throw new Error();
    return user;
  } catch (_) { res.status(401).json({ error: 'انتهت جلسة التحقق، أعد تسجيل الدخول' }); return null; }
}
function issueOwnerSession(user, res) {
  const token = generateToken({ ...user, role: 'owner', can_view_cost_price: 1 });
  return res.json({ token, user: { id: user.id, full_name: user.full_name, username: user.username, role: 'owner', can_view_cost_price: true, avatar_url: user.avatar_url || null } });
}
const ownerEmailOtpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, message: { error: 'محاولات تحقق كثيرة، حاول بعد 15 دقيقة' } });
router.post('/owner-2fa/verify', ownerEmailOtpLimiter, asyncHandler(async (req, res) => {
  const user = await getOwnerEmailChallenge(req, res); if (!user) return;
  const storedHash = String(user.owner_email_otp_hash || '');
  const expiresAt = Date.parse(user.owner_email_otp_expires_at || '');
  if (!storedHash || !expiresAt || Date.now() >= expiresAt) {
    await run('UPDATE users SET owner_email_otp_hash=NULL, owner_email_otp_expires_at=NULL, owner_email_otp_attempts=0 WHERE id=?', [user.id]);
    return res.status(410).json({ error: 'انتهت صلاحية الرمز. ابدأ تسجيل الدخول من جديد.' });
  }
  if (Number(user.owner_email_otp_attempts || 0) >= 5) return res.status(429).json({ error: 'تم تجاوز عدد المحاولات. ابدأ تسجيل الدخول من جديد.' });
  const code = String(req.body.code || '').replace(/\s/g, '');
  const validFormat = /^\d{6}$/.test(code);
  const candidate = validFormat ? hashOwnerEmailCode(code) : '';
  const matches = validFormat && /^[a-f0-9]{64}$/.test(storedHash) && crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(storedHash, 'hex'));
  if (!matches) {
    await all('UPDATE users SET owner_email_otp_attempts=owner_email_otp_attempts+1 WHERE id=? AND owner_email_otp_hash=? AND owner_email_otp_expires_at>? AND owner_email_otp_attempts<5 RETURNING id', [user.id, storedHash, new Date().toISOString()]);
    await logAction(user.id, 'login_email_otp_failed', 'user', user.id, null);
    return res.status(401).json({ error: 'رمز التحقق غير صحيح' });
  }
  const consumed = await all('UPDATE users SET owner_email_otp_hash=NULL, owner_email_otp_expires_at=NULL, owner_email_otp_attempts=0 WHERE id=? AND owner_email_otp_hash=? AND owner_email_otp_expires_at>? AND owner_email_otp_attempts<5 RETURNING id', [user.id, storedHash, new Date().toISOString()]);
  if (!consumed.length) return res.status(401).json({ error: 'الرمز غير صالح أو استُخدم بالفعل' });
  const current = await get('SELECT id,username,full_name,avatar_url FROM users WHERE id=?', [user.id]);
  await logAction(user.id, 'login', 'user', user.id, { method: 'email_otp' });
  issueOwnerSession(current, res);
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
