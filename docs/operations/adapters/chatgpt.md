# ChatGPT adapter note

Use the [Portable CortextOS Twin Operating Guide](../PORTABLE-TWIN-OPERATING-GUIDE.md) and the assigned agent's CortextOS profile as the operating authority. A ChatGPT conversation is an interaction/model surface, not a CortextOS identity registry, task ledger, approval authority, or scheduler.

Confirm the registered agent identity and organization from the current CortextOS session/runtime configuration. Use task handoffs to determine work scope, not to infer identity. Read the same CortextOS profile, handoff, task, and routine records used by other model surfaces. Do not create ChatGPT-native scheduled tasks or automations that duplicate CortextOS crons. If the current ChatGPT session cannot access the CLI or a required connector, report that limitation; a connected app or visible conversation does not establish agent access or operational readiness.

## Provenance

### Verified in this session

- This note describes the provider-neutral operating boundary; it makes no claim that a particular ChatGPT session has local CLI, connector, or account access.

### Reported by another verified source

- No ChatGPT-specific capability or account state is asserted here.

### Inference

- Using the same CortextOS identity, task, approval, and schedule records across ChatGPT and other model surfaces avoids duplicate authorities.

### Open assumptions

- The current session must have approved access to CortextOS CLI and any account connector required by its assigned task.
