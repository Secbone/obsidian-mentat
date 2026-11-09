import { z } from 'zod';

const message = z.object({ role: z.enum(['system','user','assistant','tool']), content: z.string(), timestamp: z.number().optional(),
  tool_calls: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.union([z.string(),z.record(z.unknown())]) }).passthrough()).optional() }).passthrough();
export const runSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^run-[a-zA-Z0-9-]+$/), sessionId: z.string(), agentId: z.string(), prompt: z.string(),
  maxTurns: z.number().int().min(1).max(99), enableSkills: z.boolean(),
  status: z.enum(['running','waiting_for_user','waiting_for_approval','completed','failed','cancelled','interrupted']),
  createdAt: z.number().finite(), updatedAt: z.number().finite(), baseMessageCount: z.number().int().min(0),
  messages: z.array(message),
  operations: z.record(z.object({ id: z.string(), name: z.string(), category: z.string(), status: z.enum(['planned','running','finished','unknown']),
    result: z.object({ success: z.boolean() }).passthrough().optional() }).passthrough()),
  interactions: z.record(z.object({ id: z.string(), operationId: z.string(), kind: z.enum(['question','approval']), question: z.string(),
    outcome: z.object({ kind: z.enum(['answered','approved','rejected','cancelled','expired']), answer: z.string().optional() }).optional() }).passthrough()),
  events: z.array(z.object({ id: z.string(), sequence: z.number().int().min(1), timestamp: z.number().finite(), type: z.string() }).passthrough()),
  children: z.record(z.array(message)).optional()
}).passthrough();
