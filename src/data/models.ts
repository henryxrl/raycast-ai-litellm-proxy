import crypto from 'crypto';
import { z } from 'zod/v4';
import {
  DEFAULT_REFRESH_INTERVAL,
  CONTEXT_LENGTHS,
  FIXED_MODEL_SIZE,
  DEFAULT_PARAMETER_SIZE,
  DEFAULT_QUANTIZATION,
  DEFAULT_FORMAT,
  DEFAULT_FAMILY,
  DEFAULT_EMBEDDING_LENGTH,
  DEFAULT_PARAMETER_COUNT,
} from '../constants';
import {
  LiteLLMConnectionError,
  LiteLLMAuthError,
  LiteLLMNotFoundError,
} from '../errors/custom-errors';

export const ModelConfig = z.object({
  name: z.string(),
  id: z.string(),
  contextLength: z.number(),
  capabilities: z.array(z.enum(['vision', 'tools'])),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  max_tokens: z.int().min(1).optional(),
  extra: z.record(z.string(), z.any()).optional(),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

// LiteLLM API response schema
const LiteLLMModel = z.object({
  id: z.string(),
  object: z.literal('model'),
  created: z.number().optional(),
  owned_by: z.string().optional(),
});

const LiteLLMResponse = z.object({
  data: z.array(LiteLLMModel),
});

// Detailed model info response schema
const DetailedModelInfo = z.object({
  model_name: z.string(),
  litellm_params: z.object({
    model: z.string(),
  }),
  model_info: z
    .object({
      max_tokens: z.number().optional(),
      max_input_tokens: z.number().optional(),
      max_output_tokens: z.number().optional(),
      litellm_provider: z.string().optional(),
      mode: z.string().optional(),
      supports_vision: z.boolean().nullable().optional(),
      supports_function_calling: z.boolean().nullable().optional(),
      supports_tool_choice: z.boolean().nullable().optional(),
    })
    .optional(),
});

const DetailedLiteLLMResponse = z.object({
  data: z.array(DetailedModelInfo),
});

// Model cache with race condition protection
interface ModelCache {
  models: ModelConfig[];
  lastFetch: number;
  ttl: number;
}

let modelCache: ModelCache | null = null;
let cacheUpdatePromise: Promise<ModelConfig[]> | null = null;

import {
  detectCapabilitiesFromLiteLLM,
  detectCapabilitiesFromProvider,
  getModelCapabilities,
  mergeCapabilities,
} from './capability-detection';
import { getModelContextLength } from './context-length';

function getModelMetadata(modelId: string): {
  contextLength: number;
  capabilities: ModelConfig['capabilities'];
} {
  const contextLength = getModelContextLength(modelId);
  const capabilities = getModelCapabilities(modelId);

  return { contextLength, capabilities };
}

function convertDetailedLiteLLMToModelConfig(response: unknown): ModelConfig[] {
  try {
    const parsedResponse = DetailedLiteLLMResponse.parse(response);

    return parsedResponse.data.map((model) => {
      const modelInfo = model.model_info;

      // Use LiteLLM's context length if available, otherwise fall back to our detection
      const contextLength =
        modelInfo?.max_tokens ||
        modelInfo?.max_input_tokens ||
        getModelMetadata(model.model_name).contextLength;

      const capabilities = mergeCapabilities(
        detectCapabilitiesFromLiteLLM(modelInfo),
        detectCapabilitiesFromProvider(model.model_name, modelInfo?.litellm_provider),
      );

      return {
        name: model.model_name,
        id: model.litellm_params.model,
        contextLength,
        capabilities,
      };
    });
  } catch (error) {
    console.warn('Failed to parse detailed model info, falling back to basic parsing');
    // If parsing fails, treat as basic response
    if (
      typeof response === 'object' &&
      response !== null &&
      'data' in response &&
      Array.isArray((response as { data: unknown }).data)
    ) {
      return convertLiteLLMToModelConfig(
        (response as { data: z.infer<typeof LiteLLMModel>[] }).data,
      );
    }
    throw error;
  }
}

function convertLiteLLMToModelConfig(litellmModels: z.infer<typeof LiteLLMModel>[]): ModelConfig[] {
  return litellmModels.map((model) => {
    const { contextLength, capabilities } = getModelMetadata(model.id);

    return {
      name: model.id, // Use the model ID directly as the display name
      id: model.id,
      contextLength,
      capabilities,
    };
  });
}

async function fetchModelsFromLiteLLM(baseUrl: string, apiKey?: string): Promise<ModelConfig[]> {
  // Try the detailed model/info endpoint first, fall back to basic /models
  const modelInfoUrl = new URL('/model/info', baseUrl).toString();
  const modelsUrl = new URL('/models', baseUrl).toString();

  // First try to get detailed model info
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    // Add Authorization header if API key is provided
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(modelInfoUrl, {
      method: 'GET',
      headers,
    });

    if (response.ok) {
      const data: unknown = await response.json();
      const modelCount = Array.isArray((data as { data?: unknown })?.data)
        ? (data as { data: unknown[] }).data.length
        : 0;
      console.log(`Successfully fetched detailed model info for ${modelCount} models`);
      // If we get detailed info, use it
      return convertDetailedLiteLLMToModelConfig(data);
    }
  } catch (_error) {
    console.log('Model info endpoint not available, falling back to basic /models');
  }

  // Fallback to basic /models endpoint
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    // Add Authorization header if API key is provided
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: unknown = await response.json();
    const modelCount = Array.isArray((data as { data?: unknown })?.data)
      ? (data as { data: unknown[] }).data.length
      : 0;
    console.log(`Fallback to basic /models endpoint, found ${modelCount} models`);
    const parsedResponse = LiteLLMResponse.parse(data);

    return convertLiteLLMToModelConfig(parsedResponse.data);
  } catch (error) {
    console.warn('Failed to fetch models from LiteLLM:', error);
    throw error;
  }
}

function getFallbackModels(): ModelConfig[] {
  // Better fallback with multiple commonly available models
  return [
    {
      name: 'GPT-3.5 Turbo',
      id: 'gpt-3.5-turbo',
      contextLength: CONTEXT_LENGTHS.GPT_3_5_TURBO,
      capabilities: ['tools'],
    },
    {
      name: 'GPT-4',
      id: 'gpt-4',
      contextLength: CONTEXT_LENGTHS.GPT_4,
      capabilities: ['tools'],
    },
    {
      name: 'GPT-4 Turbo',
      id: 'gpt-4-turbo-preview',
      contextLength: CONTEXT_LENGTHS.GPT_4O,
      capabilities: ['tools', 'vision'],
    },
    {
      name: 'Claude 3.5 Sonnet',
      id: 'claude-3-5-sonnet-20241022',
      contextLength: CONTEXT_LENGTHS.CLAUDE_3,
      capabilities: ['tools', 'vision'],
    },
  ];
}

export async function loadModels(
  baseUrl: string,
  apiKey?: string,
  refreshInterval?: number,
): Promise<ModelConfig[]> {
  const modelRefreshInterval = refreshInterval || DEFAULT_REFRESH_INTERVAL;
  const now = Date.now();

  // Return cached models if still valid
  if (modelCache && now - modelCache.lastFetch < modelRefreshInterval) {
    return modelCache.models;
  }

  // If another request is already updating the cache, wait for it
  if (cacheUpdatePromise) {
    try {
      return await cacheUpdatePromise;
    } catch {
      // If the ongoing update fails, fall through to try again
    }
  }

  // Start cache update
  cacheUpdatePromise = updateModelCache(baseUrl, modelRefreshInterval, apiKey);

  try {
    const models = await cacheUpdatePromise;
    return models;
  } finally {
    cacheUpdatePromise = null;
  }
}

async function updateModelCache(
  baseUrl: string,
  modelRefreshInterval: number,
  apiKey?: string,
): Promise<ModelConfig[]> {
  const now = Date.now();

  try {
    const models = await fetchModelsFromLiteLLM(baseUrl, apiKey);

    // Update cache
    modelCache = {
      models,
      lastFetch: now,
      ttl: modelRefreshInterval,
    };

    console.log(`Successfully loaded ${models.length} models from LiteLLM`);
    return models;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to load models from LiteLLM:', errorMessage);

    // Throw specific error types based on the error
    if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch failed')) {
      throw new LiteLLMConnectionError(baseUrl, error instanceof Error ? error : undefined);
    } else if (errorMessage.includes('401') || errorMessage.includes('403')) {
      throw new LiteLLMAuthError();
    } else if (errorMessage.includes('404')) {
      throw new LiteLLMNotFoundError();
    }

    // If we have cached models, use them even if expired
    if (modelCache?.models) {
      console.log('Using expired cached models');
      return modelCache.models;
    }

    // Last resort: use fallback models
    const fallbackModels = getFallbackModels();
    console.log('Using fallback models:', fallbackModels.map((m) => m.name).join(', '));
    return fallbackModels;
  }
}

export const findModelConfig = (
  models: ModelConfig[],
  modelName: string,
): ModelConfig | undefined => {
  return models.find((config) => config.name === modelName);
};

function generateDigest(modelName: string): string {
  return crypto.createHash('sha256').update(modelName).digest('hex');
}

export const generateModelsList = (models: ModelConfig[]) => {
  return {
    models: models.map((config) => ({
      name: config.name,
      model: config.id,
      modified_at: new Date().toISOString(),
      size: FIXED_MODEL_SIZE,
      digest: generateDigest(config.id),
      details: {
        parent_model: '',
        format: DEFAULT_FORMAT,
        family: DEFAULT_FAMILY,
        families: [DEFAULT_FAMILY],
        parameter_size: DEFAULT_PARAMETER_SIZE,
        quantization_level: DEFAULT_QUANTIZATION,
      },
    })),
  };
};

export const generateModelInfo = (models: ModelConfig[], modelName: string) => {
  const config = findModelConfig(models, modelName);

  if (!config) {
    throw new Error(`Model ${modelName} not found`);
  }

  return {
    modelfile: `FROM ${config.name}`,
    parameters: 'stop "<|eot_id|>"',
    template: '{{ .Prompt }}',
    details: {
      parent_model: '',
      format: DEFAULT_FORMAT,
      family: DEFAULT_FAMILY,
      families: [DEFAULT_FAMILY],
      parameter_size: DEFAULT_PARAMETER_SIZE,
      quantization_level: DEFAULT_QUANTIZATION,
    },
    model_info: {
      'general.architecture': DEFAULT_FAMILY,
      'general.file_type': 2,
      'general.parameter_count': DEFAULT_PARAMETER_COUNT,
      'llama.context_length': config.contextLength,
      'llama.embedding_length': DEFAULT_EMBEDDING_LENGTH,
      'tokenizer.ggml.model': 'gpt2',
    },
    capabilities: ['completion', ...config.capabilities],
  };
};
