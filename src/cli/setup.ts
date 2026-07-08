// 首次运行配置向导（First-Run Setup Wizard）。
//
// 触发：main.ts 在「~/.config/agent-cli/config.json 不存在」（loadUserConfig() 返回 null）
// 且处于交互终端时，于创建模型前调用 runFirstRunSetup()，交互式收集 API Key / BaseURL / Model
// 并落盘。之后启动流程照常加载该文件，用户无需再次输入；已有配置文件则完全跳过本向导。
//
// 设计要点：
//   - 抽象出 SetupPrompter 接口：text=回显普通提问，secret=不回显敏感提问（原始模式逐字符打码）。
//     真实实现走 node:readline + stdin 原始模式；单元测试注入 MockPrompter，无需真实 TTY。
//   - 仅收集「必要信息」：API Key（必填，缺失则循环重问）、BaseURL、Model（均带默认值，回车即接受）。
//   - 落盘复用 store.saveUserConfig（与已有文件浅合并 + 自动建父目录），不覆盖无关字段。
//   - 落盘/展示均对密钥使用 maskSecret 打码，绝不把明文写屏或写测试输出。

import readline from 'node:readline';
import { stdout, stdin } from 'node:process';
import chalk from 'chalk';
import { saveUserConfig, maskSecret, CONFIG_PATH, type UserConfig } from '../config';

/** 首次运行默认端点：DeepSeek OpenAI 兼容 API（与 config/index.ts 默认 baseURL 一致） */
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
/** 首次运行默认模型（与 config/index.ts 默认 model 一致） */
const DEFAULT_MODEL = 'deepseek-chat';

/** 抽象提问器：text=回显普通提问（支持默认回退），secret=不回显敏感提问。便于测试注入。 */
export interface SetupPrompter {
  text(question: string, def?: string): Promise<string>;
  secret(question: string): Promise<string>;
}

/** 基于 node:readline 的真实提问器（交互终端用）。 */
class ReadlinePrompter implements SetupPrompter {
  private out: { write(s: string): void };

  constructor(out: { write(s: string): void } = stdout) {
    this.out = out;
  }

  async text(question: string, def?: string): Promise<string> {
    const rl = readline.createInterface({ input: stdin, terminal: !!stdin.isTTY });
    return new Promise<string>((resolve) => {
      const hint = def ? chalk.gray(` (${def})`) : '';
      rl.question(chalk.cyan('? ') + question + hint + ' ', (ans) => {
        rl.close();
        const v = ans.trim();
        resolve(v || def || '');
      });
    });
  }

  async secret(question: string): Promise<string> {
    // 非 TTY（管道 / CI）：退化为普通 readline 读取（输入来自重定向，无需打码处理）。
    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin, terminal: false });
      return new Promise<string>((resolve) => {
        rl.question(chalk.cyan('? ') + question + ' ', (ans) => {
          rl.close();
          resolve(ans.trim());
        });
      });
    }
    // TTY：原始模式逐字符读取，回显 *，回车结束。支持退格与 Ctrl-C/D 中断。
    return new Promise<string>((resolve) => {
      let buf = '';
      let done = false;
      this.out.write(chalk.cyan('? ') + question + ' ');

      const cleanup = (): void => {
        if (done) return;
        done = true;
        // 关键：只退出原始模式并移除本监听器，绝不 stdin.pause()——
        // 否则后续 text() 新建的 readline 接口读不到输入而永久挂起。
        // 流保持"流动"状态，交给下一个 readline 接口接管。
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
      };
      const onData = (data: Buffer): void => {
        // 逐字符处理：raw 模式下一次 'data' 可能携带整块（粘贴/批量输入），
        // 必须遍历每个字符，否则把整块当单字符串比较 '\n' 会永远不成立而卡死。
        for (const ch of data.toString()) {
          if (done) return;
          if (ch === '\u0003' || ch === '\u0004') {
            // Ctrl-C / Ctrl-D：放弃并返回空串
            cleanup();
            this.out.write('\n');
            resolve('');
            return;
          }
          if (ch === '\r' || ch === '\n') {
            cleanup();
            this.out.write('\n');
            resolve(buf);
            return;
          }
          if (ch === '\u007f' || ch === '\b') {
            // 退格：删一个字符并擦除屏幕上的 *
            if (buf.length > 0) {
              buf = buf.slice(0, -1);
              this.out.write('\b \b');
            }
            continue;
          }
          buf += ch;
          this.out.write('*');
        }
      };

      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
    });
  }
}

/** runFirstRunSetup 的可注入依赖（测试用）。 */
export interface SetupDeps {
  /** 提问器，默认 ReadlinePrompter（真实终端交互）。 */
  prompter?: SetupPrompter;
  /** 落盘函数，默认 saveUserConfig（写 CONFIG_PATH）。测试可注入以断言 / 重定向路径。 */
  save?: (cfg: UserConfig) => void;
  /** 输出流，默认 process.stdout。测试可重定向或静默。 */
  out?: { write(s: string): void };
}

/** runFirstRunSetup 的返回结果。 */
export interface FirstRunResult {
  config: UserConfig;
  path: string;
}

/**
 * 执行首次运行配置向导：交互式收集必要 API 信息并落盘。
 * 纯函数式编排——所有副作用（提问 / 落盘 / 输出）都通过 deps 注入，便于单元测试。
 */
export async function runFirstRunSetup(deps: SetupDeps = {}): Promise<FirstRunResult> {
  const prompter = deps.prompter ?? new ReadlinePrompter();
  const save = deps.save ?? ((cfg) => saveUserConfig(cfg));
  const out = deps.out ?? stdout;

  out.write(chalk.bold('\n🔧 首次运行配置向导\n'));
  out.write(
    chalk.gray('未检测到配置文件，需要设置一次 API 信息。设置后将保存到 ') +
      chalk.underline(CONFIG_PATH) +
      chalk.gray('，以后无需重复输入。\n'),
  );

  // 1) API Key：必填，缺失则循环重问，避免把空串落盘成"已配置"。
  let apiKey = '';
  while (!apiKey) {
    apiKey = await prompter.secret('API Key（输入不回显）');
    if (!apiKey) out.write(chalk.yellow('  ⚠ API Key 不能为空，请重新输入。\n'));
  }

  // 2) BaseURL：默认 DeepSeek 兼容端点，回车即接受。
  const baseURL = (await prompter.text('API Base URL', DEFAULT_BASE_URL)) || DEFAULT_BASE_URL;

  // 3) Model：默认 deepseek-chat，回车即接受。
  const model = (await prompter.text('模型名（如 deepseek-chat）', DEFAULT_MODEL)) || DEFAULT_MODEL;

  const config: UserConfig = { apiKey, baseURL, model };
  save(config);

  out.write(chalk.green('\n✅ 配置已保存！\n'));
  out.write(`   API Key : ${maskSecret(apiKey)}\n`);
  out.write(`   BaseURL : ${baseURL}\n`);
  out.write(`   Model   : ${model}\n`);
  out.write(
    chalk.gray('如需修改，可编辑该文件，或用 `agent-cli --save-config` 重新写入。\n\n'),
  );

  return { config, path: CONFIG_PATH };
}
