// Einheitlicher Zugang zum eingestellten KI-Anbieter (Gemini, Claude oder OpenAI-kompatibel).
import { analyzeLetterGemini, completeJsonGemini } from './providers/gemini.js';
import { analyzeLetterOpenAi, completeJsonOpenAi } from './providers/openai.js';
import { analyzeWithClaude, completeWithClaude } from './claude.js';

const PROVIDERS = {
  gemini: { analyze: analyzeLetterGemini, complete: completeJsonGemini },
  anthropic: { analyze: analyzeWithClaude, complete: completeWithClaude },
  openai: { analyze: analyzeLetterOpenAi, complete: completeJsonOpenAi },
};

export function createAiClient(config, { fetchImpl = (...args) => fetch(...args) } = {}) {
  const ai = config.ai;
  const impl = PROVIDERS[ai.provider];
  if (!ai.enabled || !impl) return { enabled: false, provider: ai.provider, label: ai.providerLabel, model: null };
  return {
    enabled: true,
    provider: ai.provider,
    label: ai.providerLabel,
    model: ai.model,
    /** @returns {Promise<{result: object, model: string}>} */
    analyzeLetter: ({ files, today, note }) => impl.analyze({ files, today, note, config, fetchImpl }),
    /** @returns {Promise<{result: object, model: string}>} */
    completeJson: ({ system, prompt, schema, maxTokens }) => impl.complete({ system, prompt, schema, config, fetchImpl, maxTokens }),
  };
}
