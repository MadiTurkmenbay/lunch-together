import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
}

export async function transaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function migrate(pool) {
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(780301193)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = fileURLToPath(new URL('./migrations/', import.meta.url));
    const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const name of files) {
      const existing = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (existing.rowCount) continue;
      await client.query(await readFile(`${directory}/${name}`, 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    }
  });
}

export const seedMeals = [
  { id: 'chicken', name: 'Курица с рисом', description: 'Курица, рассыпчатый рис, яйцо и свежий огурец', tag: 'Выбор команды', image: 'chicken.jpg', details: 'Комплекс · 420 г', price: 1100 },
  { id: 'cutlets', name: 'Котлета с пюре', description: 'Куриная котлета, картофельное пюре и грибной соус', tag: 'Как дома', image: 'cutlets.jpg', details: 'Комплекс · 450 г', price: 1100 },
  { id: 'veggie', name: 'Овощной боул', description: 'Капуста, морковь, зелёный горошек и сладкий перец', tag: 'Без мяса', image: 'veggie.jpg', details: 'Комплекс · 380 г', price: 1100 },
];

export async function insertMeals(client, batchId, meals) {
  for (const [position, meal] of meals.entries()) {
    await client.query(`INSERT INTO meals (batch_id, id, name, description, tag, image, details, price, position)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [batchId, meal.id, meal.name, meal.description, meal.tag ?? '', meal.image ?? '', meal.details ?? '', meal.price, position]);
  }
}

export async function seed(pool) {
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(780301193)');
    const suppliers = await client.query('SELECT 1 FROM suppliers LIMIT 1');
    if (!suppliers.rowCount) {
      const login = process.env.SUPPLIER_LOGIN || 'azat';
      const passwordHash = process.env.SUPPLIER_PASSWORD_HASH;
      if (!/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(passwordHash ?? '')) throw new Error('SUPPLIER_PASSWORD_HASH must be a valid scrypt hash');
      await client.query('INSERT INTO suppliers (id, login, password_hash) VALUES ($1, $2, $3)', [randomUUID(), login, passwordHash]);
    }
    const batches = await client.query('SELECT 1 FROM batches LIMIT 1');
    if (!batches.rowCount) {
      const nextDay = new Date(Date.now() + 86400000);
      const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).format(nextDay);
      const batchId = randomUUID();
      await client.query(`INSERT INTO batches (id, title, order_date, office, delivery_at, order_deadline, payment_deadline, payment_instructions)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [batchId, 'Обеды в офис', date, 'Уточняется организатором', `${date}T12:30:00+05:00`, `${date}T10:30:00+05:00`, `${date}T11:00:00+05:00`, process.env.PAYMENT_INSTRUCTIONS || 'Реквизиты оплаты уточните у поставщика. После перевода нажмите «Я оплатил».']);
      await insertMeals(client, batchId, seedMeals.map((meal) => ({ ...meal, image: `/assets/${meal.image}` })));
    }
    // Only fill an empty catalog on first setup; archived dishes stay archived on restarts.
    await client.query(`INSERT INTO dish_catalog(id,supplier_id,name,description,tag,image,details,price)
      SELECT gen_random_uuid(),s.id,m.name,m.description,m.tag,m.image,m.details,m.price
      FROM suppliers s CROSS JOIN (
        SELECT DISTINCT ON (lower(trim(m.name))) m.* FROM meals m JOIN batches b ON b.id=m.batch_id
        ORDER BY lower(trim(m.name)),b.created_at DESC,b.id DESC,m.position
      ) m WHERE NOT EXISTS (SELECT 1 FROM dish_catalog d WHERE d.supplier_id=s.id)`);
  });
}
