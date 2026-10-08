/**
 * 云同步编排（设计规格 §2、§5、§6）
 *
 * 职责：把"取数 → diff → 批量执行 → 增量更新快照 → 生成报告"串起来，并对
 * 任务锁、审计日志、取消信号与部分失败做统一处理。
 *
 * 平台细节全部封装在 `adapters/`；本模块只面向 `CloudRow` / `BatchResult` 编程。
 * 任何分支都不得把 token、密码、TOTP 或完整 payload 写入日志与报告。
 */
import type { PasswordEntry, PasswordGroup } from '@/utils/types';
import { UNGROUPED_CODE } from '@/utils/types';
import { batchApplyPasswordChanges, getAllPasswords, savePassword, updatePassword } from '@/utils/storage/passwordCrud';
import { getAllGroups, saveGroups } from '@/utils/storage/groupManager';
import { moveToTrash } from '@/utils/storage/trashManager';
import { logger } from '@/utils/logger';
import { buildGroupPathMap, ensureGroupByPath, mergeImportedGroups } from '@/utils/groupTree';
import { patchProviderConfig } from './configStore';
import { getOrCreateDeviceId } from './deviceIdentity';
import { buildReport, emptyStats, loadReadyContext } from './runContext';
import {
  createEmptySnapshot,
  loadEncryptedMeta,
  loadSnapshot,
  saveEncryptedMeta,
  saveSnapshot,
  withEntries,
} from './snapshotStore';
import { appendAuditLog, makeAuditEntry } from './auditLog';
import { acquireTaskLock } from './taskLock';
import { computeDiff } from './diff';
import { computeEntryHash } from './hash';
import {
  encryptAndChunk,
  groupChunks,
  nextChunkSize,
  selectOrphanGroups,
  selectVersionsToPrune,
  verifyAndDecryptSnapshot,
} from './cryptoSnapshot';
import {
  ENCRYPTED_FIELDS,
  PLAINTEXT_METADATA_FIELD_NAMES,
  PLAINTEXT_TRASH_TABLE_NAME,
  TRASH_FIELDS,
  TRASH_TABLE_SPEC,
  entryToFields,
  fieldsToEntry,
  getTableName,
  getTableSpec,
  readBusinessId,
  readPlaintextMetadata,
} from './schema';
import { sanitizeFields } from './sanitize';
import { CloudSyncError, isAbortError, toCloudSyncError } from './errors';
import { FeishuAdapter, normalizeFeishuBaseUrl } from './adapters/feishu';
import { TencentAdapter, normalizeTencentBaseUrl } from './adapters/tencent';
import { needsServerInsecureConfirm } from './adapters/serverAddress';
import { parseCloudUrl } from './urlParse';
import type {
  AdapterOptions,
  BatchResult,
  CloudProvider,
  CloudSyncMode,
  CloudRow,
  DiffPlanItem,
  EncryptedSnapshotMeta,
  LocalSyncEntry,
  PlaintextSyncMetadata,
  PlaintextSyncPreview,
  PlaintextSyncPreviewItem,
  ProviderCredentialMap,
  ProviderTargetMap,
  SnapshotEntry,
  SnapshotChunkRow,
  SyncProgress,
  SyncReport,
  TableAdapter,
  UpsertRow,
} from './types';

/** 明文同步方向 */
export type PlaintextSyncDirection = 'push' | 'pull' | 'both';

/** 运行期选项 */
export interface SyncRunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: SyncProgress) => void;
  /**
   * 明文同步方向：
   * - `push`：只把本地新增、修改与删除推送到表格；
   * - `pull`：只把表格新增、修改与删除拉取到本地；
   * - `both`：双向同步（默认，保持既有行为）。
   */
  direction?: PlaintextSyncDirection;
  /**
   * 本地条目为空而云端仍有行时的确认回调。
   *
   * 仅在推送/双向同步中调用；返回 true 才删除云端全部同步行，返回 false 则本轮取消。
   * 不传回调时保持既有行为，便于库级调用方自行决定策略。
   */
  onEmptyLocalCloud?: () => boolean | Promise<boolean>;
  /**
   * 明文同步预览回调：在计算 diff 之后、任何本地/云端写操作之前调用，
   * 用于展示本次将执行的新增/修改/删除账号列表（仅安全字段）。
   * 返回 false 时本轮取消（cancelled=true），不写快照、不更新 lastSyncAt、
   * 不写审计，也不执行任何数据写入（batchUpsert/batchDelete/moveToTrash/batchApplyPasswordChanges）。
   */
  onPreview?: (preview: PlaintextSyncPreview) => boolean | Promise<boolean>;
}

interface PendingPullCreate {
  row: CloudRow;
  entry: LocalSyncEntry;
  metadata: PlaintextSyncMetadata;
  explicitId?: string;
  groupId?: string;
}

interface PendingPullUpdate {
  businessId: string;
  row: CloudRow;
  entry: LocalSyncEntry;
  metadata: PlaintextSyncMetadata;
  groupId?: string;
}

/** 目标表准备结果 */
export interface PrepareTargetResult {
  provider: CloudProvider;
  tableName: string;
  created: boolean;
  target: ProviderTargetMap[CloudProvider];
}

/** 目标表准备选项：凭证与文档链接之外的部署信息 */
export interface PrepareTargetOptions {
  /**
   * 飞书私有化部署的开放平台地址（如 `https://open.example.com`）；留空表示官方 SaaS。
   * 归一化后随 target 落盘，后续备份/恢复/同步直接复用，无需每次重填。
   */
  feishuBaseUrl?: string | null;
  /** 腾讯文档私有化部署的开放平台地址；留空表示官方 SaaS。 */
  tencentBaseUrl?: string | null;
  /** 用户已确认允许内网 HTTP 明文传输。仅对非回环 HTTP 地址生效。 */
  allowInsecure?: boolean;
}

/** 本地条目 → 同步投影（`order` 等本地 UX 状态不参与同步） */
function toLocalSyncEntry(entry: PasswordEntry, groupPaths: ReadonlyMap<string, string>): LocalSyncEntry {
  return {
    id: entry.id,
    username: entry.username ?? '',
    password: entry.password ?? '',
    url: entry.url ?? '',
    tag: entry.tag ?? '',
    remark: entry.remark ?? '',
    totp: entry.totp ?? '',
    groupPath: entry.groupId ? (groupPaths.get(entry.groupId) ?? '') : '',
    createTime: entry.createTime ?? 0,
    updateTime: entry.updateTime ?? 0,
  };
}

/** 云端行 → 同步投影（不可信输入，字段已在 diff 中校验） */
function cloudRowToLocal(row: CloudRow): { entry: LocalSyncEntry; metadata: PlaintextSyncMetadata } {
  const parsed = fieldsToEntry(row.fields);
  return {
    entry: { ...parsed.entry, updateTime: parsed.updateTime },
    metadata: parsed.metadata,
  };
}

function snapshotRootMetadata(snapshotEntry: SnapshotEntry | undefined): PlaintextSyncMetadata {
  return {
    version: snapshotEntry?.version ?? 0,
    updatedAt: snapshotEntry?.updatedAt ?? 0,
    deletedAt: snapshotEntry?.deletedAt ?? 0,
    lastWriterDeviceId: snapshotEntry?.lastWriterDeviceId ?? '',
  };
}

function writeMetadata(
  entry: LocalSyncEntry,
  snapshotEntry: SnapshotEntry | undefined,
  cloudMetadata: PlaintextSyncMetadata | undefined,
  deviceId: string,
  deletedAt = 0,
): PlaintextSyncMetadata {
  const base = snapshotEntry?.version ?? 0;
  const observed = cloudMetadata?.version ?? 0;
  return {
    version: Math.max(1, base + 1, observed + 1),
    updatedAt: deletedAt > 0 ? entry.updateTime || Date.now() : entry.updateTime || 0,
    deletedAt,
    lastWriterDeviceId: deviceId,
  };
}

/** 云端分组路径 → 本地 groupId；缺失路径按未分组处理，创建的分组立即持久化。 */
async function resolveCloudGroupId(
  groupPath: string,
  groups: PasswordGroup[],
  resolvedPaths: Map<string, string | undefined>,
): Promise<string | undefined> {
  const normalizedPath = groupPath.trim();
  if (!normalizedPath) return undefined;
  if (resolvedPaths.has(normalizedPath)) return resolvedPaths.get(normalizedPath);

  const resolved = ensureGroupByPath(normalizedPath, groups);
  if (resolved.created.length > 0) {
    groups.push(...resolved.created);
    await saveGroups(groups);
  }
  const groupId = resolved.code === UNGROUPED_CODE ? undefined : resolved.code;
  resolvedPaths.set(normalizedPath, groupId);
  return groupId;
}

/** 把快照携带的分组树按“同名同级复用”合并到本地，并返回远端 code → 本地 code。 */
async function mergeSnapshotGroups(
  imported: readonly PasswordGroup[],
  existing: readonly PasswordGroup[],
): Promise<{ groups: PasswordGroup[]; codeMap: Map<string, string> }> {
  const merged = mergeImportedGroups(imported, existing);
  if (merged.groups.length !== existing.length) await saveGroups(merged.groups);
  return merged;
}

/**
 * 按平台构造表格适配器
 *
 * 穷尽式 switch + never 兜底（WebDAV 规格 §2.2）：webdav 走 FileStorageAdapter
 * （见 webdavSync.ts），误入本函数时显式抛领域错误而非静默构造错误适配器。
 */
function createAdapter(
  provider: CloudProvider,
  target: ProviderTargetMap[CloudProvider],
  credentials: ProviderCredentialMap[CloudProvider],
  options: AdapterOptions,
): TableAdapter {
  switch (provider) {
    case 'feishu': {
      const t = target as ProviderTargetMap['feishu'];
      const c = credentials as ProviderCredentialMap['feishu'];
      return new FeishuAdapter({
        appToken: t.appToken ?? '',
        tableId: t.tableId,
        baseUrl: t.baseUrl,
        allowInsecure: t.allowInsecure,
        credentials: c,
        options,
      });
    }
    case 'tencent': {
      const t = target as ProviderTargetMap['tencent'];
      const c = credentials as ProviderCredentialMap['tencent'];
      return new TencentAdapter({
        fileId: t.fileId ?? '',
        sheetId: t.sheetId,
        baseUrl: t.baseUrl,
        allowInsecure: t.allowInsecure,
        credentials: c,
        options,
      });
    }
    case 'webdav':
      throw new CloudSyncError('unknown', 'webdav uses FileStorageAdapter (see webdavSync.ts)');
    default: {
      const _exhaustive: never = provider;
      throw new CloudSyncError('unknown', `provider does not use TableAdapter: ${String(_exhaustive)}`);
    }
  }
}

/**
 * 由主表 target 派生「回收站表」target（仅表格平台且已配置回收表标识时）
 *
 * 回收站表与主表同文档、同结构，只是把当前子表标识替换为回收表标识，
 * 因此可直接复用 `createAdapter`。未配置（旧配置/密文模式）时返回 null。
 */
function trashTargetOf(target: ProviderTargetMap[CloudProvider]): ProviderTargetMap[CloudProvider] | null {
  const feishu = target as ProviderTargetMap['feishu'];
  if (typeof feishu?.trashTableId === 'string' && feishu.trashTableId) {
    return { ...feishu, tableId: feishu.trashTableId } as ProviderTargetMap[CloudProvider];
  }
  const tencent = target as ProviderTargetMap['tencent'];
  if (typeof tencent?.trashSheetId === 'string' && tencent.trashSheetId) {
    return { ...tencent, sheetId: tencent.trashSheetId } as ProviderTargetMap[CloudProvider];
  }
  return null;
}

/**
 * 由云端行构造回收站行（整行留档 + 追加「回收时间」）
 *
 * 直接复用云端行的扁平字段（已是平台归一化形态），原样保留 ID/版本/删除时间等
 * 全部列值，保证在文档中把手工复制回主表后能被扩展按 ID 识别并拉回。
 * 无业务 ID 的行（用户在文档手工新增后又被删）不留档，返回 null。
 */
function buildTrashRow(row: CloudRow, trashedAt: number): UpsertRow | null {
  const businessId = readBusinessId(row.fields);
  if (!businessId) return null;
  return { recordId: '', businessId, fields: { ...row.fields, [TRASH_FIELDS.trashedAt]: trashedAt } };
}

/** 审计写入失败不阻断主流程，仅在报告里提示 */
async function audit(entry: Parameters<typeof appendAuditLog>[0]): Promise<boolean> {
  return appendAuditLog(entry);
}

// ==================== 目标表准备 ====================

/**
 * 校验凭证、探测目标文档、按需建表，并把目标回写配置
 *
 * 表结构不匹配时终止并提示，**不自动修改云端表结构**（防误删用户自定义字段）。
 */
export async function prepareProviderTarget<P extends CloudProvider>(
  provider: P,
  credentials: ProviderCredentialMap[P],
  fileUrl: string,
  mode: CloudSyncMode,
  options: AdapterOptions = {},
  prepareOptions: PrepareTargetOptions = {},
): Promise<PrepareTargetResult> {
  const allowInsecure = prepareOptions.allowInsecure === true;
  // 私有化部署地址先归一化（非法即抛 notFound）：既用于放宽文档链接的域名校验，也随 target 落盘
  const baseUrl =
    provider === 'feishu'
      ? normalizeFeishuBaseUrl(prepareOptions.feishuBaseUrl, allowInsecure)
      : provider === 'tencent'
        ? normalizeTencentBaseUrl(prepareOptions.tencentBaseUrl, allowInsecure)
        : null;
  const parsed = parseCloudUrl(provider, fileUrl, {
    feishuBaseUrl: provider === 'feishu' ? baseUrl : null,
    tencentBaseUrl: provider === 'tencent' ? baseUrl : null,
  });
  if (!parsed) throw new CloudSyncError('notFound', 'unrecognized document url');
  const insecureConfirmed = allowInsecure && baseUrl !== null && needsServerInsecureConfirm(baseUrl);

  const tableName = getTableName(mode);
  const requiredFields = getTableSpec(mode);

  // 先以「仅有文件标识」构造适配器完成探测与建表，再回填子表标识
  const target = buildTarget(provider, parsed.fileKey, parsed.subKey, fileUrl, baseUrl, insecureConfirmed);
  const adapter = createAdapter(provider, target, credentials, options);
  await adapter.testConnection();

  const tables = await adapter.listTables();
  // 只按当前表名查找：不做旧表名兼容（用户已确认直接启用新表），
  // 旧英文名表视为不存在，将按新名另建。
  const existing = tables.find(table => table.name === tableName) ?? null;
  let created = false;

  if (existing) {
    applySubKey(adapter, provider, existing.id);
    let check = await adapter.checkTableSchema(requiredFields);
    if (!check.ok) {
      const initialMissingFields = check.missingFields;
      // 只对旧版明文表缺少的元数据列做非破坏性补建；核心列缺失仍报错，
      // 避免覆盖用户自行修改的表结构。
      if (mode === 'plaintext') {
        const metadataFields = new Set<string>(PLAINTEXT_METADATA_FIELD_NAMES);
        const missingFields = requiredFields.filter(
          spec => metadataFields.has(spec.name) && initialMissingFields.includes(spec.name),
        );
        if (missingFields.length > 0) {
          await adapter.addFields(missingFields);
          check = await adapter.checkTableSchema(requiredFields);
        }
      }
      if (!check.ok) {
        throw new CloudSyncError('schema', `table schema mismatch: ${check.missingFields.join(', ')}`);
      }
    }
  } else {
    const meta = await adapter.createTable({ name: tableName, fields: requiredFields });
    applySubKey(adapter, provider, meta.id);
    created = true;
  }

  const subKey = readSubKey(adapter, provider);

  // 明文模式额外准备回收站表：本地删除的条目在主表删行同时整行写入该表留档。
  // 密文模式不建（版本保留机制已充当回收站）。回收站表按名查找即可，无需读旧配置。
  let trashKey: string | null = null;
  if (mode === 'plaintext') {
    const trashExisting = tables.find(table => table.name === PLAINTEXT_TRASH_TABLE_NAME);
    if (trashExisting) {
      trashKey = trashExisting.id;
    } else {
      const trashMeta = await adapter.createTable({ name: PLAINTEXT_TRASH_TABLE_NAME, fields: TRASH_TABLE_SPEC });
      trashKey = trashMeta.id;
      // 建回收站表会切换适配器当前子表，需把主表标识回填回去
      applySubKey(adapter, provider, subKey ?? '');
    }
  }

  const resolvedTarget = buildTarget(provider, parsed.fileKey, subKey, fileUrl, baseUrl, insecureConfirmed, trashKey);
  await patchProviderConfig(provider, { configured: true, mode, target: resolvedTarget });
  await audit(makeAuditEntry(provider, mode, 'prepareTarget', `${parsed.fileKey}:${subKey ?? ''}`));

  return { provider, tableName, created, target: resolvedTarget };
}

/** 构造平台目标对象（仅表格平台；webdav 目标由 webdavSync.prepareWebDavTarget 构造） */
function buildTarget<P extends CloudProvider>(
  provider: P,
  fileKey: string,
  subKey: string | null,
  fileUrl: string,
  baseUrl: string | null,
  allowInsecure: boolean,
  trashKey: string | null = null,
): ProviderTargetMap[P] {
  switch (provider) {
    case 'feishu':
      return {
        appToken: fileKey,
        tableId: subKey,
        fileUrl,
        baseUrl,
        allowInsecure,
        trashTableId: trashKey,
      } as ProviderTargetMap[P];
    case 'tencent':
      return {
        fileId: fileKey,
        sheetId: subKey,
        fileUrl,
        baseUrl,
        allowInsecure,
        trashSheetId: trashKey,
      } as ProviderTargetMap[P];
    case 'webdav':
      throw new CloudSyncError('unknown', 'webdav target is built by prepareWebDavTarget');
    default: {
      const _exhaustive: never = provider;
      throw new CloudSyncError('unknown', `provider does not use document target: ${String(_exhaustive)}`);
    }
  }
}

/** 把探测/建表得到的子表标识回填适配器实例（仅表格平台；穷尽 switch 防新 provider 静默走错分支） */
function applySubKey(adapter: TableAdapter, provider: CloudProvider, subKey: string): void {
  switch (provider) {
    case 'feishu':
      (adapter as FeishuAdapter).setTableId(subKey);
      break;
    case 'tencent':
      (adapter as TencentAdapter).setSheetId(subKey);
      break;
    case 'webdav':
      throw new CloudSyncError('unknown', 'webdav uses FileStorageAdapter (see webdavSync.ts)');
    default: {
      const _exhaustive: never = provider;
      throw new CloudSyncError('unknown', `provider does not use TableAdapter: ${String(_exhaustive)}`);
    }
  }
}

/** 读取适配器当前的子表标识（仅表格平台） */
function readSubKey(adapter: TableAdapter, provider: CloudProvider): string | null {
  switch (provider) {
    case 'feishu':
      return (adapter as unknown as { tableId: string | null }).tableId;
    case 'tencent':
      return (adapter as unknown as { sheetId: string | null }).sheetId;
    case 'webdav':
      throw new CloudSyncError('unknown', 'webdav uses FileStorageAdapter (see webdavSync.ts)');
    default: {
      const _exhaustive: never = provider;
      throw new CloudSyncError('unknown', `provider does not use TableAdapter: ${String(_exhaustive)}`);
    }
  }
}

// ==================== 明文双向同步 ====================

/** 云端行 → 预览安全字段（仅 username/url/groupPath，绝不带 password/totp/remark） */
function previewFieldsFromCloudRow(row: CloudRow): Pick<PlaintextSyncPreviewItem, 'username' | 'url' | 'groupPath'> {
  const { entry } = cloudRowToLocal(row);
  return { username: entry.username, url: entry.url, groupPath: entry.groupPath };
}

/** 本地条目 → 预览安全字段（仅 username/url/groupPath） */
function previewFieldsFromLocalEntry(
  entry: LocalSyncEntry | undefined,
): Pick<PlaintextSyncPreviewItem, 'username' | 'url' | 'groupPath'> {
  return { username: entry?.username ?? '', url: entry?.url ?? '', groupPath: entry?.groupPath ?? '' };
}

/**
 * 构建明文同步预览：把 diff 计划映射为「新增/修改/删除 × 云端/本地」的账号级动作列表。
 *
 * - 只反映**实际会执行**的数据动作（按 direction 过滤）：
 *   push 只含云端侧动作，pull 只含本地侧动作，both 两侧都展示。
 * - baseline/rebindRecordId/skip/dropSnapshot/manualConflict 不产生账号增删改，不进入列表。
 * - conflict 按 winner 落到对应 target：winner=local → update/cloud，winner=cloud → update/local。
 * - 仅携带 username/url/groupPath 三个安全字段，绝不包含 password/totp/remark 或加密内容。
 */
function buildPlaintextPreview(
  plan: readonly DiffPlanItem[],
  direction: PlaintextSyncDirection,
  cloudByRecordId: ReadonlyMap<string, CloudRow>,
  cloudByBusinessId: ReadonlyMap<string, CloudRow>,
  localEntries: readonly LocalSyncEntry[],
): PlaintextSyncPreview {
  const localById = new Map(localEntries.map(entry => [entry.id, entry]));
  const items: PlaintextSyncPreviewItem[] = [];

  for (const item of plan) {
    switch (item.kind) {
      case 'pushCreate':
        if (direction === 'pull') break;
        items.push({
          action: 'create',
          target: 'cloud',
          businessId: item.entry.id,
          ...previewFieldsFromLocalEntry(item.entry),
        });
        break;
      case 'pushUpdate':
        if (direction === 'pull') break;
        items.push({
          action: 'update',
          target: 'cloud',
          businessId: item.entry.id,
          ...previewFieldsFromLocalEntry(item.entry),
        });
        break;
      case 'markCloudDeleted':
      case 'deleteCloudRow': {
        if (direction === 'pull') break;
        const row = cloudByRecordId.get(item.recordId) ?? cloudByBusinessId.get(item.businessId);
        items.push({
          action: 'delete',
          target: 'cloud',
          businessId: item.businessId,
          ...(row ? previewFieldsFromCloudRow(row) : { username: '', url: '', groupPath: '' }),
        });
        break;
      }
      case 'pullCreate':
        if (direction === 'push') break;
        items.push({
          action: 'create',
          target: 'local',
          businessId: readBusinessId(item.row.fields) || item.row.recordId,
          ...previewFieldsFromCloudRow(item.row),
        });
        break;
      case 'pullCreateWithId':
        if (direction === 'push') break;
        items.push({
          action: 'create',
          target: 'local',
          businessId: item.businessId,
          ...previewFieldsFromCloudRow(item.row),
        });
        break;
      case 'pullUpdate':
        if (direction === 'push') break;
        items.push({
          action: 'update',
          target: 'local',
          businessId: item.businessId,
          ...previewFieldsFromCloudRow(item.row),
        });
        break;
      case 'trashLocal':
        if (direction === 'push') break;
        items.push({
          action: 'delete',
          target: 'local',
          businessId: item.businessId,
          ...previewFieldsFromLocalEntry(localById.get(item.businessId)),
        });
        break;
      case 'conflict':
        if (item.winner === 'local') {
          if (direction === 'pull') break;
          items.push({
            action: 'update',
            target: 'cloud',
            businessId: item.businessId,
            ...previewFieldsFromLocalEntry(item.entry),
          });
        } else {
          if (direction === 'push') break;
          items.push({
            action: 'update',
            target: 'local',
            businessId: item.businessId,
            ...previewFieldsFromCloudRow(item.row),
          });
        }
        break;
      case 'baseline':
      case 'rebindRecordId':
      case 'skip':
      case 'dropSnapshot':
      case 'manualConflict':
        break;
    }
  }

  return { items };
}

/**
 * 执行明文同步
 *
 * 需先由调用方通过 `promptAndVerifyMasterPassword` 取得主密码（本地加解密需要），
 * UI 必须同时展示"明文密码将上传第三方云端"的红字警告。默认双向，也可只推送或只拉取。
 */
export async function runPlaintextSync(
  provider: CloudProvider,
  masterPassword: string,
  options: SyncRunOptions = {},
): Promise<SyncReport> {
  const startedAt = Date.now();
  const { providerConfig, credentials, docKey } = await loadReadyContext(provider);
  if (providerConfig.mode !== 'plaintext') throw new CloudSyncError('unknown', 'provider not in plaintext mode');
  const direction = options.direction ?? 'both';

  const targetKey = `${provider}:${docKey}`;
  const deviceId = await getOrCreateDeviceId();
  const lock = await acquireTaskLock(targetKey);
  if (!lock.ok) throw new CloudSyncError('writeConflict', 'sync task already running');
  if (lock.preempted) {
    await audit(makeAuditEntry(provider, 'plaintext', 'lockPreempted', docKey));
  }

  const stats = emptyStats();
  const failures: SyncReport['failures'] = [];
  const conflictDetails: SyncReport['conflictDetails'] = [];
  const warnings: SyncReport['warnings'] = [];
  const truncated: SyncReport['truncated'] = [];
  let apiCalls = 0;
  let cancelled = false;
  let snapshotDegraded: boolean;
  let auditFailed: boolean;

  try {
    const adapter = createAdapter(provider, providerConfig.target, credentials, {
      signal: options.signal,
      onApiCall: () => {
        apiCalls += 1;
      },
    });
    // 回收站表适配器（仅明文模式且已配置回收表标识时存在）：主表删行/写墓碑的
    // 同时把该行整行留档到回收站表，供在文档中手工复制回主表恢复。
    const trashTarget = trashTargetOf(providerConfig.target);
    const trashAdapter = trashTarget
      ? createAdapter(provider, trashTarget, credentials, {
          signal: options.signal,
          onApiCall: () => {
            apiCalls += 1;
          },
        })
      : null;
    const trashRows: UpsertRow[] = [];
    /** 把收集到的删除行写入回收站表；失败不阻断主同步，仅记警告 */
    const flushTrash = async (): Promise<void> => {
      if (!trashAdapter || trashRows.length === 0) return;
      try {
        const result = await runBatch(() => trashAdapter.batchUpsert(trashRows));
        for (const failed of result.failed) {
          failures.push({ businessId: failed.businessId, code: failed.code, message: `trash: ${failed.message}` });
        }
        if (result.failed.length > 0) warnings.push({ key: 'cloudSync.warning.trashWriteFailed' });
      } catch (error) {
        logger.error('写入云端回收站表失败:', error);
        warnings.push({ key: 'cloudSync.warning.trashWriteFailed' });
      }
    };

    options.onProgress?.({ phaseKey: 'cloudSync.progress.fetchLocal', current: 0, total: 1 });
    const [passwords, initialGroups] = await Promise.all([getAllPasswords(masterPassword), getAllGroups()]);
    const groups = [...initialGroups];
    const localEntries = passwords.map(entry => toLocalSyncEntry(entry, buildGroupPathMap(groups)));
    const resolvedCloudGroupIds = new Map<string, string | undefined>();

    options.onProgress?.({ phaseKey: 'cloudSync.progress.fetchCloud', current: 0, total: 1 });
    const cloudRows = await adapter.getRows();

    if (
      direction !== 'pull' &&
      !options.signal?.aborted &&
      localEntries.length === 0 &&
      cloudRows.length > 0 &&
      (options.onPreview || options.onEmptyLocalCloud)
    ) {
      // 优先走统一预览；未提供 onPreview 时回退到旧 onEmptyLocalCloud 兼容路径。
      const confirmed = options.onPreview
        ? await options.onPreview({
            items: cloudRows.map(row => ({
              action: 'delete',
              target: 'cloud',
              businessId: readBusinessId(row.fields) || row.recordId,
              ...previewFieldsFromCloudRow(row),
            })),
          })
        : await options.onEmptyLocalCloud!();
      if (!confirmed) {
        return buildReport(provider, 'plaintext', docKey, startedAt, stats, [], [], [], [], apiCalls, true);
      }

      // 清空整表同样先留档：把全部云端行整行写入回收站表后再物理删除
      for (const row of cloudRows) {
        const trashRow = buildTrashRow(row, Date.now());
        if (trashRow) trashRows.push(trashRow);
      }
      await flushTrash();
      const deleteResult = await runBatch(() => adapter.batchDelete(cloudRows.map(row => row.recordId)));
      stats.deleted = deleteResult.succeeded.length;
      stats.failed = deleteResult.failed.length;
      failures.push(...deleteResult.failed);
      if (deleteResult.failed.length === 0) {
        await saveSnapshot(createEmptySnapshot(provider, docKey));
        await patchProviderConfig(provider, { lastSyncAt: Date.now() });
      }
      const auditFailed = !(await audit(
        makeAuditEntry(provider, 'plaintext', 'sync', docKey, {
          stats,
        }),
      ));
      if (auditFailed) warnings.push({ key: 'cloudSync.warning.auditLogFailed' });
      if (providerConfig.target.allowInsecure) warnings.push({ key: 'cloudSync.warning.insecureTransport' });
      return buildReport(provider, 'plaintext', docKey, startedAt, stats, [], failures, warnings, [], apiCalls, false);
    }

    const snapshot = (await loadSnapshot(provider, docKey)) ?? createEmptySnapshot(provider, docKey);
    const diff = await computeDiff({
      local: localEntries,
      cloud: cloudRows,
      snapshot: await loadSnapshot(provider, docKey),
      deviceId,
    });
    snapshotDegraded = diff.snapshotDegraded;
    for (const rejected of diff.rejectedRows) {
      stats.skipped += 1;
      failures.push({ businessId: rejected.recordId, code: 'invalid-row', message: rejected.reason });
    }

    let working = createEmptySnapshot(provider, docKey);
    working = { ...working, entries: snapshot.entries };

    const cloudByRecordId = new Map(cloudRows.map(row => [row.recordId, row]));
    const cloudByBusinessId = new Map<string, CloudRow>();
    for (const row of cloudRows) {
      const businessId = readBusinessId(row.fields);
      if (businessId) cloudByBusinessId.set(businessId, row);
    }

    const now = Date.now();
    const createItems: Extract<DiffPlanItem, { kind: 'pushCreate' }>[] = [];
    const updateItems: Extract<DiffPlanItem, { kind: 'pushUpdate' }>[] = [];
    const tombstoneItems: { businessId: string; recordId: string }[] = [];
    const deleteRecordIds: string[] = [];
    const pendingPullCreates: PendingPullCreate[] = [];
    const pendingPullUpdates: PendingPullUpdate[] = [];

    if (options.signal?.aborted) {
      return buildReport(
        provider,
        'plaintext',
        docKey,
        startedAt,
        stats,
        conflictDetails,
        failures,
        warnings,
        truncated,
        apiCalls,
        true,
      );
    }

    if (options.onPreview) {
      // 在真正写入前给出确认清单；取消则不发任何写操作（快照/lastSyncAt/审计/数据写入全部跳过）。
      const preview = buildPlaintextPreview(diff.plan, direction, cloudByRecordId, cloudByBusinessId, localEntries);
      const confirmed = await options.onPreview(preview);
      if (!confirmed) {
        return buildReport(
          provider,
          'plaintext',
          docKey,
          startedAt,
          stats,
          conflictDetails,
          failures,
          warnings,
          truncated,
          apiCalls,
          true,
        );
      }
    }

    options.onProgress?.({ phaseKey: 'cloudSync.progress.apply', current: 0, total: diff.plan.length });
    let processed = 0;

    for (const item of diff.plan) {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      processed += 1;

      switch (item.kind) {
        case 'pushCreate':
          if (direction === 'pull') break;
          createItems.push(item);
          break;
        case 'pushUpdate':
          if (direction === 'pull') break;
          updateItems.push(item);
          break;
        case 'markCloudDeleted': {
          if (direction === 'pull') break;
          tombstoneItems.push({ businessId: item.businessId, recordId: item.recordId });
          // 删除前留档：把该行删除前的云端内容整行写入回收站表（先留档后删除）
          const tombRow = cloudByRecordId.get(item.recordId) ?? cloudByBusinessId.get(item.businessId);
          if (tombRow) {
            const trashRow = buildTrashRow(tombRow, now);
            if (trashRow) trashRows.push(trashRow);
          }
          break;
        }
        case 'deleteCloudRow': {
          if (direction === 'pull') break;
          deleteRecordIds.push(item.recordId);
          const delRow = cloudByRecordId.get(item.recordId) ?? cloudByBusinessId.get(item.businessId);
          if (delRow) {
            const trashRow = buildTrashRow(delRow, now);
            if (trashRow) trashRows.push(trashRow);
          }
          break;
        }
        case 'pullCreate': {
          if (direction === 'push') break;
          const { entry, metadata } = cloudRowToLocal(item.row);
          const groupId = await resolveCloudGroupId(entry.groupPath, groups, resolvedCloudGroupIds);
          pendingPullCreates.push({ row: item.row, entry, metadata, groupId });
          break;
        }
        case 'pullCreateWithId': {
          if (direction === 'push') break;
          const { entry, metadata } = cloudRowToLocal(item.row);
          const groupId = await resolveCloudGroupId(entry.groupPath, groups, resolvedCloudGroupIds);
          pendingPullCreates.push({
            row: item.row,
            entry,
            metadata,
            explicitId: item.businessId,
            groupId,
          });
          break;
        }
        case 'pullUpdate': {
          if (direction === 'push') break;
          const { entry, metadata } = cloudRowToLocal(item.row);
          const groupId = await resolveCloudGroupId(entry.groupPath, groups, resolvedCloudGroupIds);
          pendingPullUpdates.push({
            businessId: item.businessId,
            row: item.row,
            entry,
            metadata,
            groupId,
          });
          break;
        }
        case 'trashLocal': {
          if (direction === 'push') break;
          await moveToTrash([item.businessId]);
          stats.trashed += 1;
          working = withEntries(working, { [item.businessId]: null });
          break;
        }
        case 'dropSnapshot': {
          working = withEntries(working, { [item.businessId]: null });
          break;
        }
        case 'rebindRecordId': {
          const existing = working.entries[item.businessId];
          if (existing) {
            working = withEntries(working, {
              [item.businessId]: { ...existing, recordId: item.recordId, syncedAt: now },
            });
          }
          break;
        }
        case 'baseline': {
          const entry = localEntries.find(local => local.id === item.businessId);
          if (entry) {
            const existing = working.entries[item.businessId];
            const cloudRow = cloudByRecordId.get(item.recordId) ?? cloudByBusinessId.get(item.businessId);
            const cloudMetadata = cloudRow ? readPlaintextMetadata(cloudRow.fields) : snapshotRootMetadata(existing);
            working = withEntries(working, {
              [item.businessId]: {
                hash: await computeEntryHash(entry),
                recordId: item.recordId,
                syncedAt: now,
                version: cloudMetadata.version || existing?.version || 0,
                updatedAt: cloudMetadata.updatedAt || entry.updateTime || now,
                deletedAt: cloudMetadata.deletedAt,
                lastWriterDeviceId: cloudMetadata.lastWriterDeviceId,
              },
            });
          }
          break;
        }
        case 'conflict': {
          stats.conflicts += 1;
          conflictDetails.push({
            businessId: item.businessId,
            username: item.entry.username,
            url: item.entry.url,
            winner: item.winner,
          });
          // 单向模式只执行该方向上胜出的一方，不把反方向变更带入本轮同步。
          if (direction !== 'pull' && item.winner === 'local') {
            updateItems.push({ kind: 'pushUpdate', entry: item.entry, recordId: item.recordId });
          } else if (direction !== 'push' && item.winner === 'cloud') {
            const { entry: cloudEntry, metadata } = cloudRowToLocal(item.row);
            const groupId = await resolveCloudGroupId(cloudEntry.groupPath, groups, resolvedCloudGroupIds);
            pendingPullUpdates.push({
              businessId: item.businessId,
              row: item.row,
              entry: cloudEntry,
              metadata,
              groupId,
            });
          }
          break;
        }
        case 'manualConflict': {
          stats.conflicts += 1;
          warnings.push({ key: 'cloudSync.warning.manualConflict', params: { reason: item.reason } });
          break;
        }
        case 'skip': {
          stats.skipped += 1;
          break;
        }
      }
      options.onProgress?.({ phaseKey: 'cloudSync.progress.apply', current: processed, total: diff.plan.length });
    }

    // 本地下行统一落库：一次全量读取、一次密钥派生、批量加解密、一次写回。
    if (pendingPullCreates.length > 0 || pendingPullUpdates.length > 0) {
      const result = await batchApplyPasswordChanges(
        pendingPullCreates.map(({ entry, explicitId, groupId }) => ({
          id: explicitId,
          entry: {
            username: entry.username,
            password: entry.password,
            url: entry.url,
            tag: entry.tag,
            remark: entry.remark,
            totp: entry.totp,
            // 优先还原云端记录的原始创建时间；旧表无「创建时间」列（解析为 0）时
            // 才回退为拉取时刻，避免把跨设备同步过来的条目创建时间全部压成 now。
            createTime: entry.createTime || now,
            updateTime: entry.updateTime || now,
            groupId,
          },
        })),
        pendingPullUpdates.map(({ businessId, entry, groupId }) => ({
          id: businessId,
          updates: {
            username: entry.username,
            password: entry.password,
            url: entry.url,
            tag: entry.tag,
            remark: entry.remark,
            totp: entry.totp,
            updateTime: entry.updateTime || now,
            groupId,
          },
        })),
        masterPassword,
      );

      for (let index = 0; index < pendingPullCreates.length; index += 1) {
        const pending = pendingPullCreates[index];
        const created = result.created[index];
        if (!created) throw new Error('批量写入结果缺失');
        working = withEntries(working, {
          [created.id]: {
            hash: await computeEntryHash(pending.entry),
            recordId: pending.row.recordId,
            syncedAt: now,
            version: pending.metadata.version,
            updatedAt: pending.metadata.updatedAt || pending.entry.updateTime || now,
            deletedAt: pending.metadata.deletedAt,
            lastWriterDeviceId: pending.metadata.lastWriterDeviceId,
          },
        });
      }
      for (const pending of pendingPullUpdates) {
        working = withEntries(working, {
          [pending.businessId]: {
            hash: await computeEntryHash(pending.entry),
            recordId: pending.row.recordId,
            syncedAt: now,
            version: pending.metadata.version,
            updatedAt: pending.metadata.updatedAt,
            deletedAt: pending.metadata.deletedAt,
            lastWriterDeviceId: pending.metadata.lastWriterDeviceId,
          },
        });
      }
      stats.pulled += pendingPullCreates.length + pendingPullUpdates.length;
    }

    // 批量推送：新增与更新合并为一次调用，内部按平台上限分批
    const upsertRows: UpsertRow[] = [];
    const pushKind = new Map<string, 'created' | 'updated' | 'deleted'>();
    const pushMetadata = new Map<string, PlaintextSyncMetadata>();
    const pushHash = new Map<string, string>();
    for (const item of createItems) {
      const snapshotEntry = working.entries[item.entry.id];
      const cloudRow = cloudByBusinessId.get(item.entry.id);
      const metadata = writeMetadata(
        item.entry,
        snapshotEntry,
        cloudRow ? readPlaintextMetadata(cloudRow.fields) : undefined,
        deviceId,
      );
      const sanitized = sanitizeFields(entryToFields(item.entry, metadata));
      truncated.push(...sanitized.truncated);
      upsertRows.push({ recordId: '', businessId: item.entry.id, fields: sanitized.fields });
      pushKind.set(item.entry.id, 'created');
      pushMetadata.set(item.entry.id, metadata);
      pushHash.set(item.entry.id, await computeEntryHash(item.entry));
    }
    for (const item of updateItems) {
      const snapshotEntry = working.entries[item.entry.id];
      const cloudRow = cloudByRecordId.get(item.recordId) ?? cloudByBusinessId.get(item.entry.id);
      const metadata = writeMetadata(
        item.entry,
        snapshotEntry,
        cloudRow ? readPlaintextMetadata(cloudRow.fields) : undefined,
        deviceId,
      );
      const sanitized = sanitizeFields(entryToFields(item.entry, metadata));
      truncated.push(...sanitized.truncated);
      upsertRows.push({ recordId: item.recordId, businessId: item.entry.id, fields: sanitized.fields });
      pushKind.set(item.entry.id, 'updated');
      pushMetadata.set(item.entry.id, metadata);
      pushHash.set(item.entry.id, await computeEntryHash(item.entry));
    }
    for (const item of tombstoneItems) {
      const snapshotEntry = working.entries[item.businessId];
      const cloudRow = cloudByRecordId.get(item.recordId) ?? cloudByBusinessId.get(item.businessId);
      const cloudMetadata = cloudRow ? readPlaintextMetadata(cloudRow.fields) : undefined;
      // 墓碑行仍保留云端记录的原始创建时间，删除后若被恢复不丢失 createTime
      const cloudCreateTime = cloudRow ? fieldsToEntry(cloudRow.fields).entry.createTime : 0;
      const deletedAt = now;
      const syntheticEntry: LocalSyncEntry = {
        id: item.businessId,
        username: '',
        password: '',
        url: '',
        tag: '',
        remark: '',
        totp: '',
        groupPath: '',
        createTime: cloudCreateTime || now,
        updateTime: cloudMetadata?.updatedAt || now,
      };
      const metadata = {
        ...writeMetadata(syntheticEntry, snapshotEntry, cloudMetadata, deviceId, deletedAt),
        deletedAt,
      };
      const sanitized = sanitizeFields(entryToFields(syntheticEntry, metadata));
      truncated.push(...sanitized.truncated);
      upsertRows.push({ recordId: item.recordId, businessId: item.businessId, fields: sanitized.fields });
      pushKind.set(item.businessId, 'deleted');
      pushMetadata.set(item.businessId, metadata);
      pushHash.set(item.businessId, await computeEntryHash(syntheticEntry));
    }

    // 先留档后删除：回收站写入失败不阻断主同步（flushTrash 内部记警告），
    // 但保证删除动作发生时留档已尽力完成，最大限度降低误删不可恢复的风险。
    await flushTrash();

    if (upsertRows.length > 0) {
      const result = await runBatch(() => adapter.batchUpsert(upsertRows));
      const succeededIds = new Set(result.succeeded.map(item => item.businessId));
      for (const succeeded of result.succeeded) {
        const kind = pushKind.get(succeeded.businessId);
        const metadata = pushMetadata.get(succeeded.businessId);
        const matchingRow = upsertRows.find(row => row.businessId === succeeded.businessId);
        if (!kind || !metadata || !matchingRow) continue;
        if (kind === 'created') {
          stats.created += 1;
          const hash = pushHash.get(succeeded.businessId);
          if (!hash) continue;
          working = withEntries(working, {
            [succeeded.businessId]: {
              hash,
              recordId: succeeded.recordId,
              syncedAt: now,
              version: metadata.version,
              updatedAt: metadata.updatedAt,
              deletedAt: metadata.deletedAt,
              lastWriterDeviceId: metadata.lastWriterDeviceId,
            },
          });
        } else if (kind === 'updated') {
          stats.updated += 1;
          const hash = pushHash.get(succeeded.businessId);
          if (!hash) continue;
          working = withEntries(working, {
            [succeeded.businessId]: {
              hash,
              recordId: succeeded.recordId,
              syncedAt: now,
              version: metadata.version,
              updatedAt: metadata.updatedAt,
              deletedAt: metadata.deletedAt,
              lastWriterDeviceId: metadata.lastWriterDeviceId,
            },
          });
        } else {
          stats.deleted += 1;
          const hash = pushHash.get(succeeded.businessId);
          if (!hash) continue;
          working = withEntries(working, {
            [succeeded.businessId]: {
              hash,
              recordId: succeeded.recordId,
              syncedAt: now,
              version: metadata.version,
              updatedAt: metadata.updatedAt,
              deletedAt: metadata.deletedAt,
              lastWriterDeviceId: metadata.lastWriterDeviceId,
            },
          });
        }
      }
      for (const item of result.failed) {
        stats.failed += 1;
        failures.push({ businessId: item.businessId, code: item.code, message: item.message });
      }
      for (const row of upsertRows) {
        if (!succeededIds.has(row.businessId) && !result.failed.some(f => f.businessId === row.businessId)) {
          stats.failed += 1;
          failures.push({ businessId: row.businessId, code: 'missing-result', message: 'batch result missing' });
        }
      }
    }

    if (deleteRecordIds.length > 0) {
      const result = await runBatch(() => adapter.batchDelete(deleteRecordIds));
      stats.deleted += result.succeeded.length;
      stats.failed += result.failed.length;
      failures.push(...result.failed);
    }

    await saveSnapshot(working);
    await patchProviderConfig(provider, { lastSyncAt: Date.now() });
    auditFailed = !(await audit(
      makeAuditEntry(provider, 'plaintext', 'sync', docKey, {
        stats,
        recordIds: Object.values(working.entries)
          .map(entry => entry.recordId)
          .slice(0, 20),
        conflictIds: conflictDetails.map(detail => detail.businessId),
      }),
    ));
    if (auditFailed) warnings.push({ key: 'cloudSync.warning.auditLogFailed' });
    if (snapshotDegraded) warnings.push({ key: 'cloudSync.warning.snapshotDegraded' });
    if (providerConfig.target.allowInsecure) warnings.push({ key: 'cloudSync.warning.insecureTransport' });
  } catch (error) {
    if (isAbortError(error)) {
      cancelled = true;
    } else {
      const normalized = toCloudSyncError(error);
      stats.failed += 1;
      failures.push({ businessId: '', code: normalized.code ?? normalized.kind, message: normalized.message });
      logger.error('云同步明文同步失败:', normalized);
      throw normalized;
    }
  } finally {
    await lock.handle.release();
  }

  return buildReport(
    provider,
    'plaintext',
    docKey,
    startedAt,
    stats,
    conflictDetails,
    failures,
    warnings,
    truncated,
    apiCalls,
    cancelled,
  );
}

/** 批量执行包装：把平台错误转换为失败明细，避免整个流程中断 */
async function runBatch(action: () => Promise<BatchResult>): Promise<BatchResult> {
  try {
    return await action();
  } catch (error) {
    const normalized = toCloudSyncError(error);
    return {
      succeeded: [],
      failed: [{ businessId: '', code: normalized.code ?? normalized.kind, message: normalized.message }],
    };
  }
}

// ==================== 密文备份与恢复 ====================

/** cipher 行 → 分片结构（云端数据不可信，逐字段强制转换并校验） */
export function rowsToChunks(rows: CloudRow[]): SnapshotChunkRow[] {
  const chunks: SnapshotChunkRow[] = [];
  for (const row of rows) {
    const text = (key: string): string => {
      const value = row.fields[key];
      return typeof value === 'number' ? String(value) : (value ?? '');
    };
    const partKey = text(ENCRYPTED_FIELDS.partKey);
    const snapshotGroupId = text(ENCRYPTED_FIELDS.snapshotGroupId);
    const payload = text(ENCRYPTED_FIELDS.payload);
    if (!snapshotGroupId || !partKey || !payload) continue;
    chunks.push({
      partKey,
      snapshotGroupId,
      partIndex: Number(row.fields[ENCRYPTED_FIELDS.partIndex]) || 0,
      totalParts: Number(row.fields[ENCRYPTED_FIELDS.totalParts]) || 1,
      snapshotHash: text(ENCRYPTED_FIELDS.snapshotHash),
      partHash: text(ENCRYPTED_FIELDS.partHash),
      payload,
      version: Number(row.fields[ENCRYPTED_FIELDS.version]) || 1,
      exportedAt: Number(row.fields[ENCRYPTED_FIELDS.exportedAt]) || 0,
    });
  }
  return chunks;
}

/** 分片结构 → 待写入行 */
export function chunksToUpsertRows(chunks: SnapshotChunkRow[]): UpsertRow[] {
  return chunks.map(chunk => ({
    recordId: '',
    businessId: chunk.partKey,
    fields: {
      [ENCRYPTED_FIELDS.partKey]: chunk.partKey,
      [ENCRYPTED_FIELDS.snapshotGroupId]: chunk.snapshotGroupId,
      [ENCRYPTED_FIELDS.partIndex]: chunk.partIndex,
      [ENCRYPTED_FIELDS.totalParts]: chunk.totalParts,
      [ENCRYPTED_FIELDS.snapshotHash]: chunk.snapshotHash,
      [ENCRYPTED_FIELDS.partHash]: chunk.partHash,
      [ENCRYPTED_FIELDS.payload]: chunk.payload,
      [ENCRYPTED_FIELDS.version]: chunk.version,
      [ENCRYPTED_FIELDS.exportedAt]: chunk.exportedAt,
    },
  }));
}

/**
 * 密文备份：全量加密 + 分片写入 + 版本保留
 *
 * 任一分片写入失败即清理该分组的已写入分片，并报告失败原因；**全部分片成功**
 * 才更新本地元数据。
 */
export async function runEncryptedBackup(
  provider: CloudProvider,
  masterPassword: string,
  options: SyncRunOptions = {},
): Promise<SyncReport> {
  const startedAt = Date.now();
  const { config, providerConfig, credentials, docKey } = await loadReadyContext(provider);
  if (providerConfig.mode !== 'encrypted') throw new CloudSyncError('unknown', 'provider not in encrypted mode');

  const targetKey = `${provider}:${docKey}`;
  const lock = await acquireTaskLock(targetKey);
  if (!lock.ok) throw new CloudSyncError('writeConflict', 'sync task already running');

  const stats = emptyStats();
  const failures: SyncReport['failures'] = [];
  const warnings: SyncReport['warnings'] = [];
  let apiCalls = 0;
  let cancelled = false;
  let chunkDowngrades = 0;

  try {
    const adapter = createAdapter(provider, providerConfig.target, credentials, {
      signal: options.signal,
      onApiCall: () => {
        apiCalls += 1;
      },
    });

    const [entries, groups] = await Promise.all([getAllPasswords(masterPassword), getAllGroups()]);
    options.onProgress?.({ phaseKey: 'cloudSync.progress.encrypt', current: 0, total: 1 });

    // 前置清理：超期残缺孤儿分组（失败中断留下的半成品），避免云端垃圾累积
    const existingRows = await adapter.getRows();
    const existingChunks = rowsToChunks(existingRows);
    const orphanGroups = selectOrphanGroups(groupChunks(existingChunks));
    for (const groupId of orphanGroups) {
      const recordIds = existingRows
        .filter(row => row.fields[ENCRYPTED_FIELDS.snapshotGroupId] === groupId)
        .map(row => row.recordId);
      if (recordIds.length > 0) await runBatch(() => adapter.batchDelete(recordIds));
    }

    let chunkSize = providerConfig.chunkSize;
    let result = await encryptAndChunk(entries, masterPassword, chunkSize, Date.now(), groups);
    let written = false;

    for (;;) {
      options.onProgress?.({ phaseKey: 'cloudSync.progress.upload', current: 0, total: 1 });
      const batch = await runBatch(() => adapter.batchUpsert(chunksToUpsertRows(result.rows)));
      const allFailed = batch.failed.find(item => item.code === 'tooLarge' || item.code === 1254130);
      if (allFailed && batch.succeeded.length === 0) {
        const smaller = nextChunkSize(chunkSize);
        if (smaller === null) {
          throw new CloudSyncError('tooLarge', 'platform rejects chunk size below minimum', allFailed.code);
        }
        chunkDowngrades += 1;
        chunkSize = smaller;
        result = await encryptAndChunk(entries, masterPassword, chunkSize, Date.now(), groups);
        continue;
      }
      if (batch.failed.length > 0 || batch.succeeded.length !== result.rows.length) {
        // 部分失败：清理该分组已写入分片，避免留下半成品
        await runBatch(() => adapter.batchDelete(batch.succeeded.map(item => item.recordId)));
        failures.push(...batch.failed);
        stats.failed += batch.failed.length || 1;
        throw new CloudSyncError('unknown', 'partial chunk write failed');
      }
      written = true;
      stats.created += batch.succeeded.length;
      break;
    }

    if (written) {
      await patchProviderConfig(provider, {
        chunkSize,
        lastSyncAt: Date.now(),
      });
      const meta: EncryptedSnapshotMeta = {
        provider,
        docKey,
        snapshotGroupId: result.snapshotGroupId,
        snapshotHash: result.snapshotHash,
        exportedAt: result.exportedAt,
        totalParts: result.rows.length,
      };
      await saveEncryptedMeta(meta);

      // 版本保留策略：删除超出保留数的旧分组（默认保留最近 3 个完整版本）
      const allRows = await adapter.getRows();
      const allChunks = rowsToChunks(allRows);
      const groups = groupChunks(allChunks);
      const pruneGroups = selectVersionsToPrune(groups, config.keepVersions);
      for (const groupId of pruneGroups) {
        const recordIds = allRows
          .filter(row => row.fields[ENCRYPTED_FIELDS.snapshotGroupId] === groupId)
          .map(row => row.recordId);
        if (recordIds.length > 0) await runBatch(() => adapter.batchDelete(recordIds));
      }
      await audit(makeAuditEntry(provider, 'encrypted', 'backup', docKey, { stats }));
    }
    if (providerConfig.target.allowInsecure) warnings.push({ key: 'cloudSync.warning.insecureTransport' });
  } catch (error) {
    if (isAbortError(error)) {
      cancelled = true;
    } else {
      const normalized = toCloudSyncError(error);
      if (stats.failed === 0) stats.failed += 1;
      failures.push({ businessId: '', code: normalized.code ?? normalized.kind, message: normalized.message });
      logger.error('云同步密文备份失败:', normalized);
      throw normalized;
    }
  } finally {
    await lock.handle.release();
  }

  return buildReport(
    provider,
    'encrypted',
    docKey,
    startedAt,
    stats,
    [],
    failures,
    warnings,
    [],
    apiCalls,
    cancelled,
    chunkDowngrades,
  );
}

/**
 * 密文恢复：读取云端分片 → 校验链 → 解密 → 按 ID 增量合并
 *
 * **恢复不删除本地任何条目**；本地较新的条目跳过，不覆盖本地新值。
 */
export async function runEncryptedRestore(
  provider: CloudProvider,
  masterPassword: string,
  options: SyncRunOptions = {},
): Promise<SyncReport> {
  const startedAt = Date.now();
  const { providerConfig, credentials, docKey } = await loadReadyContext(provider);

  const targetKey = `${provider}:${docKey}`;
  const lock = await acquireTaskLock(targetKey);
  if (!lock.ok) throw new CloudSyncError('writeConflict', 'sync task already running');

  const stats = emptyStats();
  const failures: SyncReport['failures'] = [];
  const warnings: ReportWarnings = [];
  let apiCalls = 0;

  try {
    const adapter = createAdapter(provider, providerConfig.target, credentials, {
      signal: options.signal,
      onApiCall: () => {
        apiCalls += 1;
      },
    });

    options.onProgress?.({ phaseKey: 'cloudSync.progress.download', current: 0, total: 1 });
    const chunks = rowsToChunks(await adapter.getRows());
    const groups = groupChunks(chunks);
    const meta = await loadEncryptedMeta(provider, docKey);

    const candidates = meta ? groups.filter(group => group.snapshotGroupId === meta.snapshotGroupId) : groups;
    const group = candidates.find(candidate => candidate.complete) ?? groups.find(candidate => candidate.complete);
    if (!group) {
      throw new CloudSyncError('notFound', 'no complete snapshot found');
    }

    options.onProgress?.({ phaseKey: 'cloudSync.progress.verify', current: 0, total: 1 });
    const verified = await verifyAndDecryptSnapshot(group, masterPassword);
    if (!verified.ok) {
      throw new CloudSyncError('schema', `snapshot verification failed: ${verified.reason}`, verified.reason);
    }

    const [localEntries, localGroups] = await Promise.all([getAllPasswords(masterPassword), getAllGroups()]);
    const { groups: mergedGroups, codeMap } = await mergeSnapshotGroups(verified.payload.groups, localGroups);
    const localGroupCodes = new Set(mergedGroups.map(group => group.code));
    const localById = new Map(localEntries.map(entry => [entry.id, entry]));
    let added = 0;
    let updated = 0;
    let skipped = 0;
    const rejected = 0;

    const now = Date.now();
    for (const remote of verified.payload.entries) {
      if (options.signal?.aborted) break;
      const local = localById.get(remote.id);
      const groupId =
        (remote.groupId ? codeMap.get(remote.groupId) : undefined) ??
        (remote.groupId && localGroupCodes.has(remote.groupId) ? remote.groupId : undefined);
      if (!local) {
        await savePassword(
          {
            username: remote.username,
            password: remote.password,
            url: remote.url,
            tag: remote.tag,
            remark: remote.remark,
            totp: remote.totp,
            createTime: remote.createTime || now,
            updateTime: remote.updateTime || now,
            groupId,
          },
          masterPassword,
        );
        added += 1;
      } else if ((remote.updateTime || 0) > (local.updateTime || 0)) {
        await updatePassword(
          local.id,
          {
            username: remote.username,
            password: remote.password,
            url: remote.url,
            tag: remote.tag,
            remark: remote.remark,
            totp: remote.totp,
            updateTime: remote.updateTime || now,
            groupId,
          },
          masterPassword,
        );
        updated += 1;
      } else {
        skipped += 1;
      }
    }

    stats.pulled = added + updated;
    stats.skipped = skipped;
    stats.failed = rejected;
    if (providerConfig.target.allowInsecure) warnings.push({ key: 'cloudSync.warning.insecureTransport' });
    await patchProviderConfig(provider, { lastSyncAt: Date.now() });
    await audit(makeAuditEntry(provider, 'encrypted', 'restore', docKey, { stats }));

    const report = buildReport(
      provider,
      'encrypted',
      docKey,
      startedAt,
      stats,
      [],
      failures,
      warnings,
      [],
      apiCalls,
      false,
    );
    report.restore = { added, updated, skipped, rejected };
    return report;
  } catch (error) {
    const normalized = toCloudSyncError(error);
    logger.error('云同步密文恢复失败:', normalized);
    throw normalized;
  } finally {
    await lock.handle.release();
  }
}

/** 警告列表类型别名（避免重复书写）。 */
type ReportWarnings = SyncReport['warnings'];

/**
 * 明文模式：全量拉取云端重建本地快照（修复快照丢失/不一致）
 */
export async function rebuildSnapshot(
  provider: CloudProvider,
  masterPassword: string,
  options: SyncRunOptions = {},
): Promise<SyncReport> {
  const startedAt = Date.now();
  const { providerConfig, credentials, docKey } = await loadReadyContext(provider);
  const targetKey = `${provider}:${docKey}`;
  const lock = await acquireTaskLock(targetKey);
  if (!lock.ok) throw new CloudSyncError('writeConflict', 'sync task already running');

  const stats = emptyStats();
  let apiCalls = 0;

  try {
    const adapter = createAdapter(provider, providerConfig.target, credentials, {
      signal: options.signal,
      onApiCall: () => {
        apiCalls += 1;
      },
    });
    const cloudRows = await adapter.getRows();
    const [localPasswords, localGroups] = await Promise.all([getAllPasswords(masterPassword), getAllGroups()]);
    const localEntries = localPasswords.map(entry => toLocalSyncEntry(entry, buildGroupPathMap(localGroups)));
    const localById = new Map(localEntries.map(entry => [entry.id, entry]));
    const now = Date.now();

    let snapshot = createEmptySnapshot(provider, docKey);
    for (const row of cloudRows) {
      const businessId = readBusinessId(row.fields);
      if (!businessId || !localById.has(businessId)) continue;
      const entry = localById.get(businessId)!;
      snapshot = withEntries(snapshot, {
        [businessId]: { hash: await computeEntryHash(entry), recordId: row.recordId, syncedAt: now },
      });
    }
    await saveSnapshot(snapshot);
    await audit(makeAuditEntry(provider, 'plaintext', 'rebuild', docKey, { stats }));
  } finally {
    await lock.handle.release();
  }

  return buildReport(provider, 'plaintext', docKey, startedAt, stats, [], [], [], [], apiCalls, false);
}

/**
 * 密文模式：按保留策略清理云端旧版本分组（不动本地）
 */
export async function clearOldSnapshotVersions(
  provider: CloudProvider,
  options: SyncRunOptions = {},
): Promise<SyncReport> {
  const startedAt = Date.now();
  const { config, providerConfig, credentials, docKey } = await loadReadyContext(provider);
  const targetKey = `${provider}:${docKey}`;
  const lock = await acquireTaskLock(targetKey);
  if (!lock.ok) throw new CloudSyncError('writeConflict', 'sync task already running');

  const stats = emptyStats();
  let apiCalls = 0;

  try {
    const adapter = createAdapter(provider, providerConfig.target, credentials, {
      signal: options.signal,
      onApiCall: () => {
        apiCalls += 1;
      },
    });
    const rows = await adapter.getRows();
    const chunks = rowsToChunks(rows);
    const groups = groupChunks(chunks);
    const pruneIds = selectVersionsToPrune(groups, config.keepVersions);
    for (const groupId of pruneIds) {
      const recordIds = rows
        .filter(row => row.fields[ENCRYPTED_FIELDS.snapshotGroupId] === groupId)
        .map(row => row.recordId);
      if (recordIds.length === 0) continue;
      const result = await runBatch(() => adapter.batchDelete(recordIds));
      stats.deleted += result.succeeded.length;
      stats.failed += result.failed.length;
    }
    await audit(makeAuditEntry(provider, 'encrypted', 'clearVersions', docKey, { stats }));
  } finally {
    await lock.handle.release();
  }

  return buildReport(provider, 'encrypted', docKey, startedAt, stats, [], [], [], [], apiCalls, false);
}
