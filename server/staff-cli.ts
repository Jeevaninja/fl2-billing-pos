/**
 * Staff credentials from the till machine (Phase 25, D6). Physical access to the till is the trust
 * boundary for creating the Super Admin and recovering a lost password.
 *
 *   npm run staff -- set-admin <username> ["<display name>"]   prompts for the password (twice, no echo)
 *   npm run staff -- set-pin "<staff name>"                    prompts for a 4–6 digit PIN (twice, no echo)
 *   npm run staff -- list
 *
 * Uses the same database as the API (DATABASE_URL, or PGlite under FL2_PGLITE_DIR). Embedded PGlite
 * allows one process at a time: stop the API first. Restart the API afterwards to drop old sessions.
 * Secrets are read from the terminal; when stdin is not a terminal, each prompt reads one line.
 */
import { createInterface } from 'node:readline';
import { AuthService } from '../src/services/index.js';
import { openDatabase } from './database.js';

/** Piped stdin: one reader for the whole run, so lines buffered after the first prompt aren't lost. */
let pipedLines: AsyncIterator<string> | undefined;

/** Reads one line without echoing it on a terminal. */
function readSecret(prompt: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    stdout.write(prompt);
    pipedLines ??= createInterface({ input: stdin, terminal: false })[Symbol.asyncIterator]();
    return pipedLines.next().then((r) => {
      stdout.write('\n');
      return r.done ? '' : r.value;
    });
  }
  return new Promise((resolve, reject) => {
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          done();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          done();
          stdout.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

async function confirmedSecret(label: string): Promise<string> {
  const noun = label === 'PIN' ? label : label.toLowerCase();
  const first = await readSecret(`${label}: `);
  const second = await readSecret(`Repeat ${noun}: `);
  if (first !== second) throw new Error(`the two ${noun}s did not match — nothing was changed`);
  return first;
}

const [command, ...args] = process.argv.slice(2);
const usage = 'usage: staff -- set-admin <username> ["<display name>"] | set-pin "<staff name>" | list';

if (command !== 'set-admin' && command !== 'set-pin' && command !== 'list') {
  console.error(usage);
  process.exit(2);
}

const { db, label, close } = await openDatabase();
const auth = new AuthService(db);
try {
  if (command === 'set-admin') {
    const [username, ...nameParts] = args;
    if (!username) throw new Error(usage);
    const password = await confirmedSecret('Password');
    const admin = await auth.setAdminPassword(username, password, nameParts.join(' ') || undefined);
    console.log(`${admin.displayName} (ADMIN) can now sign in as "${username.trim().toLowerCase()}" · ${label}. Restart the API to sign out old sessions.`);
  } else if (command === 'set-pin') {
    const name = args.join(' ');
    if (!name) throw new Error(usage);
    const matches = await auth.findStaffByName(name);
    if (matches.length === 0) throw new Error(`no staff member is named "${name}" (npm run staff -- list)`);
    if (matches.length > 1) throw new Error(`${matches.length} staff members are named "${name}": rename one in Settings → Staff & PINs`);
    const pin = await confirmedSecret('PIN');
    const staff = await auth.setPin(matches[0]!.id, pin);
    console.log(`PIN set for ${staff.displayName} (${staff.role}).`);
  } else {
    for (const s of await auth.listStaff()) {
      const flags = [s.isActive ? 'active' : 'inactive', s.hasPin ? 'PIN' : 'no PIN', s.username ? `signs in as ${s.username}` : ''].filter(Boolean);
      console.log(`${s.role.padEnd(8)} ${s.displayName.padEnd(30)} ${flags.join(' · ')}`);
    }
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await close();
}
