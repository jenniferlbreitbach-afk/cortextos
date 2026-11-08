# Claude adapter note

Use the [Portable CortextOS Twin Operating Guide](../PORTABLE-TWIN-OPERATING-GUIDE.md) and the assigned agent's CortextOS profile as the operating authority. Claude is a chat/model surface, not an identity registry, task ledger, approval authority, or scheduler.

Confirm the registered agent identity and organization from the current CortextOS session/runtime configuration. Use task handoffs to determine work scope, not to infer identity. Use the verified CortextOS CLI for shared task, health, and schedule state when available. Do not create Claude-native routines that duplicate saved CortextOS crons. If the CLI or required connector is unavailable, report that boundary; do not imply the agent is active merely because its chat exists.

## Provenance

### Verified in this session

- This note adds no claim about Claude features or account access beyond the stated operating boundary.

### Reported by another verified source

- No provider-specific capability is asserted here.

### Inference

- Treating Claude as a replaceable chat/model surface avoids a second task or scheduler authority.

### Open assumptions

- The session must have approved access to the CortextOS CLI and any account connector required for the assigned task.
