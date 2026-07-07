import { OpenAICompatibleAdapter } from './openai-compatible';
import { AnthropicAdapter } from './anthropic';
import { OllamaAdapter } from './ollama';
import { FallbackChatModel } from './fallback';
import type { ChatModel } from './types';
import type { AppConfig } from '../../config';

/**
 * 模型工厂：根据配置选择适配器，并按需包裹 fallback 降级。
 *
 * - provider 决定用哪个适配器（openai / anthropic / ollama）；
 * - 若配置了 config.fallback（且指定了 model），用 FallbackChatModel 把主/备包成一层，
 *   上层（ReAct 循环）对「是否降级」完全无感知。
 */
export function createChatModel(config: AppConfig): ChatModel {
  const primary = buildModel(config);

  if (config.fallback && config.fallback.model) {
    const fb: AppConfig = {
      ...config,
      provider: config.fallback.provider ?? config.provider,
      llm: {
        baseURL: config.fallback.baseURL ?? config.llm.baseURL,
        apiKey: config.fallback.apiKey ?? config.llm.apiKey,
        model: config.fallback.model,
      },
    };
    const fallbackModel = buildModel(fb);
    return new FallbackChatModel(primary, fallbackModel, {
      onSwitch: (p, f, e) =>
        console.warn(`⚠ 主模型 ${p} 调用失败，已切换备用模型 ${f}：${(e as Error)?.message ?? e}`),
    });
  }

  return primary;
}

/** 按单个 provider+llm 配置构造具体适配器（主模型与 fallback 共用） */
function buildModel(config: AppConfig): ChatModel {
  switch (config.provider) {
    case 'openai':
      return new OpenAICompatibleAdapter({
        baseURL: config.llm.baseURL,
        apiKey: config.llm.apiKey,
        model: config.llm.model,
      });
    case 'anthropic':
      return new AnthropicAdapter({
        apiKey: config.llm.apiKey,
        model: config.llm.model,
        ...(config.llm.baseURL ? { baseURL: config.llm.baseURL } : {}),
      });
    case 'ollama':
      return new OllamaAdapter({
        model: config.llm.model,
        ...(config.llm.baseURL ? { baseURL: config.llm.baseURL } : {}),
      });
    default:
      throw new Error(
        `未实现的 provider: ${config.provider}（已实现：openai / anthropic / ollama）`,
      );
  }
}

export * from './types';
