import { createHash } from 'node:crypto';

export function ruleRevision(rule) {
  if (typeof rule?.updatedAt === 'string' && rule.updatedAt) return rule.updatedAt;
  const definition = JSON.stringify({
    id: rule?.id || '',
    type: rule?.type || '',
    effect: rule?.effect || (rule?.archive === true ? 'archive' : 'keep'),
    match: rule?.match || '',
    matcherKind: rule?.matcherKind || '',
    matcherValue: rule?.matcherValue || '',
    subjectMatchMode: rule?.subjectMatchMode || '',
    subjectMatchValue: rule?.subjectMatchValue || '',
    source: rule?.source || '',
  });
  return `definition:${createHash('sha256').update(definition).digest('base64url').slice(0, 24)}`;
}
