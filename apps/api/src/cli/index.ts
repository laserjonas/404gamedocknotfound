/**
 * GameDock admin CLI.
 *
 * Usage (from the repo root):
 *   pnpm gamedock user:create-admin
 *   pnpm gamedock user:reset-password <username>
 *   pnpm gamedock doctor
 *   pnpm gamedock instances:list
 *   pnpm gamedock repair-permissions
 */
import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, sqlitePathFromUrl } from '../config.js';
import { createDatabase } from '../db/database.js';
import { runMigrations } from '../db/migrations.js';
import { UserRepository } from '../db/repositories/users.js';
import { InstanceRepository } from '../db/repositories/instances.js';
import { hashPassword, validatePasswordPolicy } from '../auth/passwords.js';
import { checkDependencies } from '../services/systemStats.js';
import { builtinTemplateDir, loadTemplates } from '@gamedock/game-templates';

/**
 * A piped (non-TTY) stdin delivers all buffered lines' 'line' events
 * synchronously in one tick. Sequential readline.question() calls only
 * attach a listener for one line at a time, so any line emitted before the
 * next question() call is issued is lost. A persistent 'line' listener that
 * queues lines (and any resolvers waiting on them) avoids that race.
 */
let nonTtyInterface: Interface | null = null;
const nonTtyBufferedLines: string[] = [];
const nonTtyWaiters: ((line: string) => void)[] = [];

function readNonTtyLine(): Promise<string> {
  if (!nonTtyInterface) {
    nonTtyInterface = createInterface({ input: process.stdin, terminal: false });
    nonTtyInterface.on('line', (line) => {
      const waiter = nonTtyWaiters.shift();
      if (waiter) waiter(line);
      else nonTtyBufferedLines.push(line);
    });
  }
  if (nonTtyBufferedLines.length > 0) {
    return Promise.resolve(nonTtyBufferedLines.shift()!);
  }
  return new Promise((resolve) => nonTtyWaiters.push(resolve));
}

async function prompt(question: string, hidden = false): Promise<string> {
  // Masking keystrokes only makes sense for a real interactive terminal.
  // Over a non-TTY stdin (piped input, e.g. automated deployment scripts),
  // readline's "terminal: true" redraw logic corrupts the input instead of
  // masking it, so fall back to plain line reading via a persistent queue.
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
    const answer = await readNonTtyLine();
    return answer.trim();
  }

  return new Promise((resolve) => {
    const muted = { active: false };
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (!muted.active) process.stdout.write(chunk);
        callback();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
    if (hidden) muted.active = true;
  });
}

async function promptPassword(): Promise<string> {
  for (;;) {
    const password = await prompt('Password (min. 10 chars): ', true);
    const policyError = validatePasswordPolicy(password);
    if (policyError) {
      console.error(policyError);
      continue;
    }
    const confirm = await prompt('Confirm password: ', true);
    if (password !== confirm) {
      console.error('Passwords do not match, try again.');
      continue;
    }
    return password;
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const config = loadConfig();

  const openDb = async () => {
    const db = createDatabase(config.databaseUrl, config.dataDir);
    await runMigrations(db);
    return db;
  };

  switch (command) {
    case 'user:create-admin': {
      const db = await openDb();
      const users = new UserRepository(db);
      const username = args[0] ?? (await prompt('Admin username: '));
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,63}$/.test(username)) {
        console.error('Invalid username (2-64 chars, alphanumeric plus _.-).');
        process.exit(1);
      }
      if (await users.findByUsername(username)) {
        console.error(`User "${username}" already exists.`);
        process.exit(1);
      }
      const password = await promptPassword();
      await users.create(username, await hashPassword(password), 'admin');
      console.log(`Admin user "${username}" created.`);
      await db.close();
      break;
    }

    case 'user:reset-password': {
      const db = await openDb();
      const users = new UserRepository(db);
      const username = args[0] ?? (await prompt('Username: '));
      const user = await users.findByUsername(username);
      if (!user) {
        console.error(`User "${username}" not found.`);
        process.exit(1);
      }
      const password = await promptPassword();
      await users.update(user.id, { passwordHash: await hashPassword(password) });
      // Invalidate all sessions for that user.
      await db.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
      console.log(`Password for "${username}" reset. All their sessions were invalidated.`);
      await db.close();
      break;
    }

    case 'doctor': {
      console.log('GameDock doctor\n===============');
      console.log(`Node.js:        ${process.version}`);
      console.log(`Platform:       ${process.platform}`);
      console.log(
        `Data dir:       ${config.dataDir} ${existsSync(config.dataDir) ? '(ok)' : '(MISSING)'}`,
      );
      console.log(
        `Instance dir:   ${config.instanceDir} ${existsSync(config.instanceDir) ? '(ok)' : '(MISSING)'}`,
      );
      console.log(
        `Backup dir:     ${config.backupDir} ${existsSync(config.backupDir) ? '(ok)' : '(MISSING)'}`,
      );
      const dbPath = sqlitePathFromUrl(config.databaseUrl, config.dataDir);
      console.log(
        `Database:       ${dbPath} ${existsSync(dbPath) ? '(exists)' : '(will be created)'}`,
      );
      console.log('');

      const deps = await checkDependencies(config.steamcmdPath);
      for (const dep of deps) {
        const status = dep.found ? `OK  ${dep.path}` : `MISSING - ${dep.hint}`;
        console.log(`${dep.name.padEnd(10)} ${status}`);
      }
      console.log('');

      const { templates, errors } = loadTemplates([
        builtinTemplateDir(),
        join(config.dataDir, 'templates'),
      ]);
      console.log(
        `Templates:      ${templates.length} loaded (${templates.map((t) => t.id).join(', ')})`,
      );
      for (const err of errors) {
        console.log(`  WARNING: ${err.message}`);
      }

      const db = await openDb();
      const users = new UserRepository(db);
      const userCount = await users.count();
      if (userCount === 0) {
        console.log('\nNo users found. Create one with: pnpm gamedock user:create-admin');
      } else {
        console.log(`\nUsers:          ${userCount} (${await users.countAdmins()} active admins)`);
      }
      await db.close();
      break;
    }

    case 'instances:list': {
      const db = await openDb();
      const instances = new InstanceRepository(db);
      const rows = await instances.list();
      if (rows.length === 0) {
        console.log('No instances.');
      } else {
        console.log(
          'ID                                    NAME                  TEMPLATE            STATUS',
        );
        for (const row of rows) {
          console.log(
            `${row.id}  ${row.name.padEnd(20).slice(0, 20)}  ${row.template_id.padEnd(18).slice(0, 18)}  ${row.status}`,
          );
        }
      }
      await db.close();
      break;
    }

    case 'repair-permissions': {
      if (process.platform === 'win32') {
        console.log('repair-permissions is a no-op on Windows.');
        break;
      }
      // Tighten data dirs: owner rwx only (the gamedock user).
      const dirs = [config.dataDir, config.instanceDir, config.backupDir, config.logDir];
      for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        chmodSync(dir, 0o750);
        console.log(`chmod 750 ${dir}`);
      }
      const dbPath = sqlitePathFromUrl(config.databaseUrl, config.dataDir);
      if (existsSync(dbPath)) {
        chmodSync(dbPath, 0o600);
        console.log(`chmod 600 ${dbPath}`);
      }
      // Instance dirs: 750 each.
      if (existsSync(config.instanceDir)) {
        for (const entry of readdirSync(config.instanceDir)) {
          const p = join(config.instanceDir, entry);
          if (statSync(p).isDirectory()) {
            chmodSync(p, 0o750);
            console.log(`chmod 750 ${p}`);
          }
        }
      }
      console.log('Done. If files are owned by the wrong user, run as root:');
      console.log(`  chown -R gamedock:gamedock ${config.dataDir}`);
      break;
    }

    default:
      console.log(`GameDock CLI

Commands:
  user:create-admin [username]     Create the first admin user
  user:reset-password [username]   Reset a user's password
  doctor                           Check dependencies and configuration
  instances:list                   List server instances
  repair-permissions               Tighten file permissions on data dirs
`);
      if (command) {
        console.error(`Unknown command: ${command}`);
        process.exit(1);
      }
  }
}

main()
  .catch((err) => {
    console.error('Error:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    nonTtyInterface?.close();
  });
