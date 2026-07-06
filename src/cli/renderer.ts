import chalk from 'chalk';

/**
 * 手写流式渲染器：边收 SSE 边增量打印。
 * 后续各期会扩展：思考块（reasoning）灰显、工具调用过程可视化、Plan 模式预览等。
 */
export class StreamRenderer {
  constructor(private readonly color: (s: string) => string = chalk.white) {}

  /** 流式写入一段文本 */
  push(chunk: string): void {
    process.stdout.write(this.color(chunk));
  }

  /** 打印一行状态/提示（思考中、工具调用等） */
  status(msg: string): void {
    process.stdout.write(chalk.gray(`\n⟳ ${msg}\n`));
  }

  newline(): void {
    process.stdout.write('\n');
  }
}
