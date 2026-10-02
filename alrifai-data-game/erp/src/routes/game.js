// routes/game.js — API لعبة البيانات: /api/game/*
// نفس نظام الدخول (JWT) الموجود في الـ ERP. مفيش مفتاح service-role ولا اتصال مباشر من التطبيق بالداتابيز.
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { all } = require('../db/database');
const { buildFileUrl } = require('../utils/fileUrl');
const logger = require('../utils/logger');
const cfg = require('../game/config');
const { GameError } = require('../game/errors');
const tasks = require('../game/taskService');
const inventory = require('../game/inventoryService');
const stats = require('../game/statsService');

router.use(authenticate);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: cfg.MAX_IMAGE_BYTES, files: 1 } });

const dataAccess = authorize(...cfg.DATA_ROLES);
const inventoryAccess = authorize(...cfg.INVENTORY_ROLES);
const adminAccess = authorize('admin', 'manager');

// يحوّل image_path الداخلي لرابط كامل في أي payload
function withUrls(req, obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.task && obj.task.product) obj.task.product.image_url = buildFileUrl(req, obj.task.product.image_path);
  if (obj.task && obj.task.field === 'image') obj.task.current_image_url = buildFileUrl(req, obj.task.current);
  if (obj.image_path) obj.image_url = buildFileUrl(req, obj.image_path);
  return obj;
}
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const id = req => parseInt(req.params.id, 10);

router.get('/me', h(async (req, res) => res.json(await stats.getMe(req.user))));
router.get('/team', h(async (req, res) => res.json(await stats.getTeam())));
router.get('/categories', dataAccess, h(async (req, res) => res.json(await all(`SELECT id, name FROM categories ORDER BY name`))));

// ── مهام البيانات ──
router.post('/tasks/next', dataAccess, h(async (req, res) => res.json(withUrls(req, await tasks.claimNext(req.user, req.body && req.body.mode)))));
router.post('/tasks/:id/answer', dataAccess, h(async (req, res) => res.json(await tasks.submitAnswer(req.user, id(req), req.body))));
router.post('/tasks/:id/skip', h(async (req, res) => res.json(await tasks.skipTask(req.user, id(req), req.body && req.body.request_id))));
router.post('/tasks/:id/heartbeat', h(async (req, res) => res.json(await tasks.heartbeat(req.user, id(req)))));
router.post('/tasks/:id/release', h(async (req, res) => res.json(await tasks.releaseTask(req.user, id(req)))));
router.post('/tasks/:id/image', dataAccess, (req, res, next) => {
  upload.single('image')(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new GameError(413, 'INVALID_IMAGE', 'الصورة كبيرة أوي. جرّب تصوّر تاني.'));
    next(new GameError(400, 'INVALID_IMAGE', 'مقدرناش نستقبل الصورة. جرّب تاني.'));
  });
}, h(async (req, res) => {
  if (!req.file) throw new GameError(400, 'INVALID_IMAGE', 'ما وصلتش صورة.');
  const out = await tasks.completeImageUpload(req.user, id(req), req.file.buffer, req.body.request_id);
  res.json(withUrls(req, out));
}));

// ── الجرد ──
router.get('/inventory/locations', inventoryAccess, h(async (req, res) => res.json(await inventory.listLocations(req.user))));
router.post('/inventory/start', inventoryAccess, h(async (req, res) => res.json(await inventory.startSession(req.user, req.body.location_id))));
router.post('/inventory/next', inventoryAccess, h(async (req, res) => res.json(withUrls(req, await inventory.nextProduct(req.user, parseInt(req.body.session_id, 10))))));
router.post('/inventory/tasks/:id/answer', inventoryAccess, h(async (req, res) => res.json(await inventory.answerCount(req.user, id(req), req.body))));

// ── الإدارة ──
router.get('/admin/stats', adminAccess, h(async (req, res) => res.json(await stats.getAdminStats())));

// معالج أخطاء محلي: رسائل عربية ودودة، ومفيش تسريب لتفاصيل الداتابيز للموظف
router.use((err, req, res, next) => {
  if (err instanceof GameError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
  if (err && err.code === '23505') return res.status(409).json({ error: 'حصل تعارض بسيط — جرّب تاني.', code: 'CONFLICT' });
  logger.error('Game route error', { path: req.originalUrl, userId: req.user && req.user.id, error: err && err.message, stack: err && err.stack });
  res.status(500).json({ error: 'حصلت مشكلة عندنا. جرّب تاني بعد لحظة.', code: 'SERVER_ERROR' });
});

module.exports = router;
