import { randomBytes, scryptSync } from 'node:crypto';
import { mkdir, open, chmod, writeFile } from 'node:fs/promises';
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16).toString('hex');
const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
const dbPassword = randomBytes(32).toString('hex');
const contents = `APP_PORT=3080\nBIND_ADDRESS=0.0.0.0\nPOSTGRES_PASSWORD=${dbPassword}\nDATABASE_URL=postgresql://lunch:${dbPassword}@127.0.0.1:55435/lunch\nSUPPLIER_LOGIN=supplier\nSUPPLIER_PASSWORD_HASH='${hash}'\nAPP_ORIGIN=\nTRUST_PROXY=172.16.80.1/32\n`;
let file;
try { file = await open('.env', 'wx', 0o600); }
catch (error) { if (error.code === 'EEXIST') { console.error('.env уже существует. Существующие настройки не изменены.'); process.exit(1); } throw error; }
try { await file.writeFile(contents); } finally { await file.close(); }
await mkdir('work', { recursive: true });
await writeFile('work/supplier-access.txt', `Обед вместе — доступ поставщика\n\nЛогин: supplier\nПароль: ${password}\n\nВход: /#supplier\nСменить пароль можно в кабинете. Файл не добавлять в Git.\n`, { mode: 0o600 });
await chmod('work/supplier-access.txt', 0o600);
console.log('Созданы .env и work/supplier-access.txt (права 600). Пароль не выводится в консоль.');
