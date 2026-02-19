/**
 * Schema validation for reasoning intent output.
 * Uses Zod for runtime validation – invalid outputs are stored but never executed.
 */

import { z } from 'zod';

export const IntentSchema = z.object({
  intentId: z.string().uuid(),
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  action: z.enum(['search', 'calculate', 'summarize', 'translate']),
  parameters: z.record(z.unknown()),
  confidence: z.number().min(0).max(1),
});

export type ValidatedIntent = z.infer<typeof IntentSchema>;

export interface ValidationResult {
  valid: boolean;
  data?: ValidatedIntent;
  error?: string;
}

export function validateIntent(raw: unknown): ValidationResult {
  const result = IntentSchema.safeParse(raw);
  if (result.success) {
    return { valid: true, data: result.data };
  }
  return {
    valid: false,
    error: result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; '),
  };
}
