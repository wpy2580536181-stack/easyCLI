import { OpenAICompatibleAdapter } from './openai-compatible';
import type { ChatModel } from './types';
import type { AppConfig } from '../../config';

/**
 * 模型工厂：根据配置选择适配器。
 * Phase 1 只实现 openai（覆盖 DeepSeek/GLM/Kimi/Qwen）；
 * Anthropic / Ollama 适配器在第 9 期补齐。
 */
export function createChatModel(config: AppConfig): ChatModel {
  switch (config.provider) {
    case 'openai':
      return new OpenAICompatibleAdapter({
        baseURL: config.llm.baseURL,
        apiKey: config.llm.apiKey,
        model: config.llm.model,
      });
    default:
      throw new Error(
        `未实现的 provider: ${config.provider}（Claude / Ollama 适配器将在第 9 期补齐）`,
      );
  }
}

export * from './types';
