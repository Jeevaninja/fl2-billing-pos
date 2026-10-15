/**
 * Manage paired Captain handsets.
 *
 *   npm run captain:devices -- pair <id> "<label>"   prints the new token once
 *   npm run captain:devices -- revoke <id>
 *   npm run captain:devices -- list
 *
 * File: FL2_CAPTAIN_DEVICES (default .data/captain-devices.json). A running server picks up
 * changes on the next request.
 */
import { listDevices, pairDevice, revokeDevice } from './captain-devices.js';

const file = process.env.FL2_CAPTAIN_DEVICES ?? '.data/captain-devices.json';
const [command, id, ...labelParts] = process.argv.slice(2);

try {
  if (command === 'pair' && id) {
    const { token, record } = pairDevice(file, id, labelParts.join(' ') || id);
    console.log(`Paired ${record.id} (${record.label}). Enter this token in the handset — it is not stored and will not be shown again:\n\n  ${token}\n`);
  } else if (command === 'revoke' && id) {
    revokeDevice(file, id);
    console.log(`Revoked ${id}. Its token stops working on the next request.`);
  } else if (command === 'list') {
    for (const d of listDevices(file)) console.log(`${d.active ? 'active ' : 'revoked'}  ${d.id.padEnd(20)} ${d.label}  (paired ${d.pairedAt})`);
  } else {
    console.error('usage: captain:devices -- pair <id> "<label>" | revoke <id> | list');
    process.exitCode = 2;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
