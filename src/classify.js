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

const SYSTEM_PROMPT = `You are an email triage assistant. Classify emails into exactly one priority level.

PRIORITY LEVELS:
- "low" — Archive and mark read. Marketing, notifications, newsletters, automated messages.
- "normal" — Mark as read, keep in inbox. Worth reviewing but not urgent.
- "urgent" — Leave unread in inbox + alert. Security, time-sensitive, important people, billing issues.

SAFETY RULES (override all other rules):
- 2FA/verification codes → ALWAYS urgent, never archive
- Calendar invitations → ALWAYS at least normal, never archive
- Payment/invoice/billing emails → ALWAYS at least normal, never archive
- Threads the user has replied to → ALWAYS at least normal, never archive

CONFIDENCE:
- Report confidence as a number 0-100
- If confidence is below 70, bump the priority UP one level (low→normal, normal→urgent)
- Flag low-confidence classifications with the reason

EPHEMERAL EMAILS:
- Set "ephemeral": true for emails that are briefly interesting but don't need to stay in the inbox:
  - Verification codes, OTP, 2FA codes → also set "extractedCode" to the code string
  - Daycare/school check-in/check-out notifications
  - Delivery "out for delivery" or "delivered" updates
  - Ride receipts (Uber, Lyft)
  - Brief status updates that are nice to know but disposable
- Ephemeral emails get a short Slack FYI and are auto-archived

Respond with ONLY valid JSON, no markdown fences:
{"priority": "low|normal|urgent", "confidence": 0-100, "reason": "brief reason", "summary": "1-2 sentence plain-English summary of what this email is about and any action needed", "neverArchive": false, "ephemeral": false, "extractedCode": null}

Set neverArchive to true if the email matches any safety rule above.
Set ephemeral to true and extractedCode to the code string if it's a verification/OTP email.`;

export async function classifyEmail(email) {
  const config = loadConfig();
  const { rules, neverArchive } = loadAllRules();
  const rulesText = formatRulesForPrompt(rules);

  const emailText = [
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `Snippet: ${email.snippet}`,
    `Date: ${email.date}`,
    email.to ? `To: ${email.to}` : '',
  ].filter(Boolean).join('\n');

  const userPrompt = `TRIAGE RULES (custom rules take precedence):
${rulesText}

NEVER-ARCHIVE PATTERNS:
${neverArchive.map(p => `- ${p}`).join('\n')}

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
      priority: 'normal',
      confidence: 50,
      reason: 'Failed to parse classification response',
      summary: email.subject,
      neverArchive: false,
    };
  }

  // Apply confidence bump rule
  if (result.confidence < 70) {
    const original = result.priority;
    if (result.priority === 'low') {
      result.priority = 'normal';
    } else if (result.priority === 'normal') {
      result.priority = 'urgent';
    }
    if (original !== result.priority) {
      result.bumped = true;
      result.originalPriority = original;
      result.reason = `${result.reason} (bumped from ${original} due to ${result.confidence}% confidence)`;
    }
  }

  // Enforce never-archive
  if (result.neverArchive && result.priority === 'low') {
    result.priority = 'normal';
    result.bumped = true;
    result.originalPriority = 'low';
    result.reason = `${result.reason} (bumped: matches never-archive rule)`;
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

  return {
    priority: result.priority,
    confidence: result.confidence,
    reason: result.reason,
    summary: result.summary,
    neverArchive: result.neverArchive || false,
    bumped: result.bumped || false,
    originalPriority: result.originalPriority || null,
    ephemeral: result.ephemeral || false,
    extractedCode,
  };
}
