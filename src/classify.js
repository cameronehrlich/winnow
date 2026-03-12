import { GoogleGenerativeAI } from '@google/generative-ai';
import { loadConfig } from './config.js';
import { loadAllRules, formatRulesForPrompt } from './rules.js';

let geminiClient;

function getClient() {
  if (!geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is required');
    geminiClient = new GoogleGenerativeAI(apiKey);
  }
  return geminiClient;
}

const SYSTEM_PROMPT = `You are an email triage assistant. Decide whether each email should be archived or kept in the inbox based on the triage rules provided.

DECISION:
- "archive": true — Auto-archive and mark read. Low-priority: marketing, notifications, newsletters, automated messages, anything the user doesn't need to act on.
- "archive": false — Leave in inbox for the user to handle.

Follow the triage rules closely. Rules marked "keep in inbox" should override rules marked "archive" when both match.

CONFIDENCE:
- Report confidence as a number 0-100
- If confidence is below 70, do NOT archive (err on the side of keeping in inbox)

EPHEMERAL EMAILS:
- Set "ephemeral": true for emails that are briefly interesting but don't need to stay in the inbox:
  - Verification codes, OTP, 2FA codes → also set "extractedCode" to the code string
  - Daycare/school check-in/check-out notifications
  - Delivery "out for delivery" or "delivered" updates
  - Ride receipts (Uber, Lyft)
  - Brief status updates that are nice to know but disposable
- Ephemeral emails get a short Slack FYI and are auto-archived

Respond with ONLY valid JSON, no markdown fences:
{"archive": true|false, "confidence": 0-100, "reason": "brief reason", "summary": "1-2 sentence plain-English summary of what this email is about and any action needed", "ephemeral": false, "extractedCode": null}

Set ephemeral to true and extractedCode to the code string if it's a verification/OTP email.`;

export async function classifyEmail(email, { account } = {}) {
  const config = loadConfig();
  const { rules } = loadAllRules(account);
  const rulesText = formatRulesForPrompt(rules);

  const emailText = [
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `Snippet: ${email.snippet}`,
    `Date: ${email.date}`,
    email.to ? `To: ${email.to}` : '',
  ].filter(Boolean).join('\n');

  const userPrompt = `TRIAGE RULES (custom rules take precedence over baseline):
${rulesText}

EMAIL TO CLASSIFY:
${emailText}`;

  const modelName = config.model?.name || 'gemini-2.0-flash';
  const model = getClient().getGenerativeModel({
    model: modelName,
    systemInstruction: SYSTEM_PROMPT,
  });

  const response = await model.generateContent(userPrompt);
  const text = response.response.text() || '{}';

  let result;
  try {
    // Strip markdown fences if present
    const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    result = JSON.parse(cleaned);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    result = match ? JSON.parse(match[0]) : {
      archive: false,
      confidence: 50,
      reason: 'Failed to parse classification response',
      summary: email.subject,
    };
  }

  // Backwards compat: convert old priority format to archive boolean
  if ('priority' in result && !('archive' in result)) {
    result.archive = result.priority === 'low';
  }

  // Safety: low confidence → don't archive
  if (result.confidence < 70 && result.archive) {
    result.archive = false;
    result.reason = `${result.reason} (kept in inbox due to ${result.confidence}% confidence)`;
  }

  // Fallback: try to extract OTP code from snippet — only if classifier explicitly flagged extractedCode
  // Don't blindly grab random numbers, as that catches years and other false positives
  let extractedCode = result.extractedCode || null;
  if (result.ephemeral && !extractedCode) {
    // Only try regex if subject/snippet strongly suggests a verification code
    const otpHints = /verif|code|otp|one.time|2fa|passcode|pin|token/i;
    if (otpHints.test(email.subject) || otpHints.test(email.snippet)) {
      const codeMatch = (email.snippet + ' ' + email.subject).match(/\b(\d{4,8})\b/);
      if (codeMatch) extractedCode = codeMatch[1];
    }
  }

  // Map archive boolean to legacy priority for state compat
  const priority = result.archive ? 'low' : 'normal';

  return {
    archive: result.archive,
    priority,
    confidence: result.confidence,
    reason: result.reason,
    summary: result.summary,
    ephemeral: result.ephemeral || false,
    extractedCode,
  };
}
