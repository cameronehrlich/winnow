const EFFECTS = new Set(['archive', 'keep']);
const BASES = new Set([
  'exact_rule',
  'semantic_rule',
  'baseline',
  'server_automation',
  'classifier',
  'ephemeral',
]);
const ATTRIBUTIONS = new Set(['deterministic', 'model_cited']);
export const HANDLING_UNDO_LEASE_MS = 5 * 60 * 1000;

function boundedText(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function normalizeAppliedRule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = boundedText(value.id, 128);
  const attribution = boundedText(value.attribution, 32);
  const effect = boundedText(value.effect, 16);
  const revision = boundedText(value.revision, 128);
  if (!id || !ATTRIBUTIONS.has(attribution)) return null;
  return {
    id,
    description: boundedText(value.description, 1000),
    scope: boundedText(value.scope, 64),
    source: boundedText(value.source, 64),
    editable: value.editable === true,
    attribution,
    ...((effect === 'archive' || effect === 'keep') ? { effect } : {}),
    ...(revision ? { revision } : {}),
  };
}

export function normalizeHandlingDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!EFFECTS.has(value.effect) || !BASES.has(value.basis)) return null;
  const handledAt = boundedText(value.handledAt, 64);
  if (!handledAt || Number.isNaN(Date.parse(handledAt))) return null;
  const numericConfidence = value.confidence === null || value.confidence === undefined
    ? NaN
    : Number(value.confidence);
  const confidence = Number.isFinite(numericConfidence)
    ? Math.max(0, Math.min(100, numericConfidence))
    : null;
  const appliedRule = normalizeAppliedRule(value.appliedRule);
  return {
    ...(boundedText(value.id, 128) ? { id: boundedText(value.id, 128) } : {}),
    effect: value.effect,
    basis: value.basis,
    explanation: boundedText(value.explanation, 2000),
    confidence,
    handledAt,
    ...(appliedRule ? { appliedRule } : {}),
  };
}

export function handlingDecisionKey(item) {
  const decision = normalizeHandlingDecision(item?.handlingDecision);
  if (!decision) return '';
  return decision.id || `${item?.id || ''}:${decision.handledAt}`;
}

export function handlingUndoDesiredAction(item) {
  const decision = normalizeHandlingDecision(item?.handlingDecision);
  if (!decision) return null;
  return decision.effect === 'archive' ? 'move-to-inbox' : 'archive';
}

export function handlingUndoTargetReached(item, action = handlingUndoDesiredAction(item)) {
  if (action === 'move-to-inbox') return item?.mailboxState === 'inbox';
  if (action === 'archive') return item?.mailboxState === 'archived';
  return false;
}

export function handlingUndoAction(item, {
  nowMs = Date.now(),
  leaseMs = HANDLING_UNDO_LEASE_MS,
} = {}) {
  const decision = normalizeHandlingDecision(item?.handlingDecision);
  if (!decision) return null;
  const decisionKey = handlingDecisionKey(item);
  if (item.handlingUndoDecisionId === decisionKey) {
    if (item.handlingUndoStatus === 'completed') return null;
    if (item.handlingUndoStatus === 'executing') {
      const claimedAt = Date.parse(item.handlingUndoUpdatedAt || '');
      const leaseIsFresh = Number.isFinite(claimedAt) && nowMs - claimedAt < leaseMs;
      if (leaseIsFresh) return null;
    }
  }
  if (
    decision.effect === 'archive'
    && item.triageState === 'auto_archived'
    && item.mailboxState === 'archived'
  ) return 'move-to-inbox';
  if (
    decision.effect === 'keep'
    && item.triageState === 'kept'
    && item.mailboxState === 'inbox'
  ) return 'archive';
  return null;
}
