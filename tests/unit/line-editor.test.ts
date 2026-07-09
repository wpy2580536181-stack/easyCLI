import { describe, it, expect } from 'vitest';
import { computeDropdownViewport } from '../../src/cli/line-editor';

// 回归测试：斜杠下拉「向上吞内容」+「选中项超出视口不可见」修复。
//
// 两个核心不变量：
//  1) maxVisible 永远有上限（默认 10）且受 topReserve 约束 → 下拉不会无限向上
//     生长吞掉 transcript 历史；
//  2) 返回的 viewportStart 保证 selIndex 落在 [viewportStart, viewportStart+maxVisible)
//     内 → 高亮项（光标定位）始终可见。

describe('computeDropdownViewport', () => {
  it('短列表：全部可见，不滚动', () => {
    const { maxVisible, viewportStart } = computeDropdownViewport(1, 3, 24, 0);
    expect(maxVisible).toBe(10); // 24-0-4=20 → min(10,20)=10，但只有 3 项
    expect(viewportStart).toBe(0);
  });

  it('长列表默认上限 10 行（不向上吞历史）', () => {
    const { maxVisible } = computeDropdownViewport(0, 50, 24, 0);
    expect(maxVisible).toBe(10);
  });

  it('topReserve 较大时下拉被压到很小，绝不越过预留区', () => {
    // rows=24, topReserve=20 → available = max(2, 0) = 2 → maxVisible=2
    const { maxVisible, viewportStart } = computeDropdownViewport(0, 50, 24, 20);
    expect(maxVisible).toBe(2);
    expect(viewportStart).toBe(0);
  });

  it('topReserve 极大（≥rows）时仍至少保留 2 行', () => {
    const { maxVisible } = computeDropdownViewport(0, 50, 24, 24);
    expect(maxVisible).toBe(2);
  });

  it('选中项在视口内：开头不滚动', () => {
    // 50 项，maxVisible=10，选第 5 项 → 仍在首屏
    const { viewportStart } = computeDropdownViewport(5, 50, 24, 0);
    expect(viewportStart).toBe(0);
  });

  it('选中项在视口内：最后一项不滚动（边界 9）', () => {
    const { viewportStart } = computeDropdownViewport(9, 50, 24, 0);
    expect(viewportStart).toBe(0); // selIndex < maxVisible，无需滚
  });

  it('选中项向下移出底部 → 视口跟随下移，选中项落在末位', () => {
    // 选第 10 项 → viewportStart = 10-10+1 = 1，可见 [1,11)，第 10 项在位置 9（末位）
    const sel = 10;
    const { maxVisible, viewportStart } = computeDropdownViewport(sel, 50, 24, 0);
    expect(maxVisible).toBe(10);
    expect(viewportStart).toBe(sel - maxVisible + 1);
    expect(sel).toBeGreaterThanOrEqual(viewportStart);
    expect(sel).toBeLessThan(viewportStart + maxVisible);
  });

  it('选中项在列表末端 → 视口钳制，选中项仍可见且为末位', () => {
    const sel = 49;
    const { maxVisible, viewportStart } = computeDropdownViewport(sel, 50, 24, 0);
    expect(viewportStart).toBe(50 - maxVisible); // 钳制到最后一屏
    expect(sel).toBe(viewportStart + maxVisible - 1); // 末位
  });

  it('selIndex 超出列表长度也被安全钳制', () => {
    const sel = 999;
    const { maxVisible, viewportStart } = computeDropdownViewport(sel, 50, 24, 0);
    expect(viewportStart).toBe(50 - maxVisible);
    expect(sel).toBeGreaterThanOrEqual(viewportStart);
    // 超出部分不会让视口越界
    expect(viewportStart + maxVisible).toBeLessThanOrEqual(50);
  });

  it('负 selIndex 被钳制到 0', () => {
    const { viewportStart } = computeDropdownViewport(-1, 50, 24, 0);
    expect(viewportStart).toBe(0);
  });

  it('不变量：任意输入下选中项始终落在可视窗口内', () => {
    const cases: Array<[number, number, number, number]> = [
      [0, 3, 24, 0],
      [2, 3, 24, 0],
      [10, 50, 24, 0],
      [49, 50, 24, 0],
      [0, 50, 24, 20],
      [30, 50, 30, 5],
      [-1, 50, 24, 0],
      [100, 50, 24, 0],
    ];
    for (const [sel, len, rows, reserve] of cases) {
      const { maxVisible, viewportStart } = computeDropdownViewport(sel, len, rows, reserve);
      // 视口起点合法
      expect(viewportStart).toBeGreaterThanOrEqual(0);
      expect(viewportStart).toBeLessThanOrEqual(Math.max(0, len - maxVisible));
      // 选中项（若落在列表内）一定可见
      if (sel >= 0 && sel < len) {
        expect(sel).toBeGreaterThanOrEqual(viewportStart);
        expect(sel).toBeLessThan(viewportStart + maxVisible);
      }
    }
  });
});
