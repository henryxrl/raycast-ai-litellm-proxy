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
