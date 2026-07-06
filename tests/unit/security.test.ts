import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSafe } from '../../src/core/security/path-fence';
import { checkCommand } from '../../src/core/security/command-blacklist';
import { PermissionManager, type Decision } from '../../src/core/security/permission';
import { redact } from '../../src/core/security/audit';
import { EventBus } from '../../src/core/events/bus';
import { createToolRegistry, ToolRegistry } from '../../src/core/tools/registry';

describe('路径围栏 resolveSafe（硬 gate）', () => {
  const root = '/workspace/easyCLI';

  it('相对路径被解析到 root 内', () => {
    const abs = resolveSafe(root, 'src/cli/main.ts');
    expect(abs.startsWith(root)).toBe(true);
    expect(abs.endsWith('src/cli/main.ts')).toBe(true);
  });

  it('"." 解析为 root 自身，不抛错', () => {
    expect(() => resolveSafe(root, '.')).not.toThrow();
    expect(resolveSafe(root, '.')).toBe(root);
  });

  it('试图用 ../ 逃出 root 被拦截', () => {
    expect(() => resolveSafe(root, '../etc/passwd')).toThrow(/超出项目根目录/);
  });

  it('绝对路径指向 root 外被拦截', () => {
    expect(() => resolveSafe(root, '/etc/passwd')).toThrow(/超出项目根目录/);
  });
});

describe('命令黑名单 checkCommand（硬 gate）', () => {
  it('普通命令放行', () => {
    expect(checkCommand('echo hello').ok).toBe(true);
    expect(checkCommand('ls -la').ok).toBe(true);
    expect(checkCommand('rm file.txt').ok).toBe(true); // 无 -r 不拦
  });

  it('拦截明显破坏性命令', () => {
    expect(checkCommand('rm -rf /').ok).toBe(false);
    expect(checkCommand('sudo reboot').ok).toBe(false);
    expect(checkCommand('mkfs.ext4 /dev/sda1').ok).toBe(false);
    expect(checkCommand('dd if=/dev/zero of=/dev/sda').ok).toBe(false);
    expect(checkCommand('chmod 777 secret').ok).toBe(false);
    expect(checkCommand('shutdown now').ok).toBe(false);
  });
});

describe('三级权限 PermissionManager', () => {
  let dir: string;
  let reg: ToolRegistry;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'easycli-perm-'));
    reg = createToolRegistry(); // 含 read_file(isReadOnly) / bash(非只读)
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('只读工具默认 allow，非只读默认 ask', () => {
    const pm = new PermissionManager({ settingsPath: join(dir, 'a.json'), registry: reg });
    expect(pm.decide('read_file')).toBe('allow');
    expect(pm.decide('bash')).toBe('ask');
  });

  it('allow 列表优先于默认策略', () => {
    const pm = new PermissionManager({ settingsPath: join(dir, 'b.json'), registry: reg });
    pm.addAllow('bash');
    expect(pm.decide('bash')).toBe('allow');
  });

  it('addAllow 持久化，重载后仍生效', async () => {
    const path = join(dir, 'c.json');
    const pm = new PermissionManager({ settingsPath: path, registry: reg });
    pm.addAllow('bash');
    const reloaded = new PermissionManager({ settingsPath: path, registry: reg });
    reloaded.load();
    expect(reloaded.decide('bash')).toBe('allow');
  });

  it('deny 列表优先于 allow（预置 settings 验证 load）', async () => {
    const path = join(dir, 'd.json');
    await writeFile(path, JSON.stringify({ allow: ['bash'], deny: ['bash'] }), 'utf8');
    const pm = new PermissionManager({ settingsPath: path, registry: reg });
    pm.load();
    expect(pm.decide('bash')).toBe('deny');
  });

  it('resolve 经 HITL resolver 落地为布尔', async () => {
    const pm = new PermissionManager({ settingsPath: join(dir, 'e.json'), registry: reg });
    await expect(pm.resolve('bash', '', async (): Promise<Decision> => 'allow')).resolves.toBe(true);
    await expect(pm.resolve('bash', '', async (): Promise<Decision> => 'deny')).resolves.toBe(false);
  });

  it('无 resolver 时 ask 走默认 deny（安全默认）', async () => {
    const pm = new PermissionManager({ settingsPath: join(dir, 'f.json'), registry: reg });
    await expect(pm.resolve('bash')).resolves.toBe(false);
  });

  it('addAllow 会从 deny 列表移除该 key', async () => {
    const path = join(dir, 'g.json');
    await writeFile(path, JSON.stringify({ allow: [], deny: ['bash'] }), 'utf8');
    const pm = new PermissionManager({ settingsPath: path, registry: reg });
    pm.load();
    expect(pm.getDeny()).toContain('bash');
    pm.addAllow('bash');
    expect(pm.getDeny()).not.toContain('bash');
    expect(pm.getAllow()).toContain('bash');
  });

  it('getAllow / getDeny 返回当前快照', () => {
    const pm = new PermissionManager({ settingsPath: join(dir, 'h.json'), registry: reg });
    pm.addAllow('bash');
    expect(pm.getAllow()).toContain('bash');
    expect(pm.getDeny()).toEqual([]);
  });
});

describe('审计脱敏 redact', () => {
  it('遮蔽 sk- / ghp_ / Bearer 等凭据', () => {
    expect(redact('token sk-ABCDEFGH1234xyz')).toContain('sk-A***');
    expect(redact('auth ghp_QWERTYUIOP1234')).toContain('ghp_***');
    expect(redact('Authorization: Bearer abcdef123456')).toContain('Bear***');
  });

  it('普通文本不受影响', () => {
    expect(redact('读取了 src/main.ts 共 120 行')).toBe('读取了 src/main.ts 共 120 行');
  });
});

describe('事件总线 EventBus', () => {
  it('on/emit 按类型分发，支持多订阅者', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('turn', (e) => seen.push('a:' + e.type));
    bus.on('turn', (e) => seen.push('b:' + e.type));
    bus.emit({ type: 'turn' });
    expect(seen).toEqual(['a:turn', 'b:turn']);
  });

  it('不同类型互不影响', () => {
    const bus = new EventBus();
    let calls = 0;
    bus.on('error', () => calls++);
    bus.emit({ type: 'tool:call' });
    expect(calls).toBe(0);
  });
});
