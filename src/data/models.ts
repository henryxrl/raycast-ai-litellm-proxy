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
  litellm_params: z
    .object({
      model: z.string(),
    })
    .passthrough(),
  model_info: z
    .object({
      max_tokens: z.number().nullish(),
      max_input_tokens: z.number().nullish(),
      max_output_tokens: z.number().nullish(),
      litellm_provider: z.string().nullish(),
      mode: z.string().nullish(),
      supports_vision: z.boolean().nullish(),
      supports_function_calling: z.boolean().nullish(),
      supports_tool_choice: z.boolean().nullish(),
    })
    .passthrough()
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
  getModelCapabilities,
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
  const parsed = DetailedLiteLLMResponse.safeParse(response);

  if (parsed.success) {
    return parsed.data.data.map((model) => mapDetailedModelToConfig(model));
  }

  console.warn('Failed to parse detailed model info, falling back to loose parsing');

  if (
    typeof response === 'object' &&
    response !== null &&
    'data' in response &&
    Array.isArray((response as { data: unknown }).data)
  ) {
    return ((response as { data: unknown[] }).data as Record<string, unknown>[])
      .map((model) => mapLooseDetailedModelToConfig(model))
      .filter((model): model is ModelConfig => model !== null);
  }

  throw parsed.error;
}

function mapDetailedModelToConfig(model: z.infer<typeof DetailedModelInfo>): ModelConfig {
  const modelInfo = model.model_info;

  const contextLength =
    modelInfo?.max_tokens ??
    modelInfo?.max_input_tokens ??
    getModelMetadata(model.model_name).contextLength;

  return {
    name: model.model_name,
    id: model.litellm_params.model,
    contextLength,
    capabilities: detectCapabilitiesFromLiteLLM(modelInfo),
  };
}

function mapLooseDetailedModelToConfig(model: Record<string, unknown>): ModelConfig | null {
  const modelName = typeof model.model_name === 'string' ? model.model_name : undefined;
  const litellmParams =
    typeof model.litellm_params === 'object' && model.litellm_params !== null
      ? (model.litellm_params as Record<string, unknown>)
      : undefined;
  const modelId = typeof litellmParams?.model === 'string' ? litellmParams.model : modelName;

  if (!modelName || !modelId) {
    return null;
  }

  const modelInfo =
    typeof model.model_info === 'object' && model.model_info !== null
      ? (model.model_info as {
          max_tokens?: number | null;
          max_input_tokens?: number | null;
          supports_vision?: boolean | null;
        })
      : undefined;

  const contextLength =
    modelInfo?.max_tokens ??
    modelInfo?.max_input_tokens ??
    getModelMetadata(modelName).contextLength;

  return {
    name: modelName,
    id: modelId,
    contextLength,
    capabilities: detectCapabilitiesFromLiteLLM(modelInfo),
  };
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

function buildLiteLLMHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  return headers;
}

function resolveLiteLLMUrls(baseUrl: string, paths: string[]): string[] {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const urls = new Set<string>();

  for (const path of paths) {
    urls.add(path.startsWith('/') ? new URL(path, baseUrl).toString() : new URL(path, normalizedBase).toString());
  }

  return [...urls];
}

async function fetchLiteLLMModelInfo(
  baseUrl: string,
  apiKey?: string,
): Promise<unknown | null> {
  const headers = buildLiteLLMHeaders(apiKey);
  const modelInfoUrls = resolveLiteLLMUrls(baseUrl, ['/v1/model/info', '/model/info']);

  for (const modelInfoUrl of modelInfoUrls) {
    try {
      const response = await fetch(modelInfoUrl, {
        method: 'GET',
        headers,
      });

      if (response.ok) {
        const data: unknown = await response.json();
        const modelCount = Array.isArray((data as { data?: unknown })?.data)
          ? (data as { data: unknown[] }).data.length
          : 0;
        console.log(
          `Using LiteLLM model metadata from ${modelInfoUrl} for ${modelCount} models`,
        );
        return data;
      }

      if (response.status === 403) {
        console.log(
          `Cannot access ${modelInfoUrl} (HTTP 403); falling back to name-based capability detection`,
        );
      } else {
        console.log(`Model info unavailable at ${modelInfoUrl} (HTTP ${response.status})`);
      }
    } catch (_error) {
      console.log(`Model info endpoint not available at ${modelInfoUrl}, trying next URL`);
    }
  }

  return null;
}

async function fetchLiteLLMModelsList(
  baseUrl: string,
  apiKey?: string,
): Promise<z.infer<typeof LiteLLMModel>[]> {
  const headers = buildLiteLLMHeaders(apiKey);
  const modelsUrls = resolveLiteLLMUrls(baseUrl, ['models', '/v1/models', '/models']);
  let lastError: Error | undefined;

  for (const modelsUrl of modelsUrls) {
    try {
      const response = await fetch(modelsUrl, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        continue;
      }

      const data: unknown = await response.json();
      const modelCount = Array.isArray((data as { data?: unknown })?.data)
        ? (data as { data: unknown[] }).data.length
        : 0;
      console.log(`Using basic model list from ${modelsUrl}, found ${modelCount} models`);
      const parsedResponse = LiteLLMResponse.parse(data);
      return parsedResponse.data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error('Failed to fetch models from LiteLLM');
}

async function fetchModelsFromLiteLLM(baseUrl: string, apiKey?: string): Promise<ModelConfig[]> {
  const modelInfo = await fetchLiteLLMModelInfo(baseUrl, apiKey);

  if (modelInfo) {
    return convertDetailedLiteLLMToModelConfig(modelInfo);
  }

  console.log('LiteLLM /model/info unavailable; using name-based capability detection');
  const litellmModels = await fetchLiteLLMModelsList(baseUrl, apiKey);
  return convertLiteLLMToModelConfig(litellmModels);
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
