---
name: sim-guest
description: Simulate a guest message through the auto-responder and show exactly what reply would be sent (or whether it escalates to the host). Pass the guest message as the argument.
---

POST to https://airbnb-autohost2-production.up.railway.app/webhook/test with the provided message as {"message": "<arg>", "guest_name": "Test Guest"}.
Use Authorization: Bearer 51419b9c8d371fca2c641965952729276fef5f82cbc38a27f3eb9ca708b600d2

Show:
- The full drafted reply (untruncated)
- Whether it matched a hardcoded trigger (detectHardcodedResponse) or was Claude-generated
- confident: true/false — if false it would escalate to host via SMS instead of replying
- Whether a concierge email side-effect would fire (if the message matches CONCIERGE_REGEX)

Hardcoded triggers for reference: early check-in, late checkout, towels/linens, HVAC/thermostat, parking, age requirement, front-desk access issues.

Example: /sim-guest "the front desk wont let me in"
Example: /sim-guest "what's the wifi password"
Example: /sim-guest "can I check in at 1pm tomorrow"
Example: /sim-guest "do you have a minimum age requirement"
