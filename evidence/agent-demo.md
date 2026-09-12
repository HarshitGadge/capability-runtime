# Agent-driven invocation

Produced by `npm run agent`. An LLM is given the capabilities as tools and a
natural-language task; it chooses which to call. The model never sees the portal —
deterministic replay runs underneath each tool call. Regulated outputs are redacted in
each run's evidence; the values the agent quotes back are the caller's in-process result.

```
TASK: A member called in — what is the current savings balance for member 12345?
agent has 2 capabilities: member.read_savings_balance, member.open_sub_account
  → agent calls member_read_savings_balance({"member_id":"12345"})
  ← member_read_savings_balance returned: success {"savings_balance":18204.37,"savings_account_number":"4718355901","member_name":"J. Whitfield","status":"active"}
AGENT ANSWER (2 turns):
  Here's what came back for member 12345:
- **Member:** J. Whitfield
- **Status:** Active
- **Savings account:** 4718355901
- **Current savings balance:** $18,204.37
Let me know if you need anything else for this member.

TASK: Can you confirm whether member 99999 exists in our system?
agent has 2 capabilities: member.read_savings_balance, member.open_sub_account
  → agent calls member_read_savings_balance({"member_id":"99999"})
  ← member_read_savings_balance returned: business_outcome MEMBER_NOT_FOUND
AGENT ANSWER (2 turns):
  No — member 99999 does not exist. The lookup returned MEMBER_NOT_FOUND, meaning there's no member record in the system for that ID.
If you expected a record here, it's worth double-checking the ID for a typo or transposed digits, since the lookup requires an exact numeric match and doesn't support partial IDs. Happy to re-run it against a corrected number.
```
