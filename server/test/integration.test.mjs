import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../app.mjs';
import { migrate, seed } from '../db.mjs';
import { hashPassword } from '../security.mjs';

const database = process.env.TEST_DATABASE_URL;

test('real PostgreSQL: ownership, payment transitions, supplier sessions and concurrent requests', { skip: !database && 'Set TEST_DATABASE_URL to a disposable PostgreSQL database' }, async (t) => {
  const admin = new pg.Pool({ connectionString: database });
  const schema = `lt_test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  const oldHash = process.env.SUPPLIER_PASSWORD_HASH;
  const oldLogin = process.env.SUPPLIER_LOGIN;
  const oldOrigin = process.env.APP_ORIGIN;
  process.env.SUPPLIER_LOGIN = 'test-supplier';
  process.env.SUPPLIER_PASSWORD_HASH = await hashPassword('integration-password-123');
  delete process.env.APP_ORIGIN;
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    if (oldHash === undefined) delete process.env.SUPPLIER_PASSWORD_HASH; else process.env.SUPPLIER_PASSWORD_HASH = oldHash;
    if (oldLogin === undefined) delete process.env.SUPPLIER_LOGIN; else process.env.SUPPLIER_LOGIN = oldLogin;
    if (oldOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = oldOrigin;
  });
  await migrate(pool);
  await migrate(pool);
  await seed(pool);
  await seed(pool);
  server = createApp({ pool, logger: { error: (...args) => assert.fail(`Unexpected server error: ${JSON.stringify(args)}`) } }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    return async (path, options = {}) => {
      const { method = 'GET', body = {}, headers = {} } = options;
      const response = await fetch(`${origin}${path}`, {
        method, headers: { Cookie: [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; '), ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers },
        ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const separator = pair.indexOf('=');
        jar.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
      return { status: response.status, json: await response.json(), headers: response.headers };
    };
  };
  const a = client(); const b = client(); const supplier = client(); const stranger = client();
  const post = (body) => ({ method: 'POST', body });
  const state = async (who) => (await who('/api/state')).json;
  const dashboard = async (id) => (await supplier(`/api/supplier/dashboard${id ? `?batchId=${id}` : ''}`)).json;
  let first; let orderA; let orderB;

  await t.test('API enforces same origin and protects every supplier mutation', async () => {
    assert.equal((await a('/api/health')).json.status, 'ok');
    assert.equal((await stranger('/api/supplier/dashboard')).status, 401);
    for (const path of ['/api/supplier/logout', '/api/supplier/password', '/api/supplier/batches', '/api/supplier/orders/00000000-0000-4000-8000-000000000000/confirm', '/api/supplier/orders/00000000-0000-4000-8000-000000000000/reject', '/api/supplier/orders/00000000-0000-4000-8000-000000000000/refund', '/api/supplier/batches/00000000-0000-4000-8000-000000000000/accept', '/api/supplier/batches/00000000-0000-4000-8000-000000000000/cancel']) {
      assert.equal((await stranger(path, post({}))).status, 401, path);
    }
    assert.equal((await a('/api/orders', { ...post({}), headers: { Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await a('/api/orders', { ...post({}), headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await supplier('/api/supplier/login', post({ login: 'test-supplier', password: 'wrong' }))).status, 401);
    const login = await supplier('/api/supplier/login', post({ login: 'test-supplier', password: 'integration-password-123' }));
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.match(login.headers.get('set-cookie'), /SameSite=Lax/);
    assert.equal((await supplier('/api/supplier/session')).json.authenticated, true);
  });

  await t.test('guests get only own data; prices are server owned; payment opening latches', async () => {
    first = (await state(a)).batch;
    assert.equal((await state(a)).totals.participants, 0);
    await pool.query('UPDATE batches SET min_participants=2,min_paid_portions=2 WHERE id=$1', [first.id]);
    const invalid = { batchId: first.id, name: 'Private Alice', department: 'Secret team', items: [{ mealId: 'chicken', quantity: 1, price: 1 }] };
    assert.equal((await a('/api/orders', post(invalid))).status, 400);
    const inputA = { batchId: first.id, name: 'Private Alice', department: 'Secret team', items: [{ mealId: 'chicken', quantity: 1 }, { mealId: 'cutlets', quantity: 1 }] };
    assert.equal((await a('/api/orders', post(inputA))).status, 200);
    orderA = (await state(a)).myOrder;
    assert.equal(orderA.total, 2200);
    const publicB = await state(b);
    assert.equal(publicB.myOrder, null);
    assert.equal(publicB.orders, undefined);
    assert.ok(!JSON.stringify(publicB).includes('Private Alice'));
    assert.ok(!JSON.stringify(publicB).includes('Secret team'));
    assert.equal((await b(`/api/orders/${orderA.id}/payment`, post({}))).status, 404);
    assert.equal((await a(`/api/orders/${orderA.id}/payment`, post({}))).status, 409);
    assert.equal((await b('/api/orders', post({ batchId: first.id, name: 'Bob', department: '', items: [{ mealId: 'veggie', quantity: 1 }] }))).status, 200);
    orderB = (await state(b)).myOrder;
    assert.equal((await state(a)).totals.paymentOpen, true);
    assert.equal((await b(`/api/orders/${orderB.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await state(a)).totals.participants, 1);
    assert.equal((await state(a)).totals.paymentOpen, true);
    assert.equal((await b('/api/orders', post({ batchId: first.id, name: 'Bob', items: [{ mealId: 'veggie', quantity: 1 }] }))).status, 200);
    orderB = (await state(b)).myOrder;
  });

  await t.test('pending payments lock orders, concurrent confirmation applies once, acceptance freezes batch', async () => {
    assert.equal((await a(`/api/orders/${orderA.id}/payment`, post({}))).status, 200);
    assert.equal((await b(`/api/orders/${orderB.id}/payment`, post({}))).status, 200);
    assert.equal((await a(`/api/orders/${orderA.id}`, { method: 'DELETE' })).status, 409);
    assert.equal((await a('/api/orders', post({ batchId: first.id, name: 'Changed after payment', items: [{ mealId: 'chicken', quantity: 1 }] }))).status, 409);
    assert.equal((await supplier(`/api/supplier/batches/${first.id}/accept`, post({}))).json.code, 'PENDING_PAYMENTS');
    const confirmed = await Promise.all([supplier(`/api/supplier/orders/${orderA.id}/confirm`, post({})), supplier(`/api/supplier/orders/${orderA.id}/confirm`, post({}))]);
    assert.deepEqual(confirmed.map((result) => result.status).sort(), [200, 409]);
    assert.equal((await supplier(`/api/supplier/batches/${first.id}/cancel`, post({}))).json.code, 'PENDING_PAYMENTS');
    assert.equal((await supplier(`/api/supplier/orders/${orderB.id}/reject`, post({}))).status, 200);
    assert.equal((await supplier(`/api/supplier/batches/${first.id}/accept`, post({}))).status, 200);
    assert.equal((await state(a)).batch.status, 'accepted');
    assert.equal((await b(`/api/orders/${orderB.id}/payment`, post({}))).status, 409);
    assert.equal((await b(`/api/orders/${orderB.id}`, { method: 'DELETE' })).status, 409);
    assert.equal((await supplier(`/api/supplier/batches/${first.id}/cancel`, post({}))).status, 409);
    assert.equal((await dashboard()).totals.paidAmount, 2200);
  });

  const newBatch = () => ({
    title: 'Next office lunch', office: 'Office 1', deliveryAt: new Date(Date.now() + 4 * 3600000).toISOString(),
    orderDeadline: new Date(Date.now() + 3600000).toISOString(), paymentDeadline: new Date(Date.now() + 2 * 3600000).toISOString(),
    minParticipants: 1, minPaidPortions: 1, paymentInstructions: 'Transfer to supplier',
    meals: [{ name: 'Soup', description: 'Fresh soup', image: '/assets/veggie.jpg', tag: '', details: '300g', price: 1500 }],
  });
  await t.test('cancelled paid orders remain refundable through history after opening new batch', async () => {
    const created = await supplier('/api/supplier/batches', post(newBatch()));
    assert.equal(created.status, 201);
    const batchId = created.json.id;
    assert.equal((await supplier('/api/supplier/batches', post(newBatch()))).status, 409);
    assert.equal((await a('/api/orders', post({ batchId, name: 'Alice', items: [{ mealId: 'meal-1', quantity: 1 }] }))).status, 200);
    const mine = (await state(a)).myOrder;
    assert.equal((await a(`/api/orders/${mine.id}/payment`, post({}))).status, 200);
    assert.equal((await supplier(`/api/supplier/orders/${mine.id}/confirm`, post({}))).status, 200);
    assert.equal((await supplier(`/api/supplier/batches/${batchId}/cancel`, post({}))).status, 200);
    assert.equal((await state(a)).myOrder.paymentStatus, 'refund_due');
    assert.equal((await supplier('/api/supplier/batches', post(newBatch()))).status, 201);
    const guestHistory = (await a('/api/orders/history')).json.orders;
    const cancelledHistory = guestHistory.find((entry) => entry.batch.id === batchId);
    assert.equal(cancelledHistory.order.id, mine.id);
    assert.equal(cancelledHistory.order.paymentStatus, 'refund_due');
    assert.equal(cancelledHistory.order.total, 1500);
    assert.equal(cancelledHistory.batch.status, 'cancelled');
    assert.ok(!guestHistory.some((entry) => entry.order.name === 'Bob'));
    const bobHistory = (await b('/api/orders/history')).json.orders;
    assert.ok(!bobHistory.some((entry) => entry.order.id === mine.id));
    assert.equal((await stranger('/api/orders/history')).json.orders.length, 0);
    assert.equal((await dashboard()).history.find((entry) => entry.id === batchId).refundDueCount, 1);
    assert.equal((await supplier(`/api/supplier/orders/${mine.id}/refund`, post({}))).status, 200);
    assert.equal((await a('/api/orders/history')).json.orders.find((entry) => entry.batch.id === batchId).order.paymentStatus, 'refunded');
    assert.equal((await dashboard(batchId)).orders[0].paymentStatus, 'refunded');
    assert.equal((await dashboard()).history.find((entry) => entry.id === batchId).refundDueCount, 0);
  });

  await t.test('server deadlines apply and password change invalidates all sessions', async () => {
    const batch = (await state(a)).batch;
    await pool.query("UPDATE batches SET order_deadline=now()-interval '1 minute' WHERE id=$1", [batch.id]);
    assert.equal((await a('/api/orders', post({ batchId: batch.id, name: 'Late', items: [{ mealId: 'meal-1', quantity: 1 }] }))).json.code, 'ORDER_DEADLINE');
    await pool.query("UPDATE batches SET order_deadline=now()+interval '1 hour' WHERE id=$1", [batch.id]);
    assert.equal((await a('/api/orders', post({ batchId: batch.id, name: 'Alice', items: [{ mealId: 'meal-1', quantity: 1 }] }))).status, 200);
    const lateOrder = (await state(a)).myOrder;
    await pool.query("UPDATE batches SET order_deadline=now()-interval '1 minute',payment_deadline=now()-interval '30 seconds' WHERE id=$1", [batch.id]);
    assert.equal((await a(`/api/orders/${lateOrder.id}/payment`, post({}))).json.code, 'PAYMENT_DEADLINE');
    const secondSupplier = client();
    assert.equal((await secondSupplier('/api/supplier/login', post({ login: 'test-supplier', password: 'integration-password-123' }))).status, 200);
    assert.equal((await supplier('/api/supplier/password', post({ currentPassword: 'wrong', newPassword: 'new-password-123456' }))).status, 401);
    assert.equal((await supplier('/api/supplier/password', post({ currentPassword: 'integration-password-123', newPassword: 'new-password-123456' }))).status, 200);
    assert.equal((await supplier('/api/supplier/dashboard')).status, 401);
    assert.equal((await secondSupplier('/api/supplier/dashboard')).status, 401);
    assert.equal((await supplier('/api/supplier/login', post({ login: 'test-supplier', password: 'integration-password-123' }))).status, 401);
    assert.equal((await supplier('/api/supplier/login', post({ login: 'test-supplier', password: 'new-password-123456' }))).status, 200);
    await pool.query("UPDATE supplier_sessions SET expires_at=now()-interval '1 minute'");
    assert.equal((await supplier('/api/supplier/dashboard')).status, 401);
    assert.equal((await supplier('/api/supplier/login', post({ login: 'test-supplier', password: 'new-password-123456' }))).status, 200);
    assert.equal((await supplier('/api/supplier/logout', post({}))).status, 200);
    assert.equal((await supplier('/api/supplier/dashboard')).status, 401);
  });

  await t.test('credential guessing is throttled', async () => {
    let last;
    for (let attempt = 0; attempt < 11; attempt += 1) last = await stranger('/api/supplier/login', post({ login: 'test-supplier', password: 'wrong-password' }));
    assert.equal(last.status, 429);
    assert.equal(last.json.code, 'LOGIN_RATE_LIMIT');
  });
});
