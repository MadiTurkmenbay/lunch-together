import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, insertMeals } from './db.mjs';
import { ensurePhotoOwned } from './photos.mjs';

export function validateDeadlines(input, fail) {
  if (Date.parse(input.orderDeadline) <= Date.now() || Date.parse(input.paymentDeadline) < Date.parse(input.orderDeadline) || Date.parse(input.deliveryAt) <= Date.parse(input.paymentDeadline)) {
    fail(400, 'Укажите будущий приём заявок, затем оплату, затем доставку.', 'INVALID_DEADLINES');
  }
}

// Both publication routes share the same lock and guard: one public batch at a time.
export async function publishBatch(db, input, fail, supplierId) {
  await db.query('SELECT pg_advisory_xact_lock(780301194)');
  validateDeadlines(input, fail);
  const current = (await db.query('SELECT status FROM batches ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE')).rows[0];
  if (current?.status === 'open') fail(409, 'Сначала примите или отмените текущую доставку. Черновик можно сохранить заранее.', 'ACTIVE_BATCH_EXISTS');
  for (const meal of input.meals) await ensurePhotoOwned(db,supplierId,meal.image,fail);
  const id = randomUUID();
  await db.query(`INSERT INTO batches(id,title,order_date,office,delivery_at,order_deadline,payment_deadline,min_participants,min_paid_portions,payment_instructions)
    VALUES($1,$2,($3::timestamptz AT TIME ZONE 'Asia/Almaty')::date,$4,$3,$5,$6,$7,$8,$9)`,
  [id,input.title,input.deliveryAt,input.office,input.orderDeadline,input.paymentDeadline,input.minParticipants,input.minPaidPortions,input.paymentInstructions]);
  await insertMeals(db,id,input.meals.map((meal,index) => ({ ...meal,id: `meal-${index+1}` })));
  return id;
}

const serialize = (row) => ({
  id: row.id, title: row.title, office: row.office, deliveryAt: row.delivery_at.toISOString(),
  orderDeadline: row.order_deadline.toISOString(), paymentDeadline: row.payment_deadline.toISOString(),
  minParticipants: row.min_participants, minPaidPortions: row.min_paid_portions,
  paymentInstructions: row.payment_instructions, publishedBatchId: row.published_batch_id,
});

export function registerMenuPlanning(app, { pool, supplier, parse, fail, mealInput, batchInput }) {
  const uuid = z.string().uuid();
  const planInput = batchInput.extend({ meals: z.array(z.object({ dishId: uuid, price: z.number().int().min(1).max(1000000) }).strict()).min(1).max(12) });
  const dishColumns = 'id,name,description,tag,image,details,price,archived';
  const planItems = async (db,id) => (await db.query('SELECT dish_id AS "dishId",name,description,tag,image,details,price FROM menu_plan_items WHERE plan_id=$1 ORDER BY position,dish_id',[id])).rows;
  async function ownPlan(db,id,supplierId,lock=false) {
    parse(uuid,id);
    const row = (await db.query(`SELECT * FROM menu_plans WHERE id=$1 AND supplier_id=$2${lock ? ' FOR UPDATE' : ''}`,[id,supplierId])).rows[0];
    if (!row) fail(404,'Меню не найдено.','NOT_FOUND');
    return row;
  }
  function editable(plan) {
    if (plan.published_batch_id) fail(409,'Меню уже опубликовано. Подготовьте новый черновик.','PLAN_PUBLISHED');
  }
  async function saveItems(db,planId,supplierId,items) {
    if (new Set(items.map(i => i.dishId)).size !== items.length) fail(400,'Одно блюдо можно выбрать только один раз.','DUPLICATE_DISH');
    const previous = new Map((await planItems(db,planId)).map(item => [item.dishId,item]));
    const dishes = (await db.query(`SELECT * FROM dish_catalog WHERE supplier_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`,[supplierId,items.map(i => i.dishId)])).rows;
    const catalog = new Map(dishes.map(d => [d.id,d]));
    const snapshots = items.map(item => {
      const dish = catalog.get(item.dishId);
      if (!dish || (dish.archived && !previous.has(item.dishId))) fail(400,'Выберите доступные блюда из своего пула.','DISH_UNAVAILABLE');
      // Catalog edits do not silently rewrite an already prepared menu.
      return { ...(previous.get(item.dishId) || dish), dishId: item.dishId, price: item.price };
    });
    await db.query('DELETE FROM menu_plan_items WHERE plan_id=$1',[planId]);
    for (const [position,item] of snapshots.entries()) {
      await db.query(`INSERT INTO menu_plan_items(plan_id,dish_id,position,name,description,tag,image,details,price) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [planId,item.dishId,position,item.name,item.description,item.tag,item.image,item.details,item.price]);
    }
  }

  app.get('/api/supplier/dishes',supplier,async (req,res) => {
    const result = await pool.query(`SELECT ${dishColumns} FROM dish_catalog WHERE supplier_id=$1 ORDER BY archived,lower(name),id`,[req.supplier.id]);
    res.json({ dishes: result.rows });
  });
  app.post('/api/supplier/dishes',supplier,async (req,res) => {
    const input = parse(mealInput,req.body); const id = randomUUID();
    await ensurePhotoOwned(pool,req.supplier.id,input.image,fail);
    await pool.query('INSERT INTO dish_catalog(id,supplier_id,name,description,tag,image,details,price) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,req.supplier.id,input.name,input.description,input.tag,input.image,input.details,input.price]);
    res.status(201).json({ id });
  });
  app.put('/api/supplier/dishes/:id',supplier,async (req,res) => {
    const id = parse(uuid,req.params.id); const input = parse(mealInput,req.body);
    await ensurePhotoOwned(pool,req.supplier.id,input.image,fail);
    const result = await pool.query(`UPDATE dish_catalog SET name=$3,description=$4,tag=$5,image=$6,details=$7,price=$8,updated_at=now() WHERE id=$1 AND supplier_id=$2 RETURNING id`,[id,req.supplier.id,input.name,input.description,input.tag,input.image,input.details,input.price]);
    if (!result.rowCount) fail(404,'Блюдо не найдено.','NOT_FOUND');
    res.json({ id });
  });
  app.patch('/api/supplier/dishes/:id',supplier,async (req,res) => {
    const id = parse(uuid,req.params.id); const input = parse(z.object({ archived: z.boolean() }).strict(),req.body);
    const result = await pool.query('UPDATE dish_catalog SET archived=$3,updated_at=now() WHERE id=$1 AND supplier_id=$2 RETURNING id',[id,req.supplier.id,input.archived]);
    if (!result.rowCount) fail(404,'Блюдо не найдено.','NOT_FOUND');
    res.json({ id });
  });

  app.get('/api/supplier/menu-plans',supplier,async (req,res) => {
    const rows = (await pool.query(`SELECT p.*, (SELECT count(*)::int FROM menu_plan_items i WHERE i.plan_id=p.id) AS meal_count FROM menu_plans p WHERE supplier_id=$1 ORDER BY delivery_at DESC,created_at DESC LIMIT 100`,[req.supplier.id])).rows;
    const current = (await pool.query('SELECT id,status FROM batches ORDER BY created_at DESC,id DESC LIMIT 1')).rows[0] ?? null;
    res.json({ plans: rows.map(p => ({ ...serialize(p),mealCount: p.meal_count })), activeBatch: current });
  });
  app.get('/api/supplier/menu-plans/:id',supplier,async (req,res) => {
    // A consistent snapshot prevents a concurrent save from mixing header and meal versions.
    const plan = await transaction(pool,async db => {
      const row = await ownPlan(db,req.params.id,req.supplier.id,true);
      return { ...serialize(row),meals: await planItems(db,row.id) };
    });
    res.json({ plan });
  });
  for (const method of ['post','put']) {
    app[method](`/api/supplier/menu-plans${method === 'put' ? '/:id' : ''}`,supplier,async (req,res) => {
      const input = parse(planInput,req.body); validateDeadlines(input,fail);
      const id = await transaction(pool,async db => {
        const id = method === 'put' ? (await ownPlan(db,req.params.id,req.supplier.id,true)).id : randomUUID();
        if (method === 'put') editable(await ownPlan(db,id,req.supplier.id));
        const values = [id,req.supplier.id,input.title,input.office,input.deliveryAt,input.orderDeadline,input.paymentDeadline,input.minParticipants,input.minPaidPortions,input.paymentInstructions];
        if (method === 'post') await db.query(`INSERT INTO menu_plans(id,supplier_id,title,office,delivery_at,order_deadline,payment_deadline,min_participants,min_paid_portions,payment_instructions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,values);
        else await db.query(`UPDATE menu_plans SET title=$3,office=$4,delivery_at=$5,order_deadline=$6,payment_deadline=$7,min_participants=$8,min_paid_portions=$9,payment_instructions=$10,updated_at=now() WHERE id=$1 AND supplier_id=$2`,values);
        await saveItems(db,id,req.supplier.id,input.meals);
        return id;
      });
      res.status(method === 'post' ? 201 : 200).json({ id });
    });
  }
  app.post('/api/supplier/menu-plans/:id/publish',supplier,async (req,res) => {
    parse(z.object({}).strict(),req.body);
    const id = await transaction(pool,async db => {
      const row = await ownPlan(db,req.params.id,req.supplier.id,true); editable(row);
      const input = { ...serialize(row),meals: await planItems(db,row.id) };
      if (!input.meals.length) fail(400,'Добавьте блюда в меню.','EMPTY_MENU');
      const batchId = await publishBatch(db,input,fail,req.supplier.id);
      await db.query('UPDATE menu_plans SET published_batch_id=$2,updated_at=now() WHERE id=$1',[row.id,batchId]);
      return batchId;
    });
    res.status(201).json({ id });
  });
}
