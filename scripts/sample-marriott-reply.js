// Sample-only (no deploy): runs one guest message through draftReply's EXACT prompt
// assembly under the current style vs the proposed Marriott-style voice, so we can
// compare the actual replies. Facts/policies are identical in both — only the style
// block differs. Run: ANTHROPIC_API_KEY=... node scripts/sample-marriott-reply.js
const HOST = {
  name: 'Cal',
  checkin: '4:00 PM',
  checkout: '11:00 AM',
  houseRules: "No smoking of any kind inside or outside the property. No pets. No parties, events, or gatherings — the space is for registered guests only. Quiet hours are after 9pm. Parking is paid street/lot parking throughout downtown Atlanta — we'll send a full parking guide with the best options and rates.",
};
const propertyName = 'World Cup Apartment Flat 10 to 14 Nights Premier Arena Location';
const guestName = 'Zee';
const messageBody = 'cant you tell me a little bit about your property'; // the real, non-hardcoded message

const COMMON = `
Confidence rules:
- Set "confident": true when you can answer fully from the information provided.
- Set "confident": false when you genuinely don't know (specific codes, policies not in context).
- NEVER invent facts. If unsure, set "confident": false and "reply" to "".`;

const STYLE_OLD = `
Reply style rules:
- Open with a brief warm greeting (e.g. "Hi [Name]!"), then immediately answer the question.
- Do NOT lead with check-in details, house rules, or unrelated information unless the guest asked.
- Be concise (2–4 sentences) unless the question genuinely needs more.
- No sign-off or signature.`;

const STYLE_NEW = `
Reply style — Marriott-style hospitality service (voice only; never change facts/policies):
- Warm & gracious: make the guest feel genuinely welcomed and valued.
- Polished and professional, yet warm — never stiff or robotic, and never overly casual/slangy.
- Open with a brief, warm greeting using the guest's first name, then answer the question directly.
- Anticipate needs: when relevant, proactively offer a helpful related detail or extra — but do not dump unrelated info or recite check-in/house rules unless they relate to the question.
- Concise and easy to read — typically 2–5 sentences; more only if the question truly needs it.
- Always close with a gracious offer to help further.
- Do not add a name signature/sign-off.
- Never invent facts — all policies, times, fees, and details must come from the information above.`;

const jsonInstr = style => `
You MUST respond with a single valid JSON object — no markdown, no extra text:
{ "confident": true or false, "reply": "the message to send the guest" }
${COMMON}
${style}`;

// Mirrors draftReply's no-profile branch assembly.
const buildPrompt = style => `You are ${HOST.name}, an Airbnb host with a warm, customer-service-oriented style.

Property: ${propertyName}
Check-in: ${HOST.checkin} | Check-out: ${HOST.checkout}
House rules: ${HOST.houseRules}
${jsonInstr(style)}`;

async function callClaude(systemPrompt, userMsg) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 600, system: systemPrompt, messages: [{ role: 'user', content: userMsg }] }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.content?.[0]?.text || '';
}
const parse = raw => { const m = raw.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : { confident: false, reply: '(no JSON)' }; };

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) { console.log('ANTHROPIC_API_KEY not set'); process.exit(1); }
  const userMsg = `Guest ${guestName} says: "${messageBody}"`;
  console.log(`Test message → "${messageBody}"\n`);
  for (const [label, style] of [['CURRENT STYLE', STYLE_OLD], ['MARRIOTT STYLE', STYLE_NEW]]) {
    const out = parse(await callClaude(buildPrompt(style), userMsg));
    console.log(`──────── ${label} ────────`);
    console.log(`confident: ${out.confident}`);
    console.log(out.reply + '\n');
  }
})();
