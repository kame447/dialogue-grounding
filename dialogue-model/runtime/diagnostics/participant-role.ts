import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listBaseOwners, openBaseFileStore } from '../web/base-assignment-store.ts';
import { RECORD_ID } from '../../../workers/tangram-experiment/src/admin/summary.ts';
import { isParticipantRole, participantRoleFromExport } from '../../../workers/tangram-experiment/src/admin/participant-role.ts';
import type { ParticipantRoleView } from '../../../workers/tangram-experiment/src/admin/participant-role.ts';

type Row = { recordId: string; participantRole: ParticipantRoleView };

async function localRecords(root: string, id?: string, role?: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const ownerId of await listBaseOwners(root)) {
    const store = await openBaseFileStore({ root, ownerId, now: Date.now });
    try {
      if (id === undefined) {
        for (const { record, participantRole } of await store.adminRecords()) rows.push({ recordId: record.recordId, participantRole });
      } else {
        if (role !== undefined && !await store.setParticipantRole(id, role)) continue;
        const saved = await store.adminRecord(id);
        if (saved) return [{ recordId: id, participantRole: saved.participantRole }];
      }
    } finally {
      await store.close();
    }
  }
  return rows;
}

async function readExport(path: string): Promise<Row> {
  const record = JSON.parse(await readFile(path, 'utf8'));
  if (typeof record?.recordId !== 'string' || !RECORD_ID.test(record.recordId)) throw new Error('invalid_record');
  return { recordId: record.recordId, participantRole: participantRoleFromExport(record.participantRole) };
}

const selectRole = (rows: Row[], role: string) => role === 'all' ? rows : rows.filter(row => row.participantRole.role === role);
const USAGE = `participant-role.ts get <private-owner-dir> <record-id>
participant-role.ts set <private-owner-dir> <record-id> <human|ai|unclassified>
participant-role.ts list <private-owner-dir> [all|human|ai|unclassified]
participant-role.ts extract <all|human|ai|unclassified> <admin-export.json>...`;

async function main([command, target, arg, ...rest]: string[]) {
  if (command === 'extract' && (target === 'all' || isParticipantRole(target)) && arg) {
    const rows: Row[] = [];
    for (const file of [arg, ...rest]) rows.push(await readExport(file));
    return selectRole(rows, target);
  }
  if (!target) return null;
  const root = resolve(target);
  if (command === 'list' && !rest.length && (arg === undefined || arg === 'all' || isParticipantRole(arg))) {
    return selectRole(await localRecords(root), arg ?? 'all');
  }
  if (((command === 'get' && !rest.length) || (command === 'set' && rest.length === 1 && isParticipantRole(rest[0]))) &&
      typeof arg === 'string' && RECORD_ID.test(arg)) {
    const [row] = await localRecords(root, arg, rest[0]);
    if (!row) throw new Error('not_found');
    return row;
  }
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(result => {
    if (result === null) {
      console.error(USAGE);
      process.exitCode = 1;
    } else console.log(JSON.stringify(result, null, 2));
  }).catch(error => {
    const message = ['invalid_record', 'invalid_participant_role', 'not_found'].includes(error?.message)
      ? error.message : 'unavailable';
    console.error('participant-role: ' + message);
    process.exitCode = 1;
  });
}
