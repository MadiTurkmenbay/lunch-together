import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, insertMeals } from './db.mjs';
import { opaqueToken, hashToken, hashPassword, verifyPassword, parseCookies, cookieOptions, checkOrigin } from './security.mjs';

const DAY = 86400000;
const supplierCookie = 'lt_supplier';
const guestCookie = 'lt_guest';
const uuid = z.string().uuid();
const nonempty = (max) => z.string().trim().min(1).max(max);
const safeText = (max) => z.string().trim().max(max);
const image = z.enum(['/assets/chicken.jpg', '/assets/cutlets.jpg', '/assets/veggie.jpg']);
const mealInput = z.object({ name: nonempty(100), description: safeText(500), tag: safeText(60).default(''), image, details: safeText(100).default(''), price: z.number().int().min(1).max(1000000) }).strict();
const batchInput = z.object({
  title: nonempty(120), office: nonempty(200), deliveryAt: z.string().datetime({ offset: true }),
  orderDeadline: z.string().datetime({ offset: true }), paymentDeadline: z.string().datetime({ offset: true }),
  minParticipants: z.number().int().min(1).max(100), minPaidPortions: z.number().int().min(1).max(100),
  paymentInstructions: safeText(2000), meals: z.array(mealInput).min(1).max(12),
}).strict();
const orderInput = z.object({
  batchId: uuid, name: nonempty(80), department: safeText(80).default(''),
  items: z.array(z.object({ mealId: nonempty(80), quantity: z.number().int().min(1).max(20) }).strict()).min(1).max(12),
}).strict();

class HttpError extends Error {
  constructor(status, message, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new HttpError(status, message, code); };
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) fail(400, 'Проверьте заполнение полей.', 'VALIDATION_ERROR');
  return result.data;
};
const validToken = (token) => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);

export function serializeBatch(row) {
  if (!row) return null;
  return {
    id: row.id, title: row.title, office: row.office,
    deliveryAt: row.delivery_at.toISOString(), orderDeadline: row.order_deadline.toISOString(), paymentDeadline: row.payment_deadline.toISOString(),
    minParticipants: row.min_participants, minPaidPortions: row.min_paid_portions,
    status: row.status, paymentInstructions: row.payment_instructions, paymentOpened: row.payment_opened,
  };
}

async function newestBatch(db) {
  return (await db.query('SELECT * FROM batches ORDER BY created_at DESC, id DESC LIMIT 1')).rows[0] ?? null;
}
async function lockedBatch(db, id) {
  parse(uuid, id);
  const batch = (await db.query('SELECT * FROM batches WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!batch) fail(404, 'Заказ на доставку не найден.', 'NOT_FOUND');
  return batch;
}
function ensureOpen(batch) {
  if (batch.status !== 'open') fail(409, 'Набор уже закрыт.', 'BATCH_CLOSED');
}
function ensureOrderDeadline(batch) {
  ensureOpen(batch);
  if (Date.now() >= batch.order_deadline.getTime()) fail(409, 'Время приёма заявок закончилось.', 'ORDER_DEADLINE');
}
async function mealsFor(db, batchId) {
  return (await db.query('SELECT id,name,description,tag,image,details,price FROM meals WHERE batch_id=$1 ORDER BY position,id', [batchId])).rows;
}
async function totalsFor(db, batch) {
  if (!batch) return { participants: 0, portions: 0, paidPortions: 0, paidAmount: 0, pendingCount: 0, paymentOpen: false };
  const { rows: [totals] } = await db.query(`SELECT count(DISTINCT o.id)::int AS participants,
    COALESCE(sum(i.quantity),0)::int AS portions,
    COALESCE(sum(i.quantity) FILTER (WHERE o.payment='paid'),0)::int AS "paidPortions",
    COALESCE(sum(i.quantity*i.unit_price) FILTER (WHERE o.payment='paid'),0)::bigint AS "paidAmount",
    count(DISTINCT o.id) FILTER (WHERE o.payment='pending')::int AS "pendingCount"
    FROM orders o LEFT JOIN order_items i ON i.order_id=o.id WHERE o.batch_id=$1`, [batch.id]);
  return { ...totals, paidAmount: Number(totals.paidAmount), paymentOpen: batch.payment_opened };
}
async function ordersFor(db, batchId, guestHash) {
  const parameters = [batchId];
  if (guestHash) parameters.push(guestHash);
  const result = await db.query(`SELECT o.id,o.name,o.department,o.payment AS "paymentStatus",
    COALESCE(jsonb_agg(jsonb_build_object('mealId', i.meal_id, 'name', m.name, 'quantity', i.quantity, 'price', i.unit_price) ORDER BY m.position)
      FILTER (WHERE i.meal_id IS NOT NULL),'[]'::jsonb) AS items,
    COALESCE(sum(i.quantity*i.unit_price),0)::bigint AS total
    FROM orders o LEFT JOIN order_items i ON i.order_id=o.id
    LEFT JOIN meals m ON m.batch_id=i.batch_id AND m.id=i.meal_id
    WHERE o.batch_id=$1 ${guestHash ? 'AND o.guest_hash=$2' : ''}
    GROUP BY o.id ORDER BY o.created_at,o.id`, parameters);
  return result.rows.map((order) => ({ ...order, total: Number(order.total) }));
}
async function ownOrder(db, id, guestHash) {
  parse(uuid, id);
  const order = (await db.query('SELECT * FROM orders WHERE id=$1 AND guest_hash=$2', [id, guestHash])).rows[0];
  if (!order) fail(404, 'Ваша заявка не найдена.', 'NOT_FOUND');
  return order;
}
async function publicState(db, guestHash) {
  const batch = await newestBatch(db);
  if (!batch) return { batch: null, meals: [], totals: await totalsFor(db, null), myOrder: null };
  const [meals, totals, own] = await Promise.all([mealsFor(db, batch.id), totalsFor(db, batch), ordersFor(db, batch.id, guestHash)]);
  return { batch: serializeBatch(batch), meals, totals, myOrder: own[0] ?? null };
}

export function createApp({ pool, staticDir, logger = console } = {}) {
  if (!pool) throw new Error('Database pool is required');
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
  app.use(helmet({ strictTransportSecurity: false, contentSecurityPolicy: { directives: { upgradeInsecureRequests: null, imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"] } } }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const limitOptions = { windowMs: 15 * 60 * 1000, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Слишком много запросов. Повторите позже.', code: 'RATE_LIMIT' } };
  const readLimiter = rateLimit({ ...limitOptions, limit: 50000 });
  const writeLimiter = rateLimit({ ...limitOptions, limit: 500 });
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD'].includes(req.method)) return readLimiter(req, res, next);
    if (req.path === '/supplier/login') return next();
    return writeLimiter(req, res, next);
  });
  app.use('/api', checkOrigin);
  app.use(express.json({ limit: '32kb' }));

  const guest = async (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[guestCookie];
    if (validToken(token)) {
      const hash = hashToken(token);
      const valid = await pool.query('SELECT 1 FROM guest_sessions WHERE token_hash=$1 AND expires_at>now()', [hash]);
      if (valid.rowCount) { req.guestHash = hash; return next(); }
    }
    const created = opaqueToken();
    req.guestHash = hashToken(created);
    await pool.query('INSERT INTO guest_sessions (token_hash,expires_at) VALUES ($1,now()+interval \'180 days\')', [req.guestHash]);
    res.cookie(guestCookie, created, cookieOptions(req, 180 * DAY));
    next();
  };
  const supplier = async (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[supplierCookie];
    if (!validToken(token)) fail(401, 'Войдите в кабинет поставщика.', 'AUTH_REQUIRED');
    const result = await pool.query(`SELECT s.id,s.login FROM supplier_sessions ss JOIN suppliers s ON s.id=ss.supplier_id
      WHERE ss.token_hash=$1 AND ss.expires_at>now()`, [hashToken(token)]);
    if (!result.rowCount) fail(401, 'Войдите в кабинет поставщика.', 'AUTH_REQUIRED');
    req.supplier = result.rows[0];
    req.supplierSessionHash = hashToken(token);
    next();
  };

  app.get('/api/health', async (_req, res) => { await pool.query('SELECT 1'); res.json({ status: 'ok' }); });
  app.get('/api/state', guest, async (req, res) => { res.json(await publicState(pool, req.guestHash)); });
  app.get('/api/orders/history', guest, async (req, res) => {
    const { rows } = await pool.query(`SELECT b.id AS batch_id,b.title,b.delivery_at,b.status,
      o.id,o.name,o.department,o.payment AS "paymentStatus",
      COALESCE(jsonb_agg(jsonb_build_object('mealId',i.meal_id,'name',m.name,'quantity',i.quantity,'price',i.unit_price) ORDER BY m.position)
        FILTER (WHERE i.meal_id IS NOT NULL),'[]'::jsonb) AS items,
      COALESCE(sum(i.quantity*i.unit_price),0)::bigint AS total
      FROM orders o JOIN batches b ON b.id=o.batch_id
      LEFT JOIN order_items i ON i.order_id=o.id LEFT JOIN meals m ON m.batch_id=i.batch_id AND m.id=i.meal_id
      WHERE o.guest_hash=$1 AND b.id<>(SELECT id FROM batches ORDER BY created_at DESC,id DESC LIMIT 1)
      GROUP BY b.id,o.id ORDER BY b.created_at DESC,o.created_at DESC LIMIT 20`, [req.guestHash]);
    res.json({ orders: rows.map((row) => ({
      batch: { id: row.batch_id, title: row.title, deliveryAt: row.delivery_at.toISOString(), status: row.status },
      order: { id: row.id, name: row.name, department: row.department, paymentStatus: row.paymentStatus, items: row.items, total: Number(row.total) },
    })) });
  });
  app.post('/api/orders', guest, async (req, res) => {
    const input = parse(orderInput, req.body);
    const mealIds = input.items.map((item) => item.mealId);
    if (new Set(mealIds).size !== mealIds.length) fail(400, 'Блюдо указано дважды.');
    await transaction(pool, async (db) => {
      const batch = await lockedBatch(db, input.batchId);
      ensureOrderDeadline(batch);
      const previous = (await db.query('SELECT * FROM orders WHERE batch_id=$1 AND guest_hash=$2', [batch.id, req.guestHash])).rows[0];
      if (previous && previous.payment !== 'unpaid') fail(409, 'После отправки оплаты изменить заявку нельзя.', 'ORDER_LOCKED');
      const meals = await mealsFor(db, batch.id);
      const byId = new Map(meals.map((meal) => [meal.id, meal]));
      if (mealIds.some((id) => !byId.has(id))) fail(400, 'Выбранного блюда нет в этом меню.');
      if (input.items.reduce((sum, item) => sum + item.quantity, 0) > 20) fail(400, 'В одной заявке может быть не больше 20 порций.');
      const id = previous?.id || randomUUID();
      if (previous) {
        await db.query('UPDATE orders SET name=$2,department=$3,updated_at=now() WHERE id=$1', [id, input.name, input.department]);
        await db.query('DELETE FROM order_items WHERE order_id=$1', [id]);
      } else {
        await db.query('INSERT INTO orders(id,batch_id,guest_hash,name,department) VALUES($1,$2,$3,$4,$5)', [id, batch.id, req.guestHash, input.name, input.department]);
      }
      for (const item of input.items) await db.query('INSERT INTO order_items(order_id,batch_id,meal_id,quantity,unit_price) VALUES($1,$2,$3,$4,$5)', [id, batch.id, item.mealId, item.quantity, byId.get(item.mealId).price]);
      const totals = await totalsFor(db, batch);
      if (!batch.payment_opened && totals.participants >= batch.min_participants) await db.query('UPDATE batches SET payment_opened=true WHERE id=$1', [batch.id]);
    });
    res.json({ ok: true });
  });
  app.delete('/api/orders/:id', guest, async (req, res) => {
    await transaction(pool, async (db) => {
      const original = await ownOrder(db, req.params.id, req.guestHash);
      const batch = await lockedBatch(db, original.batch_id);
      ensureOrderDeadline(batch);
      const order = await ownOrder(db, req.params.id, req.guestHash);
      if (order.payment !== 'unpaid') fail(409, 'Заявку с отправленной оплатой отменяет поставщик.', 'ORDER_LOCKED');
      await db.query('DELETE FROM orders WHERE id=$1', [order.id]);
    });
    res.json({ ok: true });
  });
  app.post('/api/orders/:id/payment', guest, async (req, res) => {
    parse(z.object({}).strict(), req.body);
    await transaction(pool, async (db) => {
      const original = await ownOrder(db, req.params.id, req.guestHash);
      const batch = await lockedBatch(db, original.batch_id);
      ensureOpen(batch);
      if (!batch.payment_opened) fail(409, 'Оплата откроется после набора группы.', 'PAYMENT_CLOSED');
      if (Date.now() >= batch.payment_deadline.getTime()) fail(409, 'Время оплаты закончилось.', 'PAYMENT_DEADLINE');
      const order = await ownOrder(db, req.params.id, req.guestHash);
      if (order.payment !== 'unpaid') fail(409, 'Оплата уже отправлена на проверку.', 'ORDER_LOCKED');
      await db.query("UPDATE orders SET payment='pending',updated_at=now() WHERE id=$1", [order.id]);
    });
    res.json({ ok: true });
  });

  app.get('/api/supplier/session', async (req, res) => {
    const token = parseCookies(req.headers.cookie)[supplierCookie];
    if (!validToken(token)) return res.json({ authenticated: false });
    const result = await pool.query('SELECT s.login FROM supplier_sessions ss JOIN suppliers s ON s.id=ss.supplier_id WHERE ss.token_hash=$1 AND ss.expires_at>now()', [hashToken(token)]);
    res.json(result.rowCount ? { authenticated: true, login: result.rows[0].login } : { authenticated: false });
  });
  app.post('/api/supplier/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Слишком много попыток входа. Повторите через 15 минут.', code: 'LOGIN_RATE_LIMIT' } }), async (req, res) => {
    const input = parse(z.object({ login: nonempty(100), password: z.string().min(1).max(128) }).strict(), req.body);
    const found = (await pool.query('SELECT * FROM suppliers WHERE login=$1', [input.login])).rows[0];
    const dummyHash = 'scrypt$00000000000000000000000000000000$' + '00'.repeat(64);
    const valid = await verifyPassword(input.password, found?.password_hash || dummyHash);
    if (!found || !valid) fail(401, 'Неверный логин или пароль.', 'INVALID_CREDENTIALS');
    const token = opaqueToken();
    await transaction(pool, async (db) => {
      await db.query('DELETE FROM supplier_sessions WHERE expires_at<=now()');
      const locked = (await db.query('SELECT password_hash FROM suppliers WHERE id=$1 FOR UPDATE', [found.id])).rows[0];
      if (locked.password_hash !== found.password_hash) fail(401, 'Неверный логин или пароль.', 'INVALID_CREDENTIALS');
      await db.query('INSERT INTO supplier_sessions(token_hash,supplier_id,expires_at) VALUES($1,$2,now()+interval \'7 days\')', [hashToken(token), found.id]);
    });
    res.cookie(supplierCookie, token, cookieOptions(req, 7 * DAY));
    res.json({ authenticated: true, login: found.login });
  });
  app.post('/api/supplier/logout', supplier, async (req, res) => {
    parse(z.object({}).strict(), req.body);
    await pool.query('DELETE FROM supplier_sessions WHERE token_hash=$1', [req.supplierSessionHash]);
    res.clearCookie(supplierCookie, cookieOptions(req));
    res.json({ ok: true });
  });
  app.post('/api/supplier/password', supplier, async (req, res) => {
    const input = parse(z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12).max(128) }).strict(), req.body);
    await transaction(pool, async (db) => {
      const found = (await db.query('SELECT password_hash FROM suppliers WHERE id=$1 FOR UPDATE', [req.supplier.id])).rows[0];
      if (!await verifyPassword(input.currentPassword, found.password_hash)) fail(401, 'Текущий пароль неверен.', 'INVALID_CREDENTIALS');
      await db.query('UPDATE suppliers SET password_hash=$2 WHERE id=$1', [req.supplier.id, await hashPassword(input.newPassword)]);
      await db.query('DELETE FROM supplier_sessions WHERE supplier_id=$1', [req.supplier.id]);
    });
    res.clearCookie(supplierCookie, cookieOptions(req));
    res.json({ ok: true });
  });
  app.get('/api/supplier/dashboard', supplier, async (req, res) => {
    let batch;
    if (req.query.batchId) {
      const id = parse(uuid, req.query.batchId);
      batch = (await pool.query('SELECT * FROM batches WHERE id=$1', [id])).rows[0];
      if (!batch) fail(404, 'Заказ на доставку не найден.', 'NOT_FOUND');
    } else batch = await newestBatch(pool);
    const history = (await pool.query(`SELECT b.id,b.title,b.delivery_at AS "deliveryAt",b.status,
      count(o.id) FILTER (WHERE o.payment='refund_due')::int AS "refundDueCount"
      FROM batches b LEFT JOIN orders o ON o.batch_id=b.id GROUP BY b.id ORDER BY b.created_at DESC,b.id DESC LIMIT 100`)).rows;
    if (!batch) return res.json({ batch: null, meals: [], totals: await totalsFor(pool, null), orders: [], history });
    const [meals, totals, orders] = await Promise.all([mealsFor(pool, batch.id), totalsFor(pool, batch), ordersFor(pool, batch.id)]);
    res.json({ batch: serializeBatch(batch), meals, totals, orders, history });
  });

  for (const [action, from, to] of [['confirm', 'pending', 'paid'], ['reject', 'pending', 'unpaid'], ['refund', 'refund_due', 'refunded']]) {
    app.post(`/api/supplier/orders/:id/${action}`, supplier, async (req, res) => {
      parse(z.object({}).strict(), req.body);
      parse(uuid, req.params.id);
      await transaction(pool, async (db) => {
        const original = (await db.query('SELECT * FROM orders WHERE id=$1', [req.params.id])).rows[0];
        if (!original) fail(404, 'Заявка не найдена.', 'NOT_FOUND');
        const batch = await lockedBatch(db, original.batch_id);
        if (action !== 'refund') ensureOpen(batch);
        if (action === 'refund' && batch.status !== 'cancelled') fail(409, 'Возврат доступен после отмены доставки.');
        const order = (await db.query('SELECT * FROM orders WHERE id=$1', [original.id])).rows[0];
        if (!order) fail(404, 'Заявка не найдена.', 'NOT_FOUND');
        if (order.payment !== from) fail(409, 'Статус оплаты уже изменился.', 'PAYMENT_CONFLICT');
        await db.query('UPDATE orders SET payment=$2,updated_at=now() WHERE id=$1', [order.id, to]);
      });
      res.json({ ok: true });
    });
  }
  for (const action of ['accept', 'cancel']) {
    app.post(`/api/supplier/batches/:id/${action}`, supplier, async (req, res) => {
      parse(z.object({}).strict(), req.body);
      await transaction(pool, async (db) => {
        const batch = await lockedBatch(db, req.params.id);
        ensureOpen(batch);
        const totals = await totalsFor(db, batch);
        if (totals.pendingCount > 0) fail(409, 'Сначала проверьте все переводы на рассмотрении.', 'PENDING_PAYMENTS');
        if (action === 'accept' && totals.paidPortions < batch.min_paid_portions) fail(409, 'Пока недостаточно оплаченных порций.', 'MINIMUM_NOT_REACHED');
        await db.query('UPDATE batches SET status=$2,accepted_at=CASE WHEN $2=\'accepted\' THEN now() ELSE NULL END WHERE id=$1', [batch.id, action === 'accept' ? 'accepted' : 'cancelled']);
        if (action === 'cancel') await db.query("UPDATE orders SET payment='refund_due',updated_at=now() WHERE batch_id=$1 AND payment='paid'", [batch.id]);
      });
      res.json({ ok: true });
    });
  }
  app.post('/api/supplier/batches', supplier, async (req, res) => {
    const input = parse(batchInput, req.body);
    if (Date.parse(input.orderDeadline) <= Date.now() || Date.parse(input.paymentDeadline) < Date.parse(input.orderDeadline) || Date.parse(input.deliveryAt) <= Date.parse(input.paymentDeadline)) fail(400, 'Укажите будущий приём заявок, затем оплату, затем доставку.', 'INVALID_DEADLINES');
    const id = randomUUID();
    await transaction(pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(780301194)');
      const newest = await newestBatch(db);
      if (newest) {
        const locked = await lockedBatch(db, newest.id);
        if (locked.status === 'open') fail(409, 'Сначала примите или отмените текущую доставку.', 'ACTIVE_BATCH_EXISTS');
      }
      await db.query(`INSERT INTO batches(id,title,order_date,office,delivery_at,order_deadline,payment_deadline,min_participants,min_paid_portions,payment_instructions)
        VALUES($1,$2,($3::timestamptz AT TIME ZONE 'Asia/Almaty')::date,$4,$3,$5,$6,$7,$8,$9)`,
      [id, input.title, input.deliveryAt, input.office, input.orderDeadline, input.paymentDeadline, input.minParticipants, input.minPaidPortions, input.paymentInstructions]);
      await insertMeals(db, id, input.meals.map((meal, index) => ({ ...meal, id: `meal-${index + 1}` })));
    });
    res.status(201).json({ id });
  });

  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Маршрут не найден.', code: 'NOT_FOUND' }); });
  if (staticDir) {
    app.use(express.static(staticDir, { index: 'index.html', maxAge: '1h', setHeaders: (res, path) => { if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
    app.get('/{*path}', (_req, res) => { res.sendFile('index.html', { root: staticDir }); });
  }
  app.use((error, _req, res, _next) => {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON.', code: 'INVALID_JSON' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос.', code: 'BODY_TOO_LARGE' });
    logger.error('Request failed', { name: error.name, code: error.code });
    res.status(500).json({ error: 'Не удалось выполнить запрос. Повторите позже.', code: 'INTERNAL_ERROR' });
  });
  return app;
}
