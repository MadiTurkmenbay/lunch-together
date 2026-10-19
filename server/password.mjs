import { hashPassword } from './security.mjs';

const password = process.env.PASSWORD;
if (!password || password.length < 12) {
  process.stderr.write('Set PASSWORD to a password of at least 12 characters.\n');
  process.exit(1);
}
process.stdout.write(`${await hashPassword(password)}\n`);
