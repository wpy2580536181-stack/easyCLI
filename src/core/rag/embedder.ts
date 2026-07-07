// Phase 11（多模型适配补全）：把 Phase 6 的 `embed()` 抽象为「可插拔接口」。
//
// 为什么需要接口层：
// - Phase 6 的 embed 是「手写 TF-IDF + 哈希技巧」的同步实现，零依赖、确定性、可离线；
// - 但生产级 RAG 往往用 API 嵌入（OpenAI / 本地 bge 等），维度与语义质量都更高；
// - 若把 store.ts 直接耦合到某个具体嵌入实现，未来换算法/换服务就要改仓库核心。
// 因此这里定义 Provider 无关的 `Embedder` 接口，RagStore 只依赖接口：
//   换嵌入器 = 换一个实现，仓库与上层代码零改动（与 ChatModel 的设计哲学一致）。
//
// 两个实现：
// - HandwrittenEmbedder：复用 Phase 6 的纯函数（embed/tokenize），同步结果包成 Promise。
// - ApiEmbedder：走 OpenAI 兼容的 /embeddings 协议，需联网，返回模型自有向量。

import { embed, tokenize, type Embedding } from './embed';

/** 嵌入器配置（可持久化到 config.json 的 `embedder` 字段） */
export type EmbedderConfig =
  | { type: 'tfidf' }
  | { type: 'api'; baseURL: string; apiKey: string; model: string; dim?: number };

/** Provider 无关的嵌入接口——所有嵌入器都实现它 */
export interface Embedder {
  /** 标识，如 "tfidf:1024" / "api:text-embedding-3-small" */
  readonly id: string;
  /** 向量维度（状态展示 / 维度校验用） */
  readonly dim: number;
  /**
   * 把一段文本嵌入为 L2 归一化向量。
   * @param text 待嵌入文本
   * @param idf  逆文档频率表（手写 TF-IDF 需要；API 嵌入忽略此参数）
   */
  embed(text: string, idf?: Map<string, number>): Promise<Embedding>;
}

/**
 * 手写 TF-IDF + 哈希技巧嵌入器。
 * 零依赖、确定性、可离线——学习项目的默认实现。
 * 内部直接复用 Phase 6 的纯函数，不做任何改写（保证既有单测与行为不变）。
 */
export class HandwrittenEmbedder implements Embedder {
  readonly id = `tfidf:${1024}`;
  readonly dim = 1024;

  embed(text: string, idf?: Map<string, number>): Promise<Embedding> {
    return Promise.resolve(embed(tokenize(text), idf));
  }
}

/** API 嵌入器配置（OpenAI 兼容 /embeddings 协议） */
export interface ApiEmbedderConfig {
  /** 含 /v1 或根路径；本类会自动拼 /embeddings */
  baseURL: string;
  apiKey: string;
  model: string;
  /** 仅用于状态展示的维度，默认 1536（text-embedding-3-small） */
  dim?: number;
}

/**
 * 基于 API 的嵌入器：把文本发到 OpenAI 兼容的 /embeddings 端点，取回模型向量。
 * 优势：语义质量高、维度固定、支持批量（本实现单条调用，批量见 §9 优化点）。
 * 代价：需联网、按 token 计费、有请求延迟。
 */
export class ApiEmbedder implements Embedder {
  private readonly _id: string;
  private readonly _dim: number;

  constructor(private readonly cfg: ApiEmbedderConfig) {
    this._id = `api:${cfg.model}`;
    this._dim = cfg.dim ?? 1536;
  }

  get id(): string {
    return this._id;
  }
  get dim(): number {
    return this._dim;
  }

  async embed(text: string, _idf?: Map<string, number>): Promise<Embedding> {
    const res = await fetch(`${this.cfg.baseURL.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({ model: this.cfg.model, input: text }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`嵌入 API 失败 ${res.status}: ${err}`);
    }
    const json: any = await res.json();
    const raw = json?.data?.[0]?.embedding as number[] | undefined;
    if (!Array.isArray(raw)) throw new Error('嵌入 API 返回格式异常（缺少 data[0].embedding）');
    const v = Float32Array.from(raw);

    // API 默认已 L2 归一化（encoding_format=float），这里兜底再归一一次，确保与手写实现一致
    let s = 0;
    for (const x of v) s += x * x;
    const len = Math.sqrt(s);
    if (len > 0) for (let i = 0; i < v.length; i++) v[i]! /= len;
    return v;
  }
}

/** 由配置创建嵌入器；默认回退到手写实现（离线、零依赖） */
export function createEmbedder(cfg: EmbedderConfig = { type: 'tfidf' }): Embedder {
  if (cfg.type === 'api') {
    return new ApiEmbedder({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      model: cfg.model,
      dim: cfg.dim,
    });
  }
  return new HandwrittenEmbedder();
}
