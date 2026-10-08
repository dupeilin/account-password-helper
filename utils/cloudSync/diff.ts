import type {
  CloudRow,
  DiffPlanItem,
  DiffResult,
  LocalSyncEntry,
  PlaintextSyncMetadata,
  SnapshotEntry,
  SyncSnapshot,
} from './types';
import { entryToFields, fieldsToEntry, readBusinessId } from './schema';
import { computeEntryHash } from './hash';

interface ValidCloudRow {
  row: CloudRow;
  entry: LocalSyncEntry;
  hash: string;
  businessId: string;
  metadata: PlaintextSyncMetadata;
}

function fallbackKey(url: string, username: string): string {
  return `${url.trim().toLowerCase()}\u0000${username.trim().toLowerCase()}`;
}

function isValidCloudRow(row: CloudRow): boolean {
  const parsed = fieldsToEntry(row.fields);
  if (parsed.metadata.deletedAt > 0) return Boolean(readBusinessId(row.fields));
  return Boolean(parsed.entry.username || parsed.entry.password || parsed.entry.url);
}

function nextVersion(snapshotEntry: SnapshotEntry | undefined, _cloud: ValidCloudRow | undefined): number {
  const base = snapshotEntry?.version ?? 0;
  // 本地基线没有版本字段时视为旧数据，不能让未知版本号压过已有云端版本。
  if (base === 0) return 0;
  return base + 1;
}

function localMetadata(
  entry: LocalSyncEntry,
  snapshotEntry: SnapshotEntry | undefined,
  cloud: ValidCloudRow | undefined,
  deviceId: string,
): PlaintextSyncMetadata {
  return {
    version: nextVersion(snapshotEntry, cloud),
    updatedAt: entry.updateTime || 0,
    deletedAt: 0,
    lastWriterDeviceId: deviceId,
  };
}

function compareMetadata(local: PlaintextSyncMetadata, cloud: PlaintextSyncMetadata): 'local' | 'cloud' {
  if (local.version !== cloud.version) return local.version > cloud.version ? 'local' : 'cloud';
  if (local.updatedAt !== cloud.updatedAt) return local.updatedAt > cloud.updatedAt ? 'local' : 'cloud';
  return local.lastWriterDeviceId >= cloud.lastWriterDeviceId ? 'local' : 'cloud';
}

function resolveWinner(
  localEntry: LocalSyncEntry,
  localMeta: PlaintextSyncMetadata,
  cloud: ValidCloudRow,
  hasBaseline: boolean,
): 'local' | 'cloud' {
  if (hasBaseline && (cloud.metadata.version > 0 || localMeta.version > 0)) {
    return compareMetadata(localMeta, cloud.metadata);
  }
  const cloudTime = cloud.row.cloudModifiedAt || cloud.metadata.updatedAt || 0;
  return localEntry.updateTime >= cloudTime ? 'local' : 'cloud';
}

function snapshotKnown(snapshotEntries: Record<string, SnapshotEntry>, item: ValidCloudRow): boolean {
  return (
    Boolean(item.businessId && snapshotEntries[item.businessId]) ||
    Object.values(snapshotEntries).some(entry => entry.recordId === item.row.recordId)
  );
}

export async function computeDiff(input: {
  local: LocalSyncEntry[];
  cloud: CloudRow[];
  snapshot: SyncSnapshot | null;
  deviceId?: string;
}): Promise<DiffResult> {
  const plan: DiffPlanItem[] = [];
  const rejectedRows: { recordId: string; reason: string }[] = [];
  const snapshotEntries = input.snapshot?.entries ?? {};
  const snapshotDegraded = input.snapshot === null;
  const deviceId = input.deviceId || 'local';

  const localHashes = new Map<string, string>();
  for (const entry of input.local) localHashes.set(entry.id, await computeEntryHash(entry));

  const validCloudRows: ValidCloudRow[] = [];
  for (const row of input.cloud) {
    if (!isValidCloudRow(row)) {
      rejectedRows.push({ recordId: row.recordId, reason: 'empty-or-invalid-row' });
      continue;
    }
    const parsed = fieldsToEntry(row.fields);
    validCloudRows.push({
      row,
      entry: { ...parsed.entry, updateTime: parsed.updateTime },
      hash: await computeEntryHash(parsed.entry),
      businessId: readBusinessId(row.fields),
      metadata: parsed.metadata,
    });
  }

  const cloudByRecordId = new Map(validCloudRows.map(item => [item.row.recordId, item]));
  const cloudByBusinessId = new Map<string, ValidCloudRow>();
  for (const item of validCloudRows) if (item.businessId) cloudByBusinessId.set(item.businessId, item);

  const matchedRecordIds = new Set<string>();
  const localById = new Map(input.local.map(entry => [entry.id, entry]));
  const snapshotRecordIds = new Set(Object.values(snapshotEntries).map(entry => entry.recordId));
  const unboundFallback = new Map<string, ValidCloudRow>();
  for (const item of validCloudRows) {
    if (item.businessId || snapshotRecordIds.has(item.row.recordId) || item.metadata.deletedAt > 0) continue;
    const key = fallbackKey(item.entry.url, item.entry.username);
    if (!unboundFallback.has(key)) unboundFallback.set(key, item);
  }

  for (const localEntry of input.local) {
    const localHash = localHashes.get(localEntry.id)!;
    const snapshotEntry = snapshotEntries[localEntry.id];
    let cloud = snapshotEntry ? cloudByRecordId.get(snapshotEntry.recordId) : undefined;

    if (cloud) {
      if (cloud.businessId && cloud.businessId !== localEntry.id) {
        matchedRecordIds.add(cloud.row.recordId);
        plan.push({
          kind: 'manualConflict',
          reason: 'primaryKeyChanged',
          businessId: localEntry.id,
          recordId: cloud.row.recordId,
          row: cloud.row,
        });
        continue;
      }
    } else {
      const byBusinessId = cloudByBusinessId.get(localEntry.id);
      if (byBusinessId) {
        cloud = byBusinessId;
        if (snapshotEntry && snapshotEntry.recordId !== byBusinessId.row.recordId) {
          plan.push({ kind: 'rebindRecordId', businessId: localEntry.id, recordId: byBusinessId.row.recordId });
        }
      }
    }

    if (!cloud) {
      if (snapshotEntry) {
        if (localHash !== snapshotEntry.hash) {
          plan.push({
            kind: 'manualConflict',
            reason: 'localModifiedCloudDeleted',
            businessId: localEntry.id,
            recordId: snapshotEntry.recordId,
          });
        } else {
          plan.push({ kind: 'trashLocal', businessId: localEntry.id });
        }
        continue;
      }

      const candidate = unboundFallback.get(fallbackKey(localEntry.url, localEntry.username));
      if (candidate) {
        cloud = candidate;
        matchedRecordIds.add(candidate.row.recordId);
        plan.push({ kind: 'rebindRecordId', businessId: localEntry.id, recordId: candidate.row.recordId });
      } else {
        plan.push({ kind: 'pushCreate', entry: localEntry });
        continue;
      }
    }

    matchedRecordIds.add(cloud.row.recordId);

    if (cloud.metadata.deletedAt > 0) {
      const localChanged = snapshotEntry ? localHash !== snapshotEntry.hash : true;
      if (localChanged) {
        plan.push({
          kind: 'manualConflict',
          reason: 'localModifiedCloudDeleted',
          businessId: localEntry.id,
          recordId: cloud.row.recordId,
          row: cloud.row,
        });
      } else {
        plan.push({ kind: 'trashLocal', businessId: localEntry.id });
      }
      continue;
    }

    const localChanged = snapshotEntry ? localHash !== snapshotEntry.hash : null;
    const cloudChanged = snapshotEntry ? cloud.hash !== snapshotEntry.hash : null;
    const localMeta = snapshotEntry
      ? localMetadata(localEntry, snapshotEntry, cloud, deviceId)
      : { version: 0, updatedAt: localEntry.updateTime || 0, deletedAt: 0, lastWriterDeviceId: deviceId };

    if (snapshotDegraded || !snapshotEntry || localChanged === null || cloudChanged === null) {
      if (localHash === cloud.hash) {
        plan.push({ kind: 'baseline', businessId: localEntry.id, recordId: cloud.row.recordId });
      } else {
        const winner = resolveWinner(localEntry, localMeta, cloud, false);
        plan.push({
          kind: 'conflict',
          businessId: localEntry.id,
          recordId: cloud.row.recordId,
          entry: localEntry,
          row: cloud.row,
          winner,
        });
      }
      continue;
    }

    if (localChanged && !cloudChanged) {
      plan.push({ kind: 'pushUpdate', entry: localEntry, recordId: cloud.row.recordId });
    } else if (!localChanged && cloudChanged) {
      plan.push({ kind: 'pullUpdate', row: cloud.row, businessId: localEntry.id });
    } else if (localChanged && cloudChanged) {
      const winner = resolveWinner(localEntry, localMeta, cloud, true);
      plan.push({
        kind: 'conflict',
        businessId: localEntry.id,
        recordId: cloud.row.recordId,
        entry: localEntry,
        row: cloud.row,
        winner,
      });
    } else {
      plan.push({ kind: 'baseline', businessId: localEntry.id, recordId: cloud.row.recordId });
    }
  }

  const localFallbackKeys = new Set(input.local.map(entry => fallbackKey(entry.url, entry.username)));
  const pulledBusinessIds = new Set<string>();
  for (const item of validCloudRows) {
    if (matchedRecordIds.has(item.row.recordId)) continue;
    if (item.metadata.deletedAt > 0) {
      if (item.businessId && snapshotEntries[item.businessId]) {
        plan.push({ kind: 'dropSnapshot', businessId: item.businessId });
      } else {
        plan.push({ kind: 'skip', businessId: item.row.recordId, reason: 'cloud-tombstone' });
      }
      continue;
    }

    if (snapshotKnown(snapshotEntries, item)) {
      const snapshotEntry = item.businessId
        ? snapshotEntries[item.businessId]
        : Object.values(snapshotEntries).find(entry => entry.recordId === item.row.recordId);
      const businessId =
        item.businessId ||
        (snapshotEntry
          ? (Object.keys(snapshotEntries).find(key => snapshotEntries[key] === snapshotEntry) ?? '')
          : item.row.recordId);
      if (snapshotEntry && item.hash !== snapshotEntry.hash) {
        plan.push({
          kind: 'manualConflict',
          reason: 'localDeletedCloudChanged',
          businessId,
          recordId: item.row.recordId,
          row: item.row,
        });
      } else {
        plan.push({
          kind: 'markCloudDeleted',
          recordId: item.row.recordId,
          businessId,
        });
      }
      continue;
    }

    if (item.businessId) {
      if (localById.has(item.businessId) || pulledBusinessIds.has(item.businessId)) {
        plan.push({ kind: 'skip', businessId: item.row.recordId, reason: 'duplicate-business-id' });
        continue;
      }
      pulledBusinessIds.add(item.businessId);
      plan.push({ kind: 'pullCreateWithId', row: item.row, businessId: item.businessId });
      continue;
    }

    const key = fallbackKey(item.entry.url, item.entry.username);
    if (localFallbackKeys.has(key) || localById.has(item.row.recordId)) {
      plan.push({ kind: 'skip', businessId: item.row.recordId, reason: 'duplicate-url-username' });
      continue;
    }
    plan.push({ kind: 'pullCreate', row: item.row });
  }

  return { plan, rejectedRows, snapshotDegraded };
}

export function toCloudFields(entry: LocalSyncEntry): Record<string, string | number> {
  return entryToFields(entry);
}
