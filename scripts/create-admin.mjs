import bcrypt from 'bcryptjs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';

const rl = createInterface({ input: stdin, output: stdout });
const ask = (question) => rl.question(question);

function askSecret(question) {
  return new Promise((resolve) => {
    stdout.write(question);
    let value = '';
    const onData = (buffer) => {
      for (const character of buffer.toString()) {
        if (character === '\r' || character === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(value);
        } else if (character === '\u0003') {
          process.exit(130);
        } else if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

try {
  const email = (await ask('Admin email address: ')).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  const password = await askSecret('Create admin password (12+ characters; input hidden): ');
  if (password.length < 12) throw new Error('Use at least 12 characters for the admin password.');
  const hash = await bcrypt.hash(password, 12);
  let existing = '';
  try { existing = await readFile('.env', 'utf8'); } catch {}
  const lines = existing.split(/\r?\n/).filter((line) => !line.startsWith('ADMIN_EMAIL=') && !line.startsWith('ADMIN_PASSWORD_HASH='));
  lines.push(`ADMIN_EMAIL=${email}`, `ADMIN_PASSWORD_HASH=${hash}`);
  await writeFile('.env', `${lines.filter(Boolean).join('\n')}\n`, { mode: 0o600 });
  console.log(`Admin account configured for ${email}. Your password is stored only as a bcrypt hash in the ignored .env file.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
