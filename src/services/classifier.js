import OpenAI from 'openai';
import { classificationPrompt, buildClassificationMessage } from '../prompts/classification.js';
import logger from '../logger.js';

let openai = null;

export function initializeOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set');
  }
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  logger.info('OpenAI client initialized');
}

export async function classifyEmail(email) {
  if (!openai) {
    initializeOpenAI();
  }

  const userMessage = buildClassificationMessage(email);

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: classificationPrompt },
        { role: 'user', content: userMessage }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 200
    });

    const content = response.choices[0].message.content;
    const result = JSON.parse(content);

    // Validate response
    if (!['IMPORTANT', 'REVIEW', 'JUNK'].includes(result.classification)) {
      throw new Error(`Invalid classification: ${result.classification}`);
    }

    if (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 1) {
      result.confidence = 0.5;
    }

    logger.info(`Classified email "${email.subject}" as ${result.classification} (${result.confidence}): ${result.reason}`);

    return {
      classification: result.classification,
      confidence: result.confidence,
      reason: result.reason || 'No reason provided'
    };
  } catch (error) {
    logger.error('Classification error:', error);
    // Default to REVIEW on error to be safe
    return {
      classification: 'REVIEW',
      confidence: 0,
      reason: `Classification error: ${error.message}`
    };
  }
}

export function isOpenAIReady() {
  return openai !== null || !!process.env.OPENAI_API_KEY;
}
