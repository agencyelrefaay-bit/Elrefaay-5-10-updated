// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { get, run } = require('../db/database');
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
    const challenge_token = jwt.sign({ id: user.id, username: user.username, purpose: 'owner_totp' }, JWT_SECRET, { expiresIn: '5m' });
    await logAction(user.id, 'login_password_verified', 'user', user.id, null);
    return res.json({ requires_2fa: true, setup_required: !user.totp_enabled, challenge_token, user: { username: user.username } });
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

// مصادقة TOTP مجانية (RFC 6238). يُشفّر السر باستخدام مفتاح مشتق من JWT_SECRET قبل التخزين.
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer) { let bits=0, value=0, out=''; for (const byte of buffer) { value=(value<<8)|byte; bits+=8; while(bits>=5){out+=base32Alphabet[(value >>> (bits-5))&31];bits-=5;} } if(bits) out+=base32Alphabet[(value<<(5-bits))&31]; return out; }
function base32Decode(input) { let bits=0,value=0,out=[]; for(const char of input.toUpperCase().replace(/=+$/,'')){const n=base32Alphabet.indexOf(char);if(n<0)throw new Error('Invalid TOTP secret');value=(value<<5)|n;bits+=5;if(bits>=8){out.push((value >>> (bits-8))&255);bits-=8;}} return Buffer.from(out); }
function totpAt(secret, counter) { const msg=Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter)); const mac=crypto.createHmac('sha1',base32Decode(secret)).update(msg).digest(); const offset=mac[mac.length-1]&15; const num=(mac.readUInt32BE(offset)&0x7fffffff)%1000000; return String(num).padStart(6,'0'); }
function verifyTotp(secret, code) { const clean=String(code||'').replace(/\s/g,''); if(!/^\d{6}$/.test(clean))return false; const step=Math.floor(Date.now()/30000); return [-1,0,1].some(delta=>crypto.timingSafeEqual(Buffer.from(totpAt(secret,step+delta)),Buffer.from(clean))); }
function encryptTotpSecret(secret) { const key=crypto.createHash('sha256').update(JWT_SECRET+'|owner-totp-v1').digest(); const iv=crypto.randomBytes(12); const cipher=crypto.createCipheriv('aes-256-gcm',key,iv); const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]); return [iv.toString('base64'),cipher.getAuthTag().toString('base64'),encrypted.toString('base64')].join('.'); }
function decryptTotpSecret(value) { const [iv,tag,data]=String(value||'').split('.'); const key=crypto.createHash('sha256').update(JWT_SECRET+'|owner-totp-v1').digest(); const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64')); decipher.setAuthTag(Buffer.from(tag,'base64')); return Buffer.concat([decipher.update(Buffer.from(data,'base64')),decipher.final()]).toString('utf8'); }
async function getOwnerChallenge(req,res) { const header=req.headers.authorization||''; if(!header.startsWith('Bearer ')) {res.status(401).json({error:'جلسة التحقق غير صالحة'});return null;} try { const payload=jwt.verify(header.slice(7),JWT_SECRET); if(payload.purpose!=='owner_totp')throw new Error(); const user=await get('SELECT id,username,role,is_active,totp_secret,totp_enabled FROM users WHERE id=?',[payload.id]); if(!user||user.role!=='owner'||!user.is_active)throw new Error(); return user; } catch (_) {res.status(401).json({error:'انتهت جلسة التحقق، أعد تسجيل الدخول'});return null;} }
function issueOwnerSession(user,res) { const token=generateToken({...user,role:'owner',can_view_cost_price:1}); return res.json({token,user:{id:user.id,full_name:user.full_name,username:user.username,role:'owner',can_view_cost_price:true,avatar_url:user.avatar_url||null}}); }
const ownerTotpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, message: { error: 'محاولات تحقق كثيرة، حاول بعد 15 دقيقة' } });
router.post('/owner-2fa/setup', ownerTotpLimiter, asyncHandler(async(req,res)=>{ const user=await getOwnerChallenge(req,res);if(!user)return;if(user.totp_enabled)return res.status(409).json({error:'التحقق بخطوتين مُعدّ بالفعل'}); const secret=base32Encode(crypto.randomBytes(20)); const uri='otpauth://totp/'+encodeURIComponent('الرفاعي ERP:'+user.username)+'?secret='+secret+'&issuer='+encodeURIComponent('الرفاعي ERP')+'&algorithm=SHA1&digits=6&period=30'; req.app.locals.ownerTotpSetup ||= new Map(); req.app.locals.ownerTotpSetup.set(user.id,{secret,expires:Date.now()+10*60*1000}); res.json({secret,otpauth_url:uri}); }));
router.post('/owner-2fa/confirm', ownerTotpLimiter, asyncHandler(async(req,res)=>{ const user=await getOwnerChallenge(req,res);if(!user)return; const pending=req.app.locals.ownerTotpSetup?.get(user.id); if(!pending||pending.expires<Date.now())return res.status(410).json({error:'انتهت مهلة الإعداد، أعد المحاولة'}); if(!verifyTotp(pending.secret,req.body.code))return res.status(400).json({error:'رمز التحقق غير صحيح'}); await run('UPDATE users SET totp_secret=?,totp_enabled=1,updated_at=datetime(\'now\') WHERE id=?',[encryptTotpSecret(pending.secret),user.id]); req.app.locals.ownerTotpSetup.delete(user.id); const current=await get('SELECT id,username,full_name,avatar_url FROM users WHERE id=?',[user.id]); await logAction(user.id,'owner_2fa_enabled','user',user.id,null); issueOwnerSession(current,res); }));
router.post('/owner-2fa/verify', ownerTotpLimiter, asyncHandler(async(req,res)=>{ const user=await getOwnerChallenge(req,res);if(!user)return;if(!user.totp_enabled||!user.totp_secret)return res.status(409).json({error:'يجب إعداد التحقق بخطوتين أولاً'}); let secret;try{secret=decryptTotpSecret(user.totp_secret);}catch(_){return res.status(503).json({error:'تعذر فك إعداد التحقق؛ راجع مفتاح JWT_SECRET'});} if(!verifyTotp(secret,req.body.code)){await logAction(user.id,'login_2fa_failed','user',user.id,null);return res.status(401).json({error:'رمز التحقق غير صحيح'});} await logAction(user.id,'login','user',user.id,null); const current=await get('SELECT id,username,full_name,avatar_url FROM users WHERE id=?',[user.id]);issueOwnerSession(current,res); }));

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
