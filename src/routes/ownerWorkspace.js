const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { all, get, insert, run } = require('../db/database');
const multer = require('multer');
const path = require('path');
const { randomUUID } = require('crypto');
const { Readable } = require('stream');
const { getStorageConfig, storageAuthHeaders } = require('../utils/supabaseStorage');
router.use(authenticate, authorize('owner'));
// Music is a Shrouk-only feature. Keep the owner endpoints isolated even if
// another account is later assigned the owner role.
router.use('/songs', (req, res, next) => {
  if (String(req.user?.username || '').toLowerCase() !== 'shrouk') {
    return res.status(404).json({ error: 'المورد غير موجود' });
  }
  next();
});
router.get('/notes', async (req,res)=>{const notes=await all('SELECT id,title,body,color,is_pinned,created_at,updated_at FROM owner_notes WHERE user_id=? ORDER BY is_pinned DESC, updated_at DESC',[req.user.id]);res.json({notes});});
router.post('/notes', async (req,res)=>{const title=String(req.body.title||'').trim();const body=String(req.body.body||'');const color=['rose','lavender','peach','mint'].includes(req.body.color)?req.body.color:'rose';if(!title||title.length>160||body.length>20000)return res.status(400).json({error:'عنوان الملاحظة مطلوب والنص محدود بـ20 ألف حرف'});const id=await insert('INSERT INTO owner_notes(user_id,title,body,color) VALUES(?,?,?,?)',[req.user.id,title,body,color]);const note=await get('SELECT id,title,body,color,is_pinned,created_at,updated_at FROM owner_notes WHERE id=? AND user_id=?',[id,req.user.id]);res.status(201).json({note});});
router.put('/notes/:id', async (req,res)=>{const current=await get('SELECT id FROM owner_notes WHERE id=? AND user_id=?',[req.params.id,req.user.id]);if(!current)return res.status(404).json({error:'الملاحظة غير موجودة'});const fields=[];const values=[];if(Object.hasOwn(req.body,'title')){const title=String(req.body.title||'').trim();if(!title||title.length>160)return res.status(400).json({error:'العنوان مطلوب وبحد أقصى 160 حرفاً'});fields.push('title=?');values.push(title);}if(Object.hasOwn(req.body,'body')){const body=String(req.body.body||'');if(body.length>20000)return res.status(400).json({error:'النص يتجاوز الحد المسموح'});fields.push('body=?');values.push(body);}if(Object.hasOwn(req.body,'color')){if(!['rose','lavender','peach','mint'].includes(req.body.color))return res.status(400).json({error:'اللون غير مدعوم'});fields.push('color=?');values.push(req.body.color);}if(Object.hasOwn(req.body,'is_pinned')){fields.push('is_pinned=?');values.push(req.body.is_pinned?1:0);}if(!fields.length)return res.status(400).json({error:'لا توجد تغييرات'});fields.push("updated_at=datetime('now')");values.push(req.params.id,req.user.id);await run('UPDATE owner_notes SET '+fields.join(',')+' WHERE id=? AND user_id=?',values);res.json({note:await get('SELECT id,title,body,color,is_pinned,created_at,updated_at FROM owner_notes WHERE id=? AND user_id=?',[req.params.id,req.user.id])});});
router.delete('/notes/:id', async (req,res)=>{const current=await get('SELECT id FROM owner_notes WHERE id=? AND user_id=?',[req.params.id,req.user.id]);if(!current)return res.status(404).json({error:'الملاحظة غير موجودة'});await run('DELETE FROM owner_notes WHERE id=? AND user_id=?',[req.params.id,req.user.id]);res.json({ok:true});});

const MUSIC_BUCKET = 'owner-music';
const MAX_AUDIO_SIZE = 25 * 1024 * 1024;
const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.webm': 'audio/webm',
};
const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const musicUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_SIZE, files: 2 },
  fileFilter(_req, file, callback) {
    if (file.fieldname === 'audio') {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!AUDIO_TYPES[ext] || (!file.mimetype.startsWith('audio/') && file.mimetype !== 'application/octet-stream')) {
        return callback(Object.assign(new Error('صيغة الملف الصوتي غير مدعومة'), { status: 400 }));
      }
      return callback(null, true);
    }
    if (file.fieldname === 'cover' && COVER_TYPES.has(file.mimetype)) return callback(null, true);
    callback(Object.assign(new Error('ملف الغلاف يجب أن يكون صورة JPG أو PNG أو WEBP أو AVIF'), { status: 400 }));
  },
});
function acceptMusicUpload(req, res, next) {
  musicUpload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }])(req, res, error => {
    if (!error) return next();
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'حجم الأغنية يتجاوز 25 ميجابايت' : error.message || 'تعذر قراءة ملفات الأغنية',
    });
  });
}

function musicObjectUrl(config, objectPath) {
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
  return `${config.url}/storage/v1/object/${MUSIC_BUCKET}/${encoded}`;
}

function safeStorageError(response, details) {
  const missingCredentials = response.status === 401 || response.status === 403;
  return Object.assign(new Error(missingCredentials
    ? 'Supabase رفض مفتاح التخزين. راجع إعدادات Supabase Storage على الخادم.'
    : `تعذر الوصول إلى تخزين الموسيقى (HTTP ${response.status})`), {
    status: missingCredentials ? 503 : 502,
    storageStatus: response.status,
    storageError: String(details || '').slice(0, 500),
  });
}

async function ensurePrivateMusicBucket(config) {
  const endpoint = `${config.url}/storage/v1/bucket/${MUSIC_BUCKET}`;
  const current = await fetch(endpoint, { headers: storageAuthHeaders(config) });
  if (current.ok) {
    const bucket = await current.json().catch(() => ({}));
    if (!bucket.public) return;
    const makePrivate = await fetch(endpoint, {
      method: 'PUT',
      headers: storageAuthHeaders(config, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ public: false }),
    });
    if (!makePrivate.ok) throw safeStorageError(makePrivate, await makePrivate.text());
    return;
  }
  // Supabase Storage may expose a missing bucket as HTTP 400 while its
  // legacy response body reports statusCode 404 / code NoSuchBucket.
  const currentBody = await current.json().catch(() => ({}));
  const missingBucket = current.status === 404
    || Number(currentBody.statusCode ?? currentBody.status) === 404
    || currentBody.code === 'NoSuchBucket';
  if (!missingBucket) throw safeStorageError(current, JSON.stringify(currentBody));
  const create = await fetch(`${config.url}/storage/v1/bucket`, {
    method: 'POST',
    headers: storageAuthHeaders(config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      id: MUSIC_BUCKET,
      name: MUSIC_BUCKET,
      public: false,
      file_size_limit: MAX_AUDIO_SIZE,
      allowed_mime_types: [...new Set([...Object.values(AUDIO_TYPES), ...COVER_TYPES])],
    }),
  });
  if (!create.ok && create.status !== 409) throw safeStorageError(create, await create.text());
}

async function uploadMusicObject(config, objectPath, file) {
  await ensurePrivateMusicBucket(config);
  const response = await fetch(musicObjectUrl(config, objectPath), {
    method: 'POST',
    headers: storageAuthHeaders(config, { 'Content-Type': file.mimetype, 'x-upsert': 'false' }),
    body: file.buffer,
  });
  if (!response.ok) throw safeStorageError(response, await response.text());
}

async function deleteMusicObjects(config, objectPaths) {
  const prefixes = objectPaths.filter(Boolean);
  if (!prefixes.length) return;
  const response = await fetch(`${config.url}/storage/v1/object/${MUSIC_BUCKET}`, {
    method: 'DELETE',
    headers: storageAuthHeaders(config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes }),
  });
  if (!response.ok) throw safeStorageError(response, await response.text());
}

function publicSong(song) {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    audio_mime: song.audio_mime,
    audio_size: song.audio_size,
    is_favorite: Boolean(song.is_favorite),
    has_cover: Boolean(song.cover_path),
    is_seeded: Boolean(song.seed_key),
    created_at: song.created_at,
    audio_url: `/owner-workspace/songs/${song.id}/audio`,
    cover_url: song.cover_path ? `/owner-workspace/songs/${song.id}/cover` : null,
  };
}

async function findOwnerSong(id, ownerId) {
  if (!/^\d+$/.test(String(id))) return null;
  return get('SELECT * FROM owner_songs WHERE id=? AND user_id=?', [Number(id), ownerId]);
}

async function pipePrivateSong(req, res, song, objectPath, mimeType) {
  const config = getStorageConfig();
  if (!config) return res.status(503).json({ error: 'إعداد Supabase Storage غير مكتمل على الخادم' });
  const url = musicObjectUrl(config, objectPath).replace('/object/', '/object/authenticated/');
  const headers = storageAuthHeaders(config);
  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) headers.Range = range;
  const upstream = await fetch(url, { headers });
  if (!upstream.ok) {
    const details = (await upstream.text()).slice(0, 500);
    throw safeStorageError(upstream, details);
  }
  res.status(upstream.status);
  res.set('Content-Type', mimeType);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Accept-Ranges', 'bytes');
  for (const header of ['content-length', 'content-range']) {
    const value = upstream.headers.get(header);
    if (value) res.set(header, value);
  }
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
}

router.get('/songs', async (req, res) => {
  // Remove the previously bundled starter track on its next owner-library
  // visit, then leave the library empty until Shrouk uploads her own songs.
  const starterTracks = await all(
    'SELECT id,audio_path,cover_path FROM owner_songs WHERE user_id=? AND seed_key=?',
    [req.user.id, 'owner-first-track-v1']
  );
  if (starterTracks.length) {
    const config = getStorageConfig();
    if (config) {
      try {
        await deleteMusicObjects(config, starterTracks.flatMap(song => [song.audio_path, song.cover_path]));
        await run('DELETE FROM owner_songs WHERE user_id=? AND seed_key=?', [req.user.id, 'owner-first-track-v1']);
      } catch (error) {
        console.warn('Could not remove the owner starter song from private storage:', error.message);
      }
    }
  }
  const songs = await all(
    "SELECT id,title,artist,audio_mime,audio_size,cover_path,is_favorite,seed_key,created_at FROM owner_songs WHERE user_id=? AND (seed_key IS NULL OR seed_key <> 'owner-first-track-v1') ORDER BY is_favorite DESC, created_at DESC",
    [req.user.id]
  );
  res.json({ songs: songs.map(publicSong) });
});

router.post('/songs', acceptMusicUpload, async (req, res) => {
  const audio = req.files?.audio?.[0];
  const cover = req.files?.cover?.[0];
  if (!audio) return res.status(400).json({ error: 'اختاري ملف الأغنية أولاً' });
  if (cover && cover.size > 4 * 1024 * 1024) return res.status(400).json({ error: 'حجم صورة الغلاف يجب ألا يتجاوز 4 ميجابايت' });
  const ext = path.extname(audio.originalname || '').toLowerCase();
  const mime = AUDIO_TYPES[ext];
  const title = String(req.body.title || path.basename(audio.originalname, ext)).trim().slice(0, 120);
  const artist = String(req.body.artist || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: 'اكتبي اسم الأغنية' });
  const config = getStorageConfig();
  if (!config) return res.status(503).json({ error: 'إعداد Supabase Storage غير مكتمل على الخادم' });
  const audioPath = `${req.user.id}/${randomUUID()}${ext}`;
  const coverExt = cover ? ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif' }[cover.mimetype]) : null;
  const coverPath = cover ? `${req.user.id}/${randomUUID()}${coverExt}` : null;
  await uploadMusicObject(config, audioPath, { ...audio, mimetype: mime });
  try {
    if (cover) await uploadMusicObject(config, coverPath, cover);
    const id = await insert('INSERT INTO owner_songs(user_id,title,artist,audio_path,audio_mime,audio_size,cover_path,is_favorite) VALUES(?,?,?,?,?,?,?,1)',
      [req.user.id, title, artist, audioPath, mime, audio.size, coverPath]);
    const song = await get('SELECT * FROM owner_songs WHERE id=? AND user_id=?', [id, req.user.id]);
    res.status(201).json({ song: publicSong(song) });
  } catch (error) {
    await deleteMusicObjects(config, [audioPath, coverPath]).catch(() => {});
    throw error;
  }
});

router.put('/songs/:id', async (req, res) => {
  const song = await findOwnerSong(req.params.id, req.user.id);
  if (!song) return res.status(404).json({ error: 'الأغنية غير موجودة' });
  if (typeof req.body.is_favorite !== 'boolean') return res.status(400).json({ error: 'حالة المفضلة غير صالحة' });
  await run('UPDATE owner_songs SET is_favorite=? WHERE id=? AND user_id=?', [req.body.is_favorite ? 1 : 0, song.id, req.user.id]);
  const updated = await get('SELECT * FROM owner_songs WHERE id=? AND user_id=?', [song.id, req.user.id]);
  res.json({ song: publicSong(updated) });
});

router.get('/songs/:id/audio', async (req, res) => {
  const song = await findOwnerSong(req.params.id, req.user.id);
  if (!song) return res.status(404).json({ error: 'الأغنية غير موجودة' });
  await pipePrivateSong(req, res, song, song.audio_path, song.audio_mime);
});

router.get('/songs/:id/cover', async (req, res) => {
  const song = await findOwnerSong(req.params.id, req.user.id);
  if (!song?.cover_path) return res.status(404).json({ error: 'غلاف الأغنية غير موجود' });
  const ext = path.extname(song.cover_path).toLowerCase();
  const mime = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif' }[ext];
  await pipePrivateSong(req, res, song, song.cover_path, mime);
});

router.delete('/songs/:id', async (req, res) => {
  const song = await findOwnerSong(req.params.id, req.user.id);
  if (!song) return res.status(404).json({ error: 'الأغنية غير موجودة' });
  const config = getStorageConfig();
  if (!config) return res.status(503).json({ error: 'إعداد Supabase Storage غير مكتمل على الخادم' });
  await deleteMusicObjects(config, [song.audio_path, song.cover_path]);
  await run('DELETE FROM owner_songs WHERE id=? AND user_id=?', [song.id, req.user.id]);
  res.json({ ok: true });
});

module.exports=router;
