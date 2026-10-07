# WoHo Phone Agent — Architecture & Product Requirements

## Purpose
Build a permission-controlled Android-first AI phone agent on top of the WoHo AI DevKit. The agent must operate the owner's phone only after explicit owner consent and only within granted capabilities.

This document captures the Phone Agent requirements agreed during the design discussion and is the baseline for implementation.

## Product boundary
The product is larger than a calling bot:
- Calling and call conversation
- App launch and authorized UI interaction
- Notifications and other OS-supported device actions
- Customer/contact and conversation memory
- Human confirmation for sensitive actions
- Auditable permissions and action history
- Security/policy enforcement before every device action

The owner remains the ultimate authority.

## Core trust model
PHONE OWNER → Explicit Consent → WoHo Phone Agent → AI Orchestrator → Permission Engine → Security Policy → Risk / Confirmation → Action Executor → Android OS / authorized app

AI intent alone must never be sufficient to execute a device action.

## Permission model
Permissions are capability- and action-specific. Default state is deny.

Example capability groups:
- CALL: make, answer, end
- MESSAGING: read, compose, send
- CONTACTS: read, create/update/delete
- APP: launch, view, interact, sensitive-action
- NOTIFICATIONS: read/process
- DEVICE: only OS-supported and explicitly granted actions

Permissions should support scope, for example:
- allow interaction with WhatsApp
- deny interaction with banking applications
- allow contacts.read
- deny contacts.delete

The permission engine must be consulted before execution, not only during onboarding.

## Agent roles
### 1. Phone Supervisor / Orchestrator
Routes requests, maintains task state, selects tools/agents, handles recovery and completion.
### 2. Voice / Conversation Agent
Handles speech conversation, intent understanding, multilingual/Hinglish interaction and conversational context.
### 3. Calling Agent
Handles call lifecycle and call-specific actions.
### 4. App Control Agent
Launches and operates owner-authorized applications through supported Android mechanisms.
### 5. UI Interaction Agent
Performs bounded tap/type/scroll/navigation interactions on authorized UI surfaces.
### 6. Device Action Agent
Executes explicitly supported OS/device actions.
### 7. Permission & Security Agent
Evaluates capability, scope, policy, risk and authorization before execution.
### 8. Human Confirmation Agent
Requires explicit owner confirmation for configured high-risk actions.
### 9. Memory Agent
Stores only permitted conversation/task context and preferences with session/device isolation.
### 10. Call Summary / QA Agent
Produces post-call summaries and quality metadata without exposing unnecessary sensitive data.

## Execution contract
Every device action should follow:
1. Parse user intent.
2. Produce a bounded plan.
3. Resolve the target application/device resource.
4. Check explicit permission.
5. Check security policy.
6. Determine risk and whether confirmation is required.
7. Execute through an approved Android adapter.
8. Observe result.
9. Record an auditable action outcome.
10. Recover or stop safely on failure.

## Sensitive actions
The system must not bypass OS/app authentication, OTP, biometric checks, access controls or security boundaries.

Financial, authentication, security-setting and similarly sensitive operations should be protected by explicit policy and owner confirmation where applicable.

## Telephony architecture
Normal cellular call audio capture/injection can be restricted by Android/OEM policies. Therefore telephony must be designed as a dedicated subsystem rather than assuming unrestricted access to cellular audio.

Planned layers:
- call state machine
- telephony adapter
- audio bridge
- realtime STT
- conversation/agent brain
- realtime TTS
- call summary and audit

Where direct cellular audio is unavailable, a compliant VoIP/SIP/telephony-provider architecture can be used for AI-operated calls.

## Android-first implementation
The first implementation phase is Android Agent Core.

Expected native capabilities to evaluate and wrap:
- Accessibility Service for authorized UI interaction
- Android intents for supported app/system actions
- notification access where explicitly granted
- foreground execution where required
- runtime permissions
- device/app capability registry
- secure local session and action audit

The implementation must respect Android and target-app restrictions; “any application” means any application that the OS and target app expose through permitted mechanisms, not bypassing security controls.

## WoHo AI DevKit integration
Use the existing packages rather than rebuilding the AI foundation:
- @woho/core — model/provider-independent AI execution
- @woho/provider-openai — OpenAI-compatible provider
- @woho/agents — orchestration, planning, tools, approvals, limits and recovery
- @woho/tools — bounded tool execution and external APIs
- @woho/memory — session/project memory
- @woho/mcp — external tool integrations

## Phased delivery
### Phase 1 — Android Agent Core
- device registration
- owner consent
- capability/permission registry
- secure action executor contract
- Accessibility/UI adapter foundation
- app capability registry
- action audit trail
- deny-by-default policy
- unit/integration tests

### Phase 2 — Voice + Calling
- realtime voice pipeline
- call state machine
- calling agent
- conversation agent
- telephony adapter
- call summary

### Phase 3 — Authorized App Operations
- app control
- UI interaction planner/executor
- notifications
- contacts and messaging adapters
- per-app permission scopes
- confirmation policies

### Phase 4 — Production Safety
- policy engine hardening
- risk classification
- human approval flows
- memory/privacy controls
- audit and observability
- failure recovery
- Android compatibility matrix
- security regression suite

## Non-negotiable principles
1. Owner consent is required.
2. Default deny.
3. Every action is permission checked.
4. Permissions are scoped, revocable and auditable.
5. AI cannot bypass Android/app security.
6. High-risk actions require explicit confirmation according to policy.
7. Secrets and unnecessary personal data must not be exposed to the model.
8. All limits, timeouts and cancellations remain enforced.
9. Failed actions must fail closed.
10. The Android app is the device-control boundary; the DevKit remains the AI/orchestration engine.