// Phase 11（多模型适配补全）：Ollama 适配器。
//
// 设计取舍：Ollama 在本地启动后会暴露一个 **OpenAI 兼容** 端点
// （http://localhost:11434/v1/chat/completions），线缆协议与 OpenAI 完全一致。
// 既然 Phase 1 的 OpenAICompatibleAdapter 已经把手写 SSE 解析、tool_calls 分片累积、
// reasoning_content 兼容全部实现且测过，这里就「复用而非重写」——只覆盖两处差异：
//   1. 默认 baseURL 指向本地 Ollama；
//   2. id 前缀改为 ollama:（便于状态栏/日志辨识当前用的是哪个 provider）。
//
// 这正是「Provider 无关接口 + 复用适配」哲学的体现：线缆兼容就组合，不要为兼容而重写。

import { OpenAICompatibleAdapter, type OpenAIConfig } from './openai-compatible';

export interface OllamaConfig {
  model: string;
  /** 默认 http://localhost:11434/v1 */
  baseURL?: string;
  /** 本地 Ollama 一般不鉴权，默认给占位串（符合 OpenAI 协议仍要带 header） */
  apiKey?: string;
}

export class OllamaAdapter extends OpenAICompatibleAdapter {
  private readonly _id: string;

  constructor(config: OllamaConfig) {
    const openaiCfg: OpenAIConfig = {
      baseURL: config.baseURL ?? 'http://localhost:11434/v1',
      apiKey: config.apiKey ?? 'ollama',
      model: config.model,
    };
    super(openaiCfg);
    this._id = `ollama:${config.model}`;
  }

  override get id(): string {
    return this._id;
  }
}
