import { ModelConfig } from './models';
import { DEFAULT_CAPABILITIES } from '../constants';

// Vision model patterns
export const VISION_MODEL_PATTERNS = [
  /gpt-4.*vision/i,
  /gpt-4o/i,
  /claude-[34]/i,
  /gemini.*pro.*vision/i,
  /gemini.*flash/i,
  /gemini-[12]/i,
  /llava/i,
  /qwen.*vl/i,
  /qwen.*vision/i,
  /deepseek.*vl/i,
  /pixtral/i,
  /glm-4v/i,
];

export function hasVisionCapability(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  if (normalized.includes('vision') || normalized.includes('-vl') || normalized.endsWith('vl')) {
    return true;
  }
  return VISION_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
}

// Embedding model patterns for fallback when LiteLLM /model/info is unavailable
export const EMBEDDING_MODEL_PATTERNS = [
  /embed/i,
  /^bge-/i,
  /text-embedding/i,
  /nomic-embed/i,
  /e5-/i,
  /mxbai-embed/i,
  /gte-/i,
  /sentence-transformers/i,
];

export function isEmbeddingModel(
  modelName: string,
  modelInfo?: { mode?: string | null },
): boolean {
  if (modelInfo?.mode === 'embedding') {
    return true;
  }

  return EMBEDDING_MODEL_PATTERNS.some((pattern) => pattern.test(modelName));
}

export function detectCapabilitiesFromLiteLLM(modelInfo?: {
  supports_function_calling?: boolean | null;
  supports_tool_choice?: boolean | null;
  supports_vision?: boolean | null;
}): ModelConfig['capabilities'] {
  const capabilities: ModelConfig['capabilities'] = ['tools'];

  if (modelInfo?.supports_vision === true) {
    capabilities.push('vision');
  }

  return capabilities;
}

export function getModelCapabilities(modelId: string): ModelConfig['capabilities'] {
  const capabilities: ModelConfig['capabilities'] = [...DEFAULT_CAPABILITIES];

  if (hasVisionCapability(modelId)) {
    capabilities.push('vision');
  }

  return capabilities;
}
