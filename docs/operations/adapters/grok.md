# Grok adapter note

Use the [Portable CortextOS Twin Operating Guide](../PORTABLE-TWIN-OPERATING-GUIDE.md) and the assigned agent's CortextOS profile as the operating authority. Grok is a chat/model surface, not an identity registry, task ledger, approval authority, or scheduler.

Confirm the registered agent identity and organization from the current CortextOS session/runtime configuration. Use task handoffs to determine work scope, not to infer identity. Consult the same CortextOS records used by other model surfaces. Do not create Grok-native routines that duplicate saved CortextOS crons. If the current Grok session cannot access the CLI or required account connector, report the limitation and leave the task/routine state unchanged.

## Provenance

### Verified in this session

- This note adds no claim about Grok features or account access beyond the stated operating boundary.

### Reported by another verified source

- No provider-specific capability is asserted here.

### Inference

- Treating Grok as a replaceable chat/model surface avoids a second task or scheduler authority.

### Open assumptions

- The session must have approved access to the CortextOS CLI and any account connector required for the assigned task.
