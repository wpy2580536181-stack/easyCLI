import chalk from 'chalk';

/**
 * 手写流式渲染器：边收 SSE 边增量打印。
 *
 * Phase 10 打磨点：状态行（思考中、工具调用等）用 `\r\x1b[K` 在「同一行原地」刷新/擦除，
 * 而不是像旧版那样每来一条状态就 `\n⟳ ...\n` 把正文切成碎片。
 * 这带来更顺滑的阅读体验：正文连续，状态像浮层一样覆盖在临时行上，正文恢复时它即被清除。
 *
 * 后续各期会扩展：思考块（reasoning）灰显、工具调用过程可视化、Plan 模式预览等。
 */

/** 可注入的输出目标（默认 process.stdout，单测时传字符串缓冲以断言行为） */
export interface OutputSink {
  write(s: string): void;
}

export class StreamRenderer {
  /** 当前是否正处于「状态行」模式（最后打印的是一行状态，尚未被正文/换行提交） */
  private inStatus = false;

  constructor(
    private readonly color: (s: string) => string = chalk.white,
    private readonly out: OutputSink = process.stdout,
  ) {}

  /** 流式写入一段正文（带着色） */
  push(chunk: string): void {
    if (this.inStatus) {
      // 正文恢复：先擦掉当前状态行，再续写正文，正文因此不被状态打断
      this.out.write('\r\x1b[K');
      this.inStatus = false;
    }
    this.out.write(this.color(chunk));
  }

  /**
   * 打印/刷新一行状态（思考中、工具调用等）。
   * 若已处于状态行：原地覆盖（\r 回行首 + \x1b[K 清到行尾）。
   * 否则：先换行，再写状态——状态独占一行，不挤在正文同一行。
   */
  status(msg: string): void {
    if (this.inStatus) {
      this.out.write('\r\x1b[K');
    } else {
      this.out.write('\n');
    }
    this.out.write(chalk.gray(`⟳ ${msg}`));
    this.inStatus = true;
  }

  /**
   * 结束本轮，补一个换行。若最后是一行状态，先擦掉它，避免末尾残留半句状态。
   */
  newline(): void {
    if (this.inStatus) {
      this.out.write('\r\x1b[K');
      this.inStatus = false;
    }
    this.out.write('\n');
  }
}
