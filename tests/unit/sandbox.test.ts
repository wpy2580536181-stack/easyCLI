import { describe, it, expect } from 'vitest';
import { createSandbox } from '../../src/core/security/sandbox';

const BIG = '/tmp/sb_size_limit_test.txt';

describe('sandbox (P0 软 sandbox)', () => {
  const sandbox = createSandbox();

  it('mode 为 soft，纯 child_process 包装、零第三方依赖', () => {
    expect(sandbox.mode).toBe('soft');
  });

  it('普通命令在限额包裹下正常执行（code=0 且 stdout 正确）', async () => {
    const res = await sandbox.run('echo hello-from-sandbox', { cwd: process.cwd() });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('hello-from-sandbox');
  });

  it('文件大小限额生效：写出超大文件被 SIGXFSZ 杀掉（code≠0）', async () => {
    // ulimit -f 1（1MB 块上限）→ yes 持续写文件触顶被杀，code 非 0
    const res = await sandbox.run(`yes > ${BIG} 2>/dev/null`, { cwd: process.cwd(), fileMb: 1 });
    expect(res.code).not.toBe(0);
  }, 8000);

  it('进程数护栏：超量后台进程被 ulimit -u 挡下（fork 失败，命令以非 0 退出）', async () => {
    const res = await sandbox.run('for i in $(seq 1 50); do sleep 2 & done; wait', {
      cwd: process.cwd(),
      pids: 5,
    });
    expect(typeof res.code).toBe('number');
    expect(res.code).not.toBe(0);
  }, 8000);
});
