/**
 * 云端表结构与字段映射（设计规格 §4）
 *
 * 两平台共用同一套**中文字段名**（密文表用英文技术名），使云端文档对人可读，
 * 也让 diff/syncEngine 完全平台无关。平台侧的字段类型枚举差异由适配器翻译。
 *
 * 关键约束：
 * - 索引列（飞书 is_primary）不可隐藏且仅支持部分类型，故明文表首列设为「用户名」、
 *   密文表首列设为 partKey；
 * - 明文表列序按「人读优先」编排：账号三要素（用户名/网址/密码）→ 组织维度
 *   （分组/标签/备注/TOTP）→ 同步元数据（ID/写入设备/删除时间/版本/创建时间/
 *   本地更新时间）。元数据列在飞书侧隐藏；腾讯不支持隐藏字段时保持可见但集中在
 *   末段，不干扰阅读；
 * - 云端修改时间**不建字段**，从 record 元数据读取（规避系统字段只读不可写的坑）。
 *   「创建时间」则相反——它同步的是**本地条目的** createTime（不可变元数据），
 *   目的是让跨设备拉取能还原原始创建时间，而非平台侧的系统创建时间。
 */
import type { CloudSyncMode, LocalSyncEntry, PlaintextSyncMetadata, TableFieldSpec } from './types';

/** 明文模式主表名（中文，对人可读） */
export const PLAINTEXT_TABLE_NAME = '账号密码管家';

/** 密文模式主表名 */
export const ENCRYPTED_TABLE_NAME = '账号密码管家-密文备份';

/** 明文模式回收站表名：本地删除的条目在此留档，可在文档中手工复制回主表恢复 */
export const PLAINTEXT_TRASH_TABLE_NAME = '账号密码管家回收站';

/** 明文表字段名 */
export const PLAINTEXT_FIELDS = {
  username: '用户名',
  password: '密码',
  url: '网址',
  tag: '标签',
  remark: '备注',
  totp: 'TOTP',
  group: '分组',
  createTime: '创建时间',
  localUpdateTime: '本地更新时间',
  id: 'ID',
  version: '版本',
  deletedAt: '删除时间',
  lastWriterDeviceId: '最后写入设备',
} as const;

/**
 * 旧版明文表可安全补充的元数据字段。
 *
 * 这些字段只用于增强 LWW 裁决、删除传播与创建时间保真，旧表缺失时可以在测试连接
 * 阶段补建：不会删除或修改用户已有列。
 */
export const PLAINTEXT_METADATA_FIELD_NAMES = [
  PLAINTEXT_FIELDS.version,
  PLAINTEXT_FIELDS.deletedAt,
  PLAINTEXT_FIELDS.lastWriterDeviceId,
  PLAINTEXT_FIELDS.createTime,
] as const;

/** 密文表字段名 */
export const ENCRYPTED_FIELDS = {
  partKey: 'partKey',
  snapshotGroupId: 'snapshotGroupId',
  partIndex: 'partIndex',
  totalParts: 'totalParts',
  snapshotHash: 'snapshotHash',
  partHash: 'partHash',
  payload: 'payload',
  version: 'version',
  exportedAt: 'exportedAt',
} as const;

/**
 * 明文表结构规格（顺序即云端列顺序）
 *
 * 列序按「人读优先」编排：先账号三要素（用户名/网址/密码），再组织维度（分组/标签/
 * 备注/TOTP），最后是同步元数据（ID/写入设备/删除时间/版本/创建时间/本地更新时间）。
 * 元数据列在飞书侧隐藏；腾讯不支持隐藏字段时保持可见但集中在末段，不干扰阅读。
 */
export const PLAINTEXT_TABLE_SPEC: TableFieldSpec[] = [
  { name: PLAINTEXT_FIELDS.username, type: 'text', primary: true },
  { name: PLAINTEXT_FIELDS.url, type: 'text' },
  { name: PLAINTEXT_FIELDS.password, type: 'text' },
  { name: PLAINTEXT_FIELDS.group, type: 'text' },
  { name: PLAINTEXT_FIELDS.tag, type: 'text' },
  { name: PLAINTEXT_FIELDS.remark, type: 'text' },
  { name: PLAINTEXT_FIELDS.totp, type: 'text' },
  { name: PLAINTEXT_FIELDS.id, type: 'text', hidden: true },
  { name: PLAINTEXT_FIELDS.lastWriterDeviceId, type: 'text', hidden: true },
  { name: PLAINTEXT_FIELDS.deletedAt, type: 'number', hidden: true },
  { name: PLAINTEXT_FIELDS.version, type: 'number', hidden: true },
  { name: PLAINTEXT_FIELDS.createTime, type: 'number', hidden: true },
  { name: PLAINTEXT_FIELDS.localUpdateTime, type: 'number' },
];

/** 密文表结构规格 */
export const ENCRYPTED_TABLE_SPEC: TableFieldSpec[] = [
  { name: ENCRYPTED_FIELDS.partKey, type: 'text', primary: true },
  { name: ENCRYPTED_FIELDS.snapshotGroupId, type: 'text' },
  { name: ENCRYPTED_FIELDS.partIndex, type: 'number' },
  { name: ENCRYPTED_FIELDS.totalParts, type: 'number' },
  { name: ENCRYPTED_FIELDS.snapshotHash, type: 'text' },
  { name: ENCRYPTED_FIELDS.partHash, type: 'text' },
  { name: ENCRYPTED_FIELDS.payload, type: 'text' },
  { name: ENCRYPTED_FIELDS.version, type: 'text' },
  { name: ENCRYPTED_FIELDS.exportedAt, type: 'number' },
];

/**
 * 回收站表字段名
 *
 * 与主表同构（直接复用 `entryToFields` 的产出整行写入），额外加一列「回收时间」
 * 记录移入回收站的时刻，便于在文档中按时间排序查看。
 */
export const TRASH_FIELDS = {
  trashedAt: '回收时间',
} as const;

/**
 * 回收站表结构规格
 *
 * 复用明文主表的全部列（保证主表行可整行搬入/搬回），末位追加「回收时间」。
 * 首列仍为「用户名」（索引列不可隐藏），与主表口径一致。
 */
export const TRASH_TABLE_SPEC: TableFieldSpec[] = [
  ...PLAINTEXT_TABLE_SPEC,
  { name: TRASH_FIELDS.trashedAt, type: 'number' },
];

/** 按模式取主表名 */
export function getTableName(mode: CloudSyncMode): string {
  return mode === 'encrypted' ? ENCRYPTED_TABLE_NAME : PLAINTEXT_TABLE_NAME;
}

/** 按模式取表结构规格 */
export function getTableSpec(mode: CloudSyncMode): TableFieldSpec[] {
  return mode === 'encrypted' ? ENCRYPTED_TABLE_SPEC : PLAINTEXT_TABLE_SPEC;
}

/**
 * 结构校验所需的关键字段名
 *
 * 只校验「缺了就无法同步」的核心字段，允许用户自行追加自定义列
 * （不因多余字段判定结构不符，避免误伤）。
 */
export function getRequiredFieldNames(mode: CloudSyncMode): string[] {
  return mode === 'encrypted'
    ? [
        ENCRYPTED_FIELDS.partKey,
        ENCRYPTED_FIELDS.snapshotGroupId,
        ENCRYPTED_FIELDS.partIndex,
        ENCRYPTED_FIELDS.totalParts,
        ENCRYPTED_FIELDS.snapshotHash,
        ENCRYPTED_FIELDS.partHash,
        ENCRYPTED_FIELDS.payload,
        ENCRYPTED_FIELDS.version,
        ENCRYPTED_FIELDS.exportedAt,
      ]
    : [
        PLAINTEXT_FIELDS.username,
        PLAINTEXT_FIELDS.password,
        PLAINTEXT_FIELDS.url,
        PLAINTEXT_FIELDS.tag,
        PLAINTEXT_FIELDS.remark,
        PLAINTEXT_FIELDS.totp,
        PLAINTEXT_FIELDS.group,
        PLAINTEXT_FIELDS.createTime,
        PLAINTEXT_FIELDS.localUpdateTime,
        PLAINTEXT_FIELDS.version,
        PLAINTEXT_FIELDS.deletedAt,
        PLAINTEXT_FIELDS.lastWriterDeviceId,
        PLAINTEXT_FIELDS.id,
      ];
}

/**
 * 参与内容哈希的同步字段（固定顺序）
 *
 * **明确不含 ID、updateTime、云端修改时间**：扩展自身推送会刷新云端 record
 * 修改时间，若混入会导致哈希恒 ≠ 快照，把「刚推完的行」误判为「云端侧变更」。
 * groupPath 参与哈希：分组归属变更需要触发 LWW 同步。
 */
export const SYNCED_TEXT_FIELDS = ['username', 'password', 'url', 'tag', 'remark', 'totp', 'groupPath'] as const;

export function emptyPlaintextMetadata(deviceId = ''): PlaintextSyncMetadata {
  return { version: 0, updatedAt: 0, deletedAt: 0, lastWriterDeviceId: deviceId };
}

/** 本地条目 → 云端行字段（明文模式） */
export function entryToFields(
  entry: LocalSyncEntry,
  metadata: PlaintextSyncMetadata = emptyPlaintextMetadata(),
): Record<string, string | number> {
  return {
    [PLAINTEXT_FIELDS.username]: entry.username,
    [PLAINTEXT_FIELDS.password]: entry.password,
    [PLAINTEXT_FIELDS.url]: entry.url,
    [PLAINTEXT_FIELDS.tag]: entry.tag,
    [PLAINTEXT_FIELDS.remark]: entry.remark,
    [PLAINTEXT_FIELDS.totp]: entry.totp,
    [PLAINTEXT_FIELDS.group]: entry.groupPath,
    [PLAINTEXT_FIELDS.createTime]: entry.createTime,
    [PLAINTEXT_FIELDS.localUpdateTime]: metadata.updatedAt || entry.updateTime,
    [PLAINTEXT_FIELDS.version]: metadata.version,
    [PLAINTEXT_FIELDS.deletedAt]: metadata.deletedAt,
    [PLAINTEXT_FIELDS.lastWriterDeviceId]: metadata.lastWriterDeviceId,
    [PLAINTEXT_FIELDS.id]: entry.id,
  };
}

/**
 * 云端行字段 → 本地条目投影（明文模式）
 *
 * 云端数据视为**不可信输入**：所有值强制转字符串，缺失字段回退空串，
 * 数字字段（本地更新时间）单独解析并校验有限性。
 */
export function fieldsToEntry(fields: Record<string, string | number>): {
  entry: Omit<LocalSyncEntry, 'updateTime'>;
  updateTime: number;
  metadata: PlaintextSyncMetadata;
} {
  const text = (key: string): string => {
    const value = fields[key];
    return typeof value === 'number' ? String(value) : (value ?? '');
  };
  const number = (key: string): number => {
    const value = fields[key];
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const updateTime = number(PLAINTEXT_FIELDS.localUpdateTime);
  return {
    entry: {
      id: text(PLAINTEXT_FIELDS.id),
      username: text(PLAINTEXT_FIELDS.username),
      password: text(PLAINTEXT_FIELDS.password),
      url: text(PLAINTEXT_FIELDS.url),
      tag: text(PLAINTEXT_FIELDS.tag),
      remark: text(PLAINTEXT_FIELDS.remark),
      totp: text(PLAINTEXT_FIELDS.totp),
      groupPath: text(PLAINTEXT_FIELDS.group),
      createTime: number(PLAINTEXT_FIELDS.createTime),
    },
    updateTime,
    metadata: {
      version: number(PLAINTEXT_FIELDS.version),
      updatedAt: updateTime,
      deletedAt: number(PLAINTEXT_FIELDS.deletedAt),
      lastWriterDeviceId: text(PLAINTEXT_FIELDS.lastWriterDeviceId),
    },
  };
}

/** 从云端行读取业务 ID（可能为空串：用户在文档手工新增的行） */
export function readBusinessId(fields: Record<string, string | number>): string {
  const value = fields[PLAINTEXT_FIELDS.id];
  return typeof value === 'string' ? value.trim() : value === undefined ? '' : String(value);
}

export function readPlaintextMetadata(fields: Record<string, string | number>): PlaintextSyncMetadata {
  return fieldsToEntry(fields).metadata;
}
