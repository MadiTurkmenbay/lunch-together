import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../app.mjs';
import { migrate,seed } from '../db.mjs';
import { hashPassword } from '../security.mjs';

const database = process.env.TEST_DATABASE_URL;
test('menu planning: reusable dishes, private drafts, immutable snapshots and atomic publication',{ skip: !database && 'Set TEST_DATABASE_URL to a disposable PostgreSQL database' },async t => {
  const admin = new pg.Pool({ connectionString: database });
  const schema = `lt_plan_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: database,options: `-c search_path=${schema}` });
  const original = { ...process.env }; let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    for (const key of ['SUPPLIER_LOGIN','SUPPLIER_PASSWORD_HASH','APP_ORIGIN']) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
  });
  process.env.SUPPLIER_LOGIN = 'planner'; process.env.SUPPLIER_PASSWORD_HASH = await hashPassword('planner-password-123'); delete process.env.APP_ORIGIN;
  await migrate(pool); await seed(pool); await migrate(pool); await seed(pool);
  server = createApp({ pool,logger: { error: (...args) => assert.fail(JSON.stringify(args)) } }).listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  function client() {
    const cookies = new Map();
    return async (path,method='GET',body={}) => {
      const response = await fetch(`${origin}/api${path}`,{ method,headers: { Cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; '),...(method !== 'GET' ? { Origin: origin,'Content-Type': 'application/json' } : {}) },...(method !== 'GET' ? { body: JSON.stringify(body) } : {}) });
      for (const cookie of response.headers.getSetCookie()) { const [pair] = cookie.split(';'); const at = pair.indexOf('='); cookies.set(pair.slice(0,at),pair.slice(at+1)); }
      return { status: response.status,...await response.json() };
    };
  }
  const supplier = client(); const guest = client();
  const prefix = '/supplier/menu-plans'; const dishes = '/supplier/dishes';
  let dish,planId,batchId,first;
  const meal = { name: 'Суп',description: 'Свежий суп',tag: '',image: '/assets/veggie.jpg',details: '300 г',price: 1200 };
  const input = () => ({ title: 'Меню на завтра',office: 'Офис 7',orderDeadline: new Date(Date.now()+3600000).toISOString(),paymentDeadline: new Date(Date.now()+7200000).toISOString(),deliveryAt: new Date(Date.now()+10800000).toISOString(),minParticipants: 1,minPaidPortions: 1,paymentInstructions: 'Реквизиты',meals: [{ dishId: dish,price: 1250 }] });
  await t.test('all catalog and planning routes require authentication',async () => {
    for (const [path,method] of [[dishes,'GET'],[dishes,'POST'],[`${dishes}/${randomUUID()}`,'PUT'],[`${dishes}/${randomUUID()}`,'PATCH'],[prefix,'GET'],[prefix,'POST'],[`${prefix}/${randomUUID()}`,'GET'],[`${prefix}/${randomUUID()}`,'PUT'],[`${prefix}/${randomUUID()}/publish`,'POST']]) assert.equal((await guest(path,method)).status,401);
    assert.equal((await supplier('/supplier/login','POST',{ login: 'planner',password: 'planner-password-123' })).status,200);
    assert.equal((await supplier(dishes)).dishes.length,3);
    const created = await supplier(dishes,'POST',meal); assert.equal(created.status,201); dish = created.id;
  });
  await t.test('saving drafts alongside an open batch preserves its orders and public menu',async () => {
    first = await guest('/state');
    await guest('/orders','POST',{ batchId: first.batch.id,name: 'Guest',items: [{ mealId: first.meals[0].id,quantity: 1 }] });
    const created = await supplier(prefix,'POST',input()); assert.equal(created.status,201); planId = created.id;
    const publicState = await guest('/state');
    assert.equal(publicState.batch.id,first.batch.id); assert.equal(publicState.myOrder.total,1100); assert.deepEqual(publicState.meals,first.meals);
    assert.equal((await supplier(`${prefix}/${planId}/publish`,'POST')).code,'ACTIVE_BATCH_EXISTS');
    assert.equal((await supplier(prefix)).plans[0].mealCount,1);
    assert.equal((await guest('/orders/history')).orders.length,0);
  });
  await t.test('catalog editing and archiving keep saved snapshots; unavailable or foreign dishes are rejected',async () => {
    assert.equal((await supplier(`${dishes}/${dish}`,'PUT',{ ...meal,name: 'Другое название',price: 5000 })).status,200);
    let plan = (await supplier(`${prefix}/${planId}`)).plan;
    assert.equal(plan.meals[0].name,'Суп'); assert.equal(plan.meals[0].price,1250);
    assert.equal((await supplier(`${dishes}/${dish}`,'PATCH',{ archived: true })).status,200);
    assert.equal((await supplier(prefix,'POST',input())).code,'DISH_UNAVAILABLE');
    assert.equal((await supplier(`${prefix}/${planId}`,'PUT',{ ...input(),title: 'Обновлённое меню' })).status,200);
    plan = (await supplier(`${prefix}/${planId}`)).plan; assert.equal(plan.meals[0].name,'Суп');
    assert.equal((await supplier(`${dishes}/${dish}`,'PATCH',{ archived: false })).status,200);
    const secondSupplierId = randomUUID(); const foreignId = randomUUID();
    await pool.query('INSERT INTO suppliers(id,login,password_hash) VALUES($1,$2,$3)',[secondSupplierId,'other',process.env.SUPPLIER_PASSWORD_HASH]);
    await pool.query('INSERT INTO dish_catalog(id,supplier_id,name,description,image,price) VALUES($1,$2,$3,$4,$5,$6)',[foreignId,secondSupplierId,'Private dish','secret','/assets/veggie.jpg',1]);
    assert.ok(!(await supplier(dishes)).dishes.some(d => d.id === foreignId));
    assert.equal((await supplier(`${dishes}/${foreignId}`,'PUT',meal)).status,404);
    assert.equal((await supplier(`${dishes}/${foreignId}`,'PATCH',{ archived: true })).status,404);
    assert.equal((await supplier(prefix,'POST',{ ...input(),meals: [{ dishId: foreignId,price: 1 }] })).code,'DISH_UNAVAILABLE');
    const other = client(); await other('/supplier/login','POST',{ login: 'other',password: 'planner-password-123' });
    assert.equal((await other(`${prefix}/${planId}`)).status,404);
    assert.equal((await other(`${prefix}/${planId}`,'PUT',input())).status,404);
    assert.equal((await other(`${prefix}/${planId}/publish`,'POST')).status,404);
  });
  await t.test('invalid prices, duplicate selections and deadlines never create partial drafts',async () => {
    const before = (await supplier(prefix)).plans.length;
    assert.equal((await supplier(prefix,'POST',{ ...input(),meals: [{ dishId: dish,price: 1 },{ dishId: dish,price: 2 }] })).code,'DUPLICATE_DISH');
    assert.equal((await supplier(prefix,'POST',{ ...input(),meals: [{ dishId: dish,price: 0 }] })).status,400);
    assert.equal((await supplier(prefix,'POST',{ ...input(),orderDeadline: new Date(Date.now()-1).toISOString() })).code,'INVALID_DEADLINES');
    assert.equal((await supplier(prefix)).plans.length,before);
  });
  await t.test('concurrent publication creates exactly one public batch from saved prices',async () => {
    assert.equal((await supplier(`/supplier/batches/${first.batch.id}/cancel`,'POST')).status,200);
    const results = await Promise.all([supplier(`${prefix}/${planId}/publish`,'POST'),supplier(`${prefix}/${planId}/publish`,'POST')]);
    assert.deepEqual(results.map(r => r.status).sort(),[201,409]); batchId = results.find(r => r.status === 201).id;
    const publicState = await guest('/state'); assert.equal(publicState.batch.id,batchId); assert.equal(publicState.meals[0].name,'Суп'); assert.equal(publicState.meals[0].price,1250);
    assert.equal(publicState.myOrder,null); assert.equal((await guest('/orders/history')).orders[0].order.total,1100);
    assert.equal((await supplier(`${prefix}/${planId}`,'PUT',input())).code,'PLAN_PUBLISHED');
    assert.equal((await supplier(`${dishes}/${dish}`,'PUT',{ ...meal,price: 9000 })).status,200);
    assert.equal((await guest('/state')).meals[0].price,1250);
    const created = await supplier(prefix,'POST',input());
    await pool.query("UPDATE menu_plans SET order_deadline=now()-interval '1 minute' WHERE id=$1",[created.id]);
    await supplier(`/supplier/batches/${batchId}/cancel`,'POST');
    assert.equal((await supplier(`${prefix}/${created.id}/publish`,'POST')).code,'INVALID_DEADLINES');
  });
  await t.test('upgrade backfills existing menus without changing orders or duplicating dishes',async () => {
    // Replay the additive migration against populated legacy tables to exercise its upgrade path.
    await pool.query('DROP TABLE menu_plan_items,menu_plans,dish_catalog');
    await pool.query("DELETE FROM schema_migrations WHERE name='002_menu_planning.sql'");
    await migrate(pool); await migrate(pool); await seed(pool);
    const count = Number((await pool.query('SELECT count(*) FROM dish_catalog')).rows[0].count);
    assert.ok(count >= 4); assert.equal(Number((await pool.query('SELECT count(*) FROM orders')).rows[0].count),1);
    const snapshots = (await pool.query('SELECT price FROM meals WHERE batch_id=$1',[batchId])).rows; assert.equal(snapshots[0].price,1250);
    await seed(pool); assert.equal(Number((await pool.query('SELECT count(*) FROM dish_catalog')).rows[0].count),count);
  });
});
