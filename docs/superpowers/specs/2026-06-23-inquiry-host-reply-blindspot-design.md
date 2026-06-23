# Inquiry Host-Reply Blind Spot — Design

**Date:** 2026-06-23
**Branch:** `fix/inquiry-host-reply-blindspot`
**Status:** Approved (design)

## Problem

A potential guest ("Rebecka") sent an inquiry asking about smoking. The host replied
manually (via the Airbnb app) that **smoking is allowed on the patio**. The auto-responder
then replied that **smoking is not permitted anywhere**, directly contradicting the host —
likely costing the booking.

The host is fine with the bot replying after a manual reply. The failure is that the bot
**contradicted the host's stated direction** and reverted to the stored house rule.

## Root cause (code-confirmed)

Two compounding causes:

1. **Host webhooks are dropped before buffering.** `src/server.js:1873-1877` returns early
   on `sender_role` of `host` / `co-host` / `teammate`:

   ```js
   const senderRole = msg.sender_role;
   if (senderRole === 'host' || senderRole === 'co-host' || senderRole === 'teammate') {
     console.log(`[webhook] sender_role="${senderRole}" — ignoring`);
     return;   // ← never reaches pushConvoMsg
   }
   ```

   The conversation buffer `recentMsgsByConvo` (`src/server.js:113`) only ever receives
   `'guest'` turns (`1900`) and the bot's own replies (`2005`) — never the host's manual
   reply. For **inquiries** this loss is total: `GET /inquiries/{id}/messages` returns 405
   (`493-495`, `568-572`), so the in-memory buffer is the *only* thread history that exists.
   The model literally never saw "smoking OK on patio."

2. **No host-authority directive.** Even with the host message present, nothing tells the
   model that a host's in-thread statement outranks stored house rules. The prompt anchors
   hard to stored facts: `src/server.js:1600` ("NEVER invent facts…"), `1627` ("Never invent
   facts — all policies, times, fees, and details must come from the information above"), with
   house rules injected at `1670` / `1683`. The "no smoking" came straight from the
   `HOUSE_RULES` field.

The prior session's diagnosis attributed the blind spot solely to the 405-GET limitation.
That is real but incomplete: host messages that **do** arrive via webhook are explicitly
discarded at `1874`. This makes the gap directly fixable on our side.

## Design

### Part 1 — Ingest host webhooks into the conversation buffer

At `src/server.js:1873-1877`, when `sender_role` is `host` / `co-host` / `teammate` **and** a
`conversationId` is present:

- Append the host message to the buffer: `pushConvoMsg(conversationId, 'host', messageBody)`.
- **Then** return — the bot still never generates a reply to the host's own message. We only
  record it so it becomes thread history.

Effects:

- On the guest's next turn, `buildThreadMessages` (`1456`) maps the buffered host turn to an
  `assistant` turn via `roleOf` (`1458`, `HOST_ROLES`).
- The existing thread-note "Messages you have ALREADY sent to this guest… do NOT repeat them
  or contradict them" (`1750`) now also covers the host's manual reply.

Constraints / edge cases:

- A host webhook with **no** `conversationId` remains a safe no-op (cannot buffer without a
  key) — just return as before.
- The buffer is in-memory and resets on restart (pre-existing limitation, unchanged).
- The empty-body guard already at `1896` runs *after* the host short-circuit, so host
  ingestion must apply its own empty-body check before buffering.

### Part 2 — Host-in-thread-authority directive

Add a guardrail directive to the **stable system prompt** (near the existing fact-anchor lines
`1600` / `1627`), so it applies to **both** inquiries and reservations:

> Anything the host has already said to this guest in this thread is authoritative and
> **overrides the stored house rules, amenities, and policies**. Never contradict what the
> host told the guest. If the host's in-thread statement differs from a stored rule, follow
> the host.

**Boundary (explicitly scoped):** this authority covers **house rules, amenities, and
policies only**. It does **not** extend to:

- **Money / refunds** — the existing `isMoneyComplaint` escalation (`1967`) stays fully in
  force; the bot never promises refunds.
- **Safety** — the bot does not follow a host statement into anything unsafe.

This resolves the tension with the "use ONLY stored facts" anchor: for rules / amenities /
policies, the host's live in-thread word outranks the stored rule.

## Out of scope (unchanged)

- Reservation thread-fetch path (`1726`) — already includes host messages from the real
  thread; only the Part 2 directive touches it.
- Money-complaint flow, concierge/access flow, send scheduling, and host-reply suppression
  timing (`dispatchPendingReply`).

## Verification

1. **Production-log confirmation (required before relying on Part 1):** confirm that a host
   reply typed in the **Airbnb app** actually arrives as a `message.created` webhook with
   `sender_role:'host'` (look for the `[webhook] sender_role="host" — ignoring` line, or the
   raw payload, around the Rebecka incident). The mechanism is fixed regardless; Part 2 is the
   safety net if Airbnb-app replies do not webhook through.

2. **Unit tests** (follow existing `scripts/test-*.js` pattern):
   - A host-role webhook **with** a `conversationId` appends one `'host'` turn to the buffer.
   - A host-role webhook with **no** `conversationId` is a safe no-op.
   - A host message is **never** replied to (no `scheduleReply` / `draftReply` for it).

3. **Prompt-assembly test (the Rebecka case, before/after):** given a buffer containing the
   host turn "smoking is fine on the patio" and `HOUSE_RULES` = "no smoking", assert the
   assembled `draftReply` system+messages payload contains **both** the host statement and the
   host-authority directive. (Tests prompt construction, not the live model.)

4. **Before/after demonstration for the host:** show the assembled prompt now containing the
   "smoking OK on patio" reply, and the model honoring it instead of reciting "no smoking."

## Delivery

- Build on branch `fix/inquiry-host-reply-blindspot`.
- Show the diff and real test output; **do not deploy** until the host explicitly says so.
