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
  return displayName.split(':').pop() || displayName;
}

export function truncateText(text: string, threshold: number = 500): {
  display: string;
  isTruncated: boolean;
  fullText: string;
} {
  if (text.length <= threshold) {
    return { display: text, isTruncated: false, fullText: text };
  }
  return {
    display: text.slice(0, threshold) + '...',
    isTruncated: true,
    fullText: text,
  };
}

export function valueToString(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

// Braille dot spinner shared by both themes
export const BRAILLE_DOTS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function getSpinnerChar(): string {
  const idx = Math.floor((Date.now() / 80) % BRAILLE_DOTS.length);
  return BRAILLE_DOTS[idx];
}

export function getSpinnerPrefix(): string {
  return getSpinnerChar();
}
