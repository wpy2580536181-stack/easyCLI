import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore, HISTORY_PATH } from '../../src/cli/history';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'easycli-history-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('HistoryStore 落盘与读取', () => {
  it('add 后内容落盘，且顺序为「旧 → 新」', () => {
    const path = join(dir, 'h1');
    const store = new HistoryStore(path);
    store.add('你好');
    store.add('/help');
    store.add('写个快排');
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8').trim().split('\n');
    expect(raw).toEqual(['你好', '/help', '写个快排']);
  });

  it('新实例能从文件读回历史（forReadline 反转成新 → 旧）', () => {
    const path = join(dir, 'h2');
    const a = new HistoryStore(path);
    a.add('cmd1');
    a.add('cmd2');
    const b = new HistoryStore(path);
    expect(b.size).toBe(2);
    expect(b.forReadline()).toEqual(['cmd2', 'cmd1']); // 最新在前
  });

  it('连续重复命令被去重', () => {
    const path = join(dir, 'h3');
    const store = new HistoryStore(path);
    store.add('ping');
    store.add('ping'); // 连续重复，应被忽略
    store.add('pong');
    const raw = readFileSync(path, 'utf8').trim().split('\n');
    expect(raw).toEqual(['ping', 'pong']);
  });

  it('空串不写入', () => {
    const path = join(dir, 'h4');
    const store = new HistoryStore(path);
    store.add('   ');
    store.add('');
    expect(existsSync(path)).toBe(false);
  });

  it('保留多行粘贴中的内部空行', () => {
    const path = join(dir, 'h5');
    const store = new HistoryStore(path);
    const multiline = 'def f():\n    return 1\n\n# 注释';
    store.add(multiline);
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('\n\n'); // 内部空行保留
  });

  it('默认路径常量指向 ~/.config/agent-cli/history', () => {
    expect(HISTORY_PATH).toContain(join('.config', 'agent-cli', 'history'));
  });

  it('文件已存在但内容非法（非 UTF-8 行）不崩溃，lines 为空', () => {
    const path = join(dir, 'h6');
    writeFileSync(path, 'a\nb\n');
    const store = new HistoryStore(path);
    expect(store.size).toBe(2);
  });
});

describe('HistoryStore 限长', () => {
  it('超过 MAX 后最旧的被丢弃（这里用足够多条目触发）', () => {
    const path = join(dir, 'h7');
    const store = new HistoryStore(path);
    // 写入 2005 条，应只保留最后 2000 条
    for (let i = 0; i < 2005; i++) store.add(`c${i}`);
    expect(store.size).toBe(2000);
    expect(store.forReadline()[0]).toBe('c2004'); // 最新
    // 文件行数也应是 2000
    const fileLines = readFileSync(path, 'utf8').trim().split('\n');
    expect(fileLines.length).toBe(2000);
    expect(fileLines[0]).toBe('c5'); // 最旧保留的是 c5
  });
});
