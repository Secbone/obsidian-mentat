import { parseJson } from '../../utils/json-healer';

export interface ParsedFinalAnswer {
  explanation: string;
  answer: string;
}

export function parseFinalAnswer(rawContent: string): ParsedFinalAnswer {
  if (rawContent.includes('<final_answer>')) {
    const parts = rawContent.split('<final_answer>');
    const explanationPart = parts[0].trim();
    let answerPart = parts[1] || '';
    if (answerPart.includes('</final_answer>')) {
      answerPart = answerPart.split('</final_answer>')[0];
    }
    return { explanation: explanationPart, answer: answerPart.trim() };
  }
  return { explanation: '', answer: rawContent.trim() };
}

export function resolveToolDisplayName(name: string, arguments_: unknown): string {
  if (name === 'spec' || name === 'invoke') {
    try {
      const args = typeof arguments_ === 'string' ? parseJson<Record<string, unknown>>(arguments_) : arguments_;
      const skillName = (args as Record<string, unknown>)?.skill_name;
      if (skillName) return `${name}:${skillName}`;
    } catch (_e) { /* keep original */ }
  }
  return name;
}

export function getToolShortName(displayName: string): string {
  const shortName = displayName.split(':').pop() || displayName;
  return displayName === 'spec' || displayName.startsWith('spec:') ? `查看工具说明 · ${shortName}` : shortName;
}
