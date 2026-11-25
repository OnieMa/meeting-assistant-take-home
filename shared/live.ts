export type ReplyLanguage = 'zh' | 'en';

export const liveLimits = {
  lifetimeMs: 30 * 60 * 1000,
  question: 800,
  context: 48_000,
  reply: 2_000,
} as const;

export interface LiveReply {
  language: ReplyLanguage;
  meeting: string;
  suggestion: string;
}

export interface SignedReply extends LiveReply {
  speechProof: string;
}

export function speechText(reply: LiveReply) {
  const prefix = reply.language === 'zh' ? 'AI 建议：' : 'AI suggestion: ';
  return [reply.meeting, reply.suggestion && prefix + reply.suggestion].filter(Boolean).join('\n');
}
