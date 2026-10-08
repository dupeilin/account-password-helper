/**
 * 腾讯文档智能表 Smartsheet OpenAPI v2 适配器（设计规格 §3.1、§4）
 *
 * 平台事实（已用真实凭证 curl 端到端验证，见规格 V1.4 修订说明）：
 * - 域名 `https://docs.qq.com`，鉴权用三个独立 Header `Access-Token` / `Client-Id` /
 *   `Open-Id`，**不是** `Authorization: Bearer`；
 * - 路径前缀是 **`smartbook`**（`/openapi/smartbook/v2/...`）。开放平台文档站另有一套
 *   `saas/openapi/smartsheet/` 文档（`records:list` 子路径 + DELETE 方法 + 下划线命名），
 *   **与本适配器不是同一套 API**，实测 `smartsheet` 前缀返回网关级 404，不可混用；
 * - 无换取 token 接口，凭证由用户在开放平台手动生成后粘贴，需持久化（加密）；
 * - 增删改查共用同一 POST 路径，靠 body 顶层键区分（`getFields` / `addFields` /
 *   `getRecords` / `addRecords` / `updateRecords` / `deleteRecords`）；
 * - **响应在 `data` 下还要再套一层请求键**：`data.getRecords.records`、
 *   `data.getFields.fields`、`data.getSheet`（直接是数组）、`data.addRecords.records`；
 * - 文本字段值是数组 `[{ type: 'text', text: '...' }]`，数字字段是裸数字；`values` 以
 *   fieldTitle 为键，空记录的 `values` 为 `{}`；
 * - `fieldType` 是**整数枚举**（实测 `1=文本`、`2=数字`、`4=日期`、`5=图片`、`17=单选`）；
 * - record 字段名全为驼峰，自带 `updateTime`（字符串毫秒），LWW 直接读元数据不建系统
 *   字段；**从未修改过的记录 `updateTime` 为 `"0"`**，按 0 处理而非当作缺失；
 * - 删除记录的 body 键是 `recordIDs`（不是 `records`）；
 * - **文档 URL 里的 ID 是 encodedID，不能直接当 fileID 用**：须先经
 *   `GET /openapi/drive/v2/util/converter?type=2&value={encodedID}` 换取真 fileID
 *   （形如 `300000000$xxx`，含 `$`，拼 URL 时 `encodeURIComponent` 会转成 `%24`）。
 *   本适配器对此做惰性转换并缓存（见 `resolveFileId`）。
 */
import { CloudSyncError } from '../errors';
import type {
  AdapterOptions,
  BatchResult,
  CloudRow,
  SchemaCheckResult,
  TableAdapter,
  TableFieldSpec,
  TableMeta,
  TableSpec,
  TencentCredentials,
  UpsertRow,
} from '../types';
import { chunkItems, isTransientStatus, requestWithRetry } from './httpClient';
import { normalizeServerBaseUrl, resolveServerBaseUrl } from './serverAddress';

/** 官方 SaaS 开放平台地址 */
export const TENCENT_DEFAULT_BASE_URL = 'https://docs.qq.com';

/** 单次批量写入/删除建议上限（官方建议 ≤500） */
const BATCH_LIMIT = 500;

/** 分页单页上限 */
const PAGE_SIZE = 500;

/** 可重试的 HTTP/业务错误码 */
const RETRYABLE_CODES = new Set<number>([429]);

/** 构造参数 */
export interface TencentAdapterInit {
  fileId: string;
  /** 未建子表前为 null，建表成功后由调用方回填 */
  sheetId: string | null;
  /** 私有化部署的开放平台地址；留空或 null 使用官方 SaaS 地址 */
  baseUrl?: string | null;
  /** HTTP 明文传输已由用户显式确认 */
  allowInsecure?: boolean;
  credentials: TencentCredentials;
  options?: AdapterOptions;
}

/**
 * 归一化腾讯文档开放平台地址
 *
 * 空值回退官方地址；非法、非 http(s) 或未确认的内网 HTTP 地址抛 `notFound`。
 */
export function resolveTencentBaseUrl(input?: string | null, allowInsecure = false): string {
  return resolveServerBaseUrl(input, TENCENT_DEFAULT_BASE_URL, allowInsecure);
}

/** 把用户填写地址归一为可入库形态；官方地址与空值返回 `null` */
export function normalizeTencentBaseUrl(input?: string | null, allowInsecure = false): string | null {
  return normalizeServerBaseUrl(input, TENCENT_DEFAULT_BASE_URL, allowInsecure);
}

/** 腾讯响应外壳：平台统一用 `ret` 表示业务结果，`0` 为成功 */
interface TencentResponse<T> {
  ret: number;
  msg?: string;
  data?: T;
}

interface TencentField {
  fieldID?: string;
  fieldTitle?: string;
  /** 整数枚举，见 `FIELD_TYPE` */
  fieldType?: number;
}

interface TencentRecord {
  recordID?: string;
  /** 字符串毫秒；从未修改过的记录为 `"0"` */
  updateTime?: string | number;
  /** 以 fieldTitle 为键；空记录为 `{}` */
  values?: Record<string, unknown>;
}

/**
 * 平台字段类型整数枚举（实测确认）
 *
 * 本设计只用文本与数字两种；其余值（4=日期、5=图片、17=单选…）在 `listFields`
 * 归一化时一律降级为 text，不参与建表。
 */
const FIELD_TYPE = {
  text: 1,
  number: 2,
} as const;

/**
 * 把领域扁平字段编码为腾讯要求的平台值格式
 *
 * 数字字段传裸数字，其余一律包装为 `[{type:'text',text}]` 数组——这是与飞书
 * 最大的值格式差异，必须在适配器内消化，不能泄漏到上层。
 */
export function encodeFields(fields: Record<string, string | number>): Record<string, unknown> {
  const encoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    encoded[key] = typeof value === 'number' ? value : [{ type: 'text', text: String(value) }];
  }
  return encoded;
}

/** 把腾讯字段值归一化为扁平字符串/数字 */
export function fromTencentValue(value: unknown): string | number {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) return String((item as { text: unknown }).text ?? '');
        return '';
      })
      .join('');
  }
  return String(value);
}

/** 把腾讯业务错误码映射为领域错误类别 */
export function mapTencentErrorCode(code: number, msg: string): CloudSyncError {
  switch (code) {
    case 10313:
    case 10302:
    case 10303:
    case 37019:
      return new CloudSyncError('invalidCredential', msg, code);
    case 59000:
      // 个人微信账号被智能表 OpenAPI 拒绝：属平台账号类型限制，非用户可修复的凭证错误
      return new CloudSyncError('permission', msg, code);
    case 429:
      return new CloudSyncError('rateLimit', msg, code);
    case 40301:
      return new CloudSyncError('permission', msg, code);
    default:
      return new CloudSyncError('unknown', msg, code);
  }
}

/** 腾讯文档智能表适配器 */
export class TencentAdapter implements TableAdapter {
  readonly provider = 'tencent' as const;

  /** 构造时传入的文件标识：可能是 URL 里的 encodedID，也可能是已转换的真 fileID */
  private fileId: string;
  private sheetId: string | null;
  private credentials: TencentCredentials;
  private options: AdapterOptions;
  /** 本次实例生效的开放平台地址（官方 SaaS 或私有化部署） */
  private baseUrl: string;
  /** encodedID → 真 fileID 的转换缓存（实例级，避免每次请求都打转换接口） */
  private resolvedFileId: string | null = null;

  constructor(init: TencentAdapterInit) {
    this.fileId = init.fileId;
    this.sheetId = init.sheetId;
    this.credentials = init.credentials;
    this.options = init.options ?? {};
    this.baseUrl = resolveTencentBaseUrl(init.baseUrl, init.allowInsecure === true);
  }

  /** 建子表成功后回填 sheetID */
  setSheetId(sheetId: string): void {
    this.sheetId = sheetId;
  }

  /**
   * 取得可用于拼路径的真 fileID（惰性转换 + 实例级缓存）
   *
   * 真 fileID 形如 `300000000$xxx`（含 `$`）；URL 里解析出的 encodedID 不含 `$`。
   * 据此判别：已含 `$` 视为真 fileID 直接使用，否则调转换接口（实测
   * `drive/v2/util/converter?type=2`，响应在 `data.fileID`）。转换失败抛平台错误。
   */
  private async resolveFileId(): Promise<string> {
    if (this.resolvedFileId) return this.resolvedFileId;
    if (this.fileId.includes('$')) {
      this.resolvedFileId = this.fileId;
      return this.resolvedFileId;
    }
    const query = new URLSearchParams({ type: '2', value: this.fileId });
    const data = await this.request<{ fileID?: string }>(`/openapi/drive/v2/util/converter?${query.toString()}`);
    if (!data.fileID) throw new CloudSyncError('notFound', 'fileID converter returned no fileID');
    this.resolvedFileId = data.fileID;
    return this.resolvedFileId;
  }

  /** 鉴权头：三个独立 Header（测试连接复用三端点的最小请求） */
  private headers(hasBody: boolean): Record<string, string> {
    return {
      'Access-Token': this.credentials.accessToken,
      'Client-Id': this.credentials.clientId,
      'Open-Id': this.credentials.openId,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  /**
   * 统一请求入口（GET 列表 / POST 单路径 body 键区分）
   *
   * 平台错误既可能通过 HTTP 状态码表达，也可能通过 `ret` 字段表达，故两者都映射。
   */
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const { response, json } = await requestWithRetry(`${this.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: this.headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: this.options.signal,
      onApiCall: this.options.onApiCall,
      shouldRetry: context =>
        isTransientStatus(context.status, context.networkError) ||
        (typeof context.code === 'number' && RETRYABLE_CODES.has(context.code)),
    });

    const payload = json as TencentResponse<T> | null;
    if (!payload) {
      if (!response.ok) throw new CloudSyncError('network', `HTTP ${response.status}`, response.status);
      throw new CloudSyncError('unknown', 'unparsable response', response.status);
    }
    if (typeof payload.ret === 'number' && payload.ret !== 0) {
      throw mapTencentErrorCode(payload.ret, payload.msg ?? 'tencent error');
    }
    if (!response.ok) throw new CloudSyncError('network', `HTTP ${response.status}`, response.status);
    return (payload.data ?? ({} as T)) as T;
  }

  /**
   * 校验凭证有效性
   *
   * 无独立的 token 校验端点，故以「列出子表」作为最小鉴权探测：凭证错误会返回
   * 10302/10303/10313/37019，文档不存在会返回文档类错误码，两者可区分。
   */
  async testConnection(): Promise<void> {
    await this.listTables();
  }

  /**
   * 列出文件下的子表
   *
   * 实测查询子表接口**无分页参数**，一次性返回全部子表；响应为 `data.getSheet`
   * 数组（不是 `{sheets:[]}`），元素含 `sheetID` / `title`。
   */
  async listTables(): Promise<TableMeta[]> {
    const fileId = await this.resolveFileId();
    const data = await this.request<{
      getSheet?: { sheetID?: string; title?: string }[];
    }>(`/openapi/smartbook/v2/files/${encodeURIComponent(fileId)}/sheets`);
    const tables: TableMeta[] = [];
    for (const item of data.getSheet ?? []) {
      if (item.sheetID) tables.push({ id: item.sheetID, name: item.title ?? item.sheetID });
    }
    return tables;
  }

  /** 创建子表并补齐字段（官方 body：`{addSheet:{properties:{title}}}`，响应 `data.addSheet.properties.sheetID`） */
  async createTable(spec: TableSpec): Promise<TableMeta> {
    const fileId = await this.resolveFileId();
    const data = await this.request<{
      addSheet?: { properties?: { sheetID?: string; title?: string } };
    }>(`/openapi/smartbook/v2/files/${encodeURIComponent(fileId)}/sheets`, {
      addSheet: { properties: { title: spec.name } },
    });
    const sheetId = data.addSheet?.properties?.sheetID;
    if (!sheetId) throw new CloudSyncError('unknown', 'addSheet returned no sheet id');
    this.sheetId = sheetId;

    await this.addFields(spec.fields);
    return { id: sheetId, name: spec.name };
  }

  /**
   * 添加字段（`fieldType` 为整数枚举；腾讯不支持隐藏字段时按规格保留可见的末位 ID 列）
   *
   * 实测（ret=22017 "Smartsheet invalid number field"）：**数字字段必须携带
   * `propertyNumber`**，空对象即可（平台自动补 `decimalPlaces:0` 等默认值）；
   * 文本字段可省略 `propertyText`。
   */
  async addFields(fields: TableFieldSpec[]): Promise<void> {
    if (fields.length === 0) return;
    const path = await this.sheetPath();
    await this.request(path, {
      addFields: {
        fields: fields.map(field =>
          field.type === 'number'
            ? { fieldTitle: field.name, fieldType: FIELD_TYPE.number, propertyNumber: {} }
            : { fieldTitle: field.name, fieldType: FIELD_TYPE.text },
        ),
      },
    });
  }

  /** 读取字段（响应为 `data.getFields.fields`，分页遍历） */
  private async listFields(): Promise<TableFieldSpec[]> {
    const path = await this.sheetPath();
    const fields: TableFieldSpec[] = [];
    let offset = 0;
    for (;;) {
      const data = await this.request<{
        getFields?: { fields?: TencentField[]; hasMore?: boolean; next?: number; total?: number };
      }>(path, { getFields: { offset, limit: PAGE_SIZE } });
      const page = data.getFields;
      const items = page?.fields ?? [];
      for (const field of items) {
        fields.push({
          name: String(field.fieldTitle ?? ''),
          type: field.fieldType === FIELD_TYPE.number ? 'number' : 'text',
        });
      }
      if (!page?.hasMore || items.length === 0) break;
      offset = typeof page.next === 'number' ? page.next : offset + items.length;
    }
    return fields;
  }

  /** 校验既有表结构 */
  async checkTableSchema(requiredFields: TableFieldSpec[]): Promise<SchemaCheckResult> {
    const fields = await this.listFields();
    const byName = new Map(fields.map(f => [f.name, f]));
    const missingFields = requiredFields
      .filter(spec => {
        const actual = byName.get(spec.name);
        return !actual || actual.type !== spec.type;
      })
      .map(spec => spec.name);
    return missingFields.length === 0 ? { ok: true } : { ok: false, missingFields };
  }

  /** 全量读取记录（响应为 `data.getRecords.records`，分页遍历） */
  async getRows(): Promise<CloudRow[]> {
    const path = await this.sheetPath();
    const rows: CloudRow[] = [];
    let offset = 0;
    for (;;) {
      const data = await this.request<{
        getRecords?: { records?: TencentRecord[]; hasMore?: boolean; next?: number; total?: number };
      }>(path, { getRecords: { offset, limit: PAGE_SIZE } });
      const page = data.getRecords;
      const items = page?.records ?? [];
      for (const record of items) {
        const recordId = record.recordID ?? '';
        if (!recordId) continue;
        const fields: Record<string, string | number> = {};
        for (const [key, value] of Object.entries(record.values ?? {})) fields[key] = fromTencentValue(value);
        rows.push({
          recordId,
          fields,
          // 从未修改过的记录 updateTime 为 "0"，按 0 处理（LWW 会判本地胜，符合预期）
          cloudModifiedAt: Number(record.updateTime ?? 0) || 0,
        });
      }
      if (!page?.hasMore || items.length === 0) break;
      offset = typeof page.next === 'number' ? page.next : offset + items.length;
    }
    return rows;
  }

  /**
   * 批量新增/更新（按 500 分批，批间串行）
   *
   * 新增响应为 `data.addRecords.records`（元素含 `recordID`）。官方未承诺返回顺序与
   * 请求一致，但按序对位是当前唯一可行的回填方式；缺失项记为失败而不是猜测成功，
   * 上层会在下一轮同步经业务 ID 列重新对账（rebindRecordId）。
   */
  async batchUpsert(rows: UpsertRow[]): Promise<BatchResult> {
    const result: BatchResult = { succeeded: [], failed: [] };
    const path = await this.sheetPath();
    const creates = rows.filter(row => !row.recordId);
    const updates = rows.filter(row => row.recordId);

    for (const batch of chunkItems(creates, BATCH_LIMIT)) {
      const data = await this.request<{ addRecords?: { records?: TencentRecord[] } }>(path, {
        addRecords: { records: batch.map(row => ({ values: encodeFields(row.fields) })) },
      });
      batch.forEach((row, index) => {
        const recordId = data.addRecords?.records?.[index]?.recordID;
        if (recordId) result.succeeded.push({ recordId, businessId: row.businessId });
        else
          result.failed.push({
            businessId: row.businessId,
            code: 'no-record-id',
            message: 'addRecords returned no recordID',
          });
      });
    }

    for (const batch of chunkItems(updates, BATCH_LIMIT)) {
      await this.request(path, {
        updateRecords: { records: batch.map(row => ({ recordID: row.recordId, values: encodeFields(row.fields) })) },
      });
      for (const row of batch) result.succeeded.push({ recordId: row.recordId, businessId: row.businessId });
    }

    return result;
  }

  /** 批量删除（body 键为 `recordIDs`；recordID 不存在视为业务成功） */
  async batchDelete(recordIds: string[]): Promise<BatchResult> {
    const result: BatchResult = { succeeded: [], failed: [] };
    const path = await this.sheetPath();
    for (const batch of chunkItems(recordIds, BATCH_LIMIT)) {
      await this.request(path, { deleteRecords: { recordIDs: batch } });
      for (const recordId of batch) result.succeeded.push({ recordId, businessId: '' });
    }
    return result;
  }

  private async sheetPath(): Promise<string> {
    if (!this.sheetId) throw new CloudSyncError('notFound', 'sheet id not configured');
    const fileId = await this.resolveFileId();
    return `/openapi/smartbook/v2/files/${encodeURIComponent(fileId)}/sheets/${encodeURIComponent(this.sheetId)}`;
  }
}
