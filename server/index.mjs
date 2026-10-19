import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createPool, migrate, seed } from './db.mjs';
import { createApp } from './app.mjs';
import { createPhotoStorage } from './photo-storage.mjs';

const pool = createPool();
const storage = createPhotoStorage();
try {
  await migrate(pool);
  await seed(pool);
  const app = createApp({ pool, storage, staticDir: fileURLToPath(new URL('../build/client/', import.meta.url)) });
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, '0.0.0.0', () => { console.info(`Lunch Together listening on port ${port}`); });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(async () => { await pool.end(); storage?.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  console.error('Startup failed', { name: error.name, code: error.code, message: error.code ? 'Database initialization failed' : error.message });
  await pool.end();
  process.exit(1);
}
