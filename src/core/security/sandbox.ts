/**
 * P0 软 sandbox（防御纵深的最底层，位于「权限/HITL 通过之后、真正 exec 之前」）。
 *
 * 设计定位：
 *   - 路径围栏（path-fence.ts）与命令黑名单（command-blacklist.ts）是不可关闭的「硬 gate」，
 *     本 sandbox 是更底层的「即使命令被放行，也跑在受限环境里」——双重保险。
 *   - P0（本文件）做**资源限额**（防 fork 炸弹 / 无限循环 / 写出超大文件），零第三方依赖，
 *     纯 child_process 包装；通过 ulimit(macOS) / prlimit(Linux) 实现。
 *   - 文件系统 / 网络隔离在 P1+ 才做（bwrap 只读视图 / seatbelt / 网络命名空间白名单），
 *     故 `netAllow` 当前为预留字段，P0 不强制生效（见下方说明）。
 *
 * 为何默认不把限额设得很死：本项目是学习用 CLI，限额只作「防失控护栏」，
 * 不应误伤正常开发命令（如 npm install 会 fork 很多进程）。默认值偏宽松。
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface SandboxOptions {
  /** 工作目录（沿用工具已有的 cwd） */
  cwd: string;
  /**
   * 允许外联的域名白名单。P0 软 sandbox **不强制**生效（无 OS 级支持时无法真正封网），
   * 仅作前向兼容字段，待 P1 seatbelt/bwrap / 网络命名空间时启用。
   */
  netAllow?: string[];
  /** 虚拟内存上限（MB）；0 表示不限制。默认 0。 */
  memMb?: number;
  /** CPU 时间上限（秒，**CPU 秒**非墙钟，故 300 已足够宽松）；0 表示不限制。默认 300。 */
  cpuSec?: number;
  /** 同时进程数上限（防 fork 炸弹）。默认 1024。 */
  pids?: number;
  /** 单个文件大小上限（MB）；默认 2048。 */
  fileMb?: number;
  /** 中断信号（沿用调用方 signal）。 */
  signal?: AbortSignal;
  /** 输出缓冲上限（字节）。默认 1MB。 */
  maxBuffer?: number;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  /** 进程退出码；执行异常（如超资源被杀）时回退为 1。 */
  code: number;
}

export interface SandboxRunner {
  /** 运行模式：soft（P0） / bwrap / seatbelt / container（P1+ 预留） */
  readonly mode: 'soft' | 'bwrap' | 'seatbelt' | 'container';
  run(cmd: string, o: SandboxOptions): Promise<SandboxResult>;
}

/** 平台选择限额原语：macOS 用 ulimit（bash 内建），Linux 用 prlimit（util-linux）。 */
function limitWrapper(): 'ulimit' | 'prlimit' {
  return process.platform === 'darwin' ? 'ulimit' : 'prlimit';
}

/**
 * 创建 sandbox runner。当前只返回 P0 软 sandbox；后续平台能力探测（bwrap/landlock/
 * seatbelt 是否可用）可在此分流到更强的实现，对外接口保持不变。
 */
export function createSandbox(): SandboxRunner {
  const wrapper = limitWrapper();
  return {
    mode: 'soft',
    async run(cmd: string, o: SandboxOptions): Promise<SandboxResult> {
      const cpuSec = o.cpuSec ?? 300;
      const pids = o.pids ?? 1024;
      const fileMb = o.fileMb ?? 2048;

      let prefix: string;
      if (wrapper === 'ulimit') {
        // ulimit 单位：文件大小 -f 为 1024 字节块
        const parts: string[] = [`ulimit -u ${pids}`, `ulimit -f ${Math.floor(fileMb * 1024)}`];
        if (cpuSec > 0) parts.push(`ulimit -t ${cpuSec}`);
        prefix = parts.join('; ') + '; ';
      } else {
        // prlimit 直接 exec 替换：prlimit <opts> -- <shell> -c <cmd>
        const parts: string[] = [`--nproc=${pids}`, `--nofile=1024`];
        if (cpuSec > 0) parts.push(`--cpu=${cpuSec}`);
        prefix = `prlimit ${parts.join(' ')} -- `;
      }

      const full = prefix + cmd;
      try {
        const { stdout, stderr } = await execAsync(full, {
          cwd: o.cwd,
          signal: o.signal,
          maxBuffer: o.maxBuffer ?? 1024 * 1024,
        });
        return { stdout, stderr, code: 0 };
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: err.stdout ?? '',
          stderr: err.stderr ?? '',
          code: typeof err.code === 'number' ? err.code : 1,
        };
      }
    },
  };
}
