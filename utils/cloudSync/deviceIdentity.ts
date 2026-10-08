import { generateId } from '@/utils/generateId';
import { STORAGE_KEYS } from '@/utils/storageKeys';
import { logger } from '@/utils/logger';

const key = STORAGE_KEYS.CLOUD_SYNC_DEVICE_ID;

async function readStoredDeviceId(): Promise<string> {
  const result = await chrome.storage.local.get(key);
  const value = result[key];
  return typeof value === 'string' && value.trim() ? value : '';
}

export async function getOrCreateDeviceId(): Promise<string> {
  try {
    const stored = await readStoredDeviceId();
    if (stored) return stored;
    const created = generateId();
    await chrome.storage.local.set({ [key]: created });
    return created;
  } catch (error) {
    logger.error('getOrCreateDeviceId failed', error);
    return generateId();
  }
}
