// services/HarnessGateway.js
//
// The ONE place that enforces AGENTIC_HARNESS.md Phase 3's trust-level
// gate. The harness's executor calls THROUGH this for every service
// method invocation — never a service directly — so the gate can't be
// bypassed by a route/tool that forgets to check. Individual services
// (AssemblyService, CartService, etc.) remain completely unaware of
// trust levels, confirmation, or the harness at all; this wrapper is
// what makes "the harness acts as the member" and "some actions pause
// for confirmation" possible without touching any of Phase 1's services.
//
// Not exposed to the browser — only the harness's own executor imports
// this. A normal user click in the UI still goes browser -> api/*.js ->
// service directly, same as every existing route in this codebase;
// trust-level gating only applies to the AGENT'S actions, per the
// product decision that a human acting directly never needs to confirm
// their own clicks to themselves.

import { canAutoExecute, severityOf } from '../../api/_lib/harnessPolicy.js'
import { PendingActionRepository } from '../repositories/PendingActionRepository.js'
import { ConfirmationRequiredError, ValidationError } from '../repositories/errors.js'

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

export class HarnessGateway {
  constructor({ pendingActionRepo = new PendingActionRepository() } = {}) {
    this.pendingActionRepo = pendingActionRepo
  }

  /**
   * Invokes `serviceInstance[methodName](args)` on the harness's behalf,
   * gated by `memberTrustLevel`. Three outcomes:
   *   - Below the required trust level, no confirmation flag on args ->
   *     throws ConfirmationRequiredError AND writes a pending_actions
   *     row in the same call, so the executor has nothing else to do
   *     except suspend and surface the pending action id.
   *   - Below the required trust level, `args.confirmed === true` (the
   *     resume path, after a human approved) -> executes anyway. The
   *     approval itself is validated by the executor calling
   *     resolvePendingAction() first — this method trusts a `confirmed`
   *     flag because by the time it's set, that validation already ran.
   *   - At or above the required trust level -> executes immediately,
   *     no pending_actions row at all.
   *
   * `actionName` is the "ServiceClass.methodName" string used as the
   * harnessPolicy.js key — passed explicitly rather than derived via
   * reflection, so the policy map stays the single source of truth for
   * what's callable (an unlisted method throws before anything runs).
   */
  async invoke({ actionName, serviceInstance, methodName, args, memberId, memberTrustLevel, isAgent = true, reason = null }) {
    if (typeof serviceInstance[methodName] !== 'function') {
      throw new ValidationError(`${actionName}: no such method`)
    }

    const severity = severityOf(actionName)   // throws if not in the policy map — fail closed
    const alreadyConfirmed = args?.confirmed === true

    if (!alreadyConfirmed && !canAutoExecute(actionName, memberTrustLevel)) {
      const pending = await this.pendingActionRepo.insert({
        id: genId(), memberId, isAgent, actionName, actionArgs: args, severity, reason,
      })
      throw new ConfirmationRequiredError(
        `"${actionName}" requires confirmation at the current trust level.`,
        { actionName, actionArgs: args, severity, reason: pending.id }
      )
    }

    // `confirmed` is a gateway-level flag, not a real service parameter —
    // strip it before calling through, so services never see it.
    const { confirmed, ...cleanArgs } = args || {}
    return serviceInstance[methodName](cleanArgs)
  }

  /** Called once a human approves/denies a pending action (e.g. from an
   *  in-app inbox). On approval, the CALLER is responsible for re-invoking
   *  invoke() with args.confirmed = true and the same actionArgs stored
   *  on the pending row — this method only flips the row's status and
   *  hands back what to replay. */
  async resolvePendingAction({ pendingActionId, decision, resolvedBy }) {
    if (!['approved', 'denied'].includes(decision)) {
      throw new ValidationError(`decision must be "approved" or "denied"`)
    }
    const updated = await this.pendingActionRepo.resolve(pendingActionId, { status: decision, resolvedBy })
    if (!updated) {
      throw new ValidationError('This action was already resolved or no longer exists.')
    }
    return updated
  }
}