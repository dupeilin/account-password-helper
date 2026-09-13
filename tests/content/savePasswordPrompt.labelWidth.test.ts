/** @vitest-environment jsdom */
/**
 * 保存密码弹窗的标签列宽回归测试
 *
 * 背景：标签列原本写死 `width: 40px`（按中文两字「账号」「密码」的高度定的），
 * 英文环境下 `Username` / `Password` 放不下会被断词换行——实测在英文站点上
 * 渲染成 `Usern` + `ame`、`Passw` + `ord`，看起来像渲染故障。
 *
 * 修复后四行共用「当前语言里最长标签量出来的宽度」，中文仍取 40px 下限（版式不变）。
 * jsdom 没有真实布局、`offsetWidth` 恒为 0，因此这里把 `offsetWidth` 桩成
 * 「字符数 × 7px」，让「按最长标签定宽」这一决策可被断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 当前语言（供下方 mock 的 tl 读取），测试内可切换 */
let locale: 'zh-CN' | 'en' = 'zh-CN';

vi.mock('@/utils/i18n-lite', async () => {
  const actual = await vi.importActual<typeof import('@/utils/i18n-lite')>('@/utils/i18n-lite');
  return {
    ...actual,
    tl: (key: string) => actual.LITE_MESSAGES[locale][key] ?? key,
  };
});

vi.mock('@/utils/theme', async () => {
  const actual = await vi.importActual<typeof import('@/utils/theme')>('@/utils/theme');
  // 必须回真实默认主题名（不是字面量 'default'）：弹窗会拿它去查 THEME_SHADOW_TOKENS
  return { ...actual, getStoredTheme: vi.fn(async () => actual.DEFAULT_THEME) };
});

import { dismissSavePasswordPrompt, showSavePasswordPrompt } from '@/entrypoints/content/SavePasswordPrompt';

/** 弹窗里出现过的全部标签文本（中英各一套） */
const LABEL_TEXTS = ['账号', '密码', '标签', '备注', 'Username', 'Password', 'Tags', 'Notes'];

/** 桩：每个字符 7px，用来模拟「量具量出最长标签的真实宽度」 */
const CHAR_WIDTH = 7;

/** 中文两字量出来不足下限，英文 `Password`（8 字符 × 7 + 2）= 58 */
const ZH_WIDTH = 40;
const EN_WIDTH = 58;

describe('保存密码弹窗的标签列宽', () => {
  let originalOffsetWidth: PropertyDescriptor | undefined;

  beforeEach(() => {
    locale = 'zh-CN';
    originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        return (this.textContent || '').length * CHAR_WIDTH;
      },
    });
  });

  afterEach(() => {
    dismissSavePasswordPrompt();
    document.body.innerHTML = '';
    if (originalOffsetWidth) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
    }
  });

  const openPrompt = (): void => {
    showSavePasswordPrompt(
      {
        username: 'demo@example.com',
        password: 'Demo!Pass2026',
        url: 'https://example.com',
        tag: 'Example',
        remark: 'auto saved',
      },
      () => {},
      () => {},
      () => {},
    );
  };

  /** 取出四个标签元素上的列宽与换行设置 */
  const readLabels = (): { text: string; width: string; whiteSpace: string }[] =>
    [...document.querySelectorAll('.aph-save-password-prompt span')]
      .filter(el => LABEL_TEXTS.includes((el.textContent || '').trim()))
      .map(el => ({
        text: (el.textContent || '').trim(),
        width: el.style.width,
        whiteSpace: el.style.whiteSpace,
      }));

  it('中文四行共用 40px 下限，版式与此前一致', () => {
    openPrompt();
    const labels = readLabels();

    expect(labels.map(l => l.text).sort()).toEqual(['备注', '密码', '标签', '账号']);
    expect(new Set(labels.map(l => l.width)).size).toBe(1);
    expect(labels[0]!.width).toBe(`${ZH_WIDTH}px`);
    expect(labels.every(l => l.whiteSpace === 'nowrap')).toBe(true);
  });

  it('英文按最长标签（Password）定宽，不再断词', () => {
    locale = 'en';
    openPrompt();
    const labels = readLabels();

    expect(labels.map(l => l.text).sort()).toEqual(['Notes', 'Password', 'Tags', 'Username']);
    expect(new Set(labels.map(l => l.width)).size).toBe(1);
    expect(labels[0]!.width).toBe(`${EN_WIDTH}px`);
    // 关键回归点：宽度必须超出中文下限，否则 Username / Password 仍会被拆行
    expect(EN_WIDTH).toBeGreaterThan(ZH_WIDTH);
    expect(labels.every(l => l.whiteSpace === 'nowrap')).toBe(true);
  });
});
