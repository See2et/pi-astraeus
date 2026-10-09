import { AgentSession, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

type Owner = { waking: boolean; flush(): void };
type Pending = { sessionId: string; anchors: Set<string>; attempts: number; retryAt: number };
type Flight = { prompts: number; messages?: number; active?: boolean; pending?: Pending; owner?: Owner };
const onBranch = (ctx: ExtensionContext, pending: Pending) =>
  ctx.sessionManager.getSessionId() === pending.sessionId &&
  ctx.sessionManager.getBranch().some(entry => pending.anchors.has(entry.id));
type Observer = { flights: WeakMap<object, Flight>; messagesObserved?: boolean };
const observerKey = Symbol.for('pi-astraeus:prompt-flight-observer');

// Pi 1.0.4 has no preflight-complete event: isIdle() is true while prompt()
// awaits input/auth/before_agent_start/images. Observe the exported SDK method,
// not agent.prompt or private fields, so handled inputs and failures also exit
// the reservation. One observer survives extension reload; unregistered sessions
// pass through unchanged. This is runtime adaptation, not an upstream file edit.
function observePrompts(): Observer {
  const prototype = AgentSession.prototype as AgentSession & { [observerKey]?: Observer };
  const existing = prototype[observerKey];
  const observer: Observer = existing ?? { flights: new WeakMap() };
  if (!existing) {
    const prompt = prototype.prompt;
    prototype.prompt = async function (...args: Parameters<AgentSession['prompt']>) {
      const flight = observer.flights.get(this.sessionManager);
      if (!flight?.owner) return prompt.apply(this, args);
      flight.prompts++;
      try {
        // An idle notification already acquired the agent before this user arrived.
        // Wait once, before submission; do not catch/retry a rejected user prompt or
        // change explicit steer/followUp behavior or ordinary streaming errors.
        const [text, options] = args;
        const command = (options?.expandPromptTemplates ?? true) && text.startsWith('/') &&
          this.extensionRunner.getCommand(text.slice(1).split(' ')[0]);
        if (flight.owner.waking && this.isStreaming && !options?.streamingBehavior && !command) await this.waitForIdle();
        return await prompt.apply(this, args);
      } finally {
        flight.prompts--;
        if (!flight.prompts) flight.owner?.flush();
      }
    };
    Object.defineProperty(prototype, observerKey, { value: observer });
  }
  if (!observer.messagesObserved) {
    // Custom-message wakes bypass prompt() in Pi 1.0.4. Track their public
    // completion as well: a failed host dispatch must not release a second wake
    // while the first dispatch still owns preparation/the run. Upgrade a retained
    // older observer in place on reload, without stacking either wrapper.
    const send = prototype.sendCustomMessage;
    prototype.sendCustomMessage = async function (...args: Parameters<AgentSession['sendCustomMessage']>) {
      const flight = observer.flights.get(this.sessionManager);
      if (!flight?.owner) return send.apply(this, args);
      flight.messages = (flight.messages ?? 0) + 1;
      try { return await send.apply(this, args); }
      finally { flight.messages = (flight.messages ?? 1) - 1; flight.owner?.flush(); }
    };
    observer.messagesObserved = true;
  }
  return observer;
}

export function lifecycleDelivery(pi: ExtensionAPI) {
  const observer = observePrompts();
  let current: { ctx: ExtensionContext; flight: Flight; owner: Owner; pending?: Pending;
    timer?: ReturnType<typeof setTimeout> } | undefined;
  const retry = () => {
    const state = current;
    if (!state?.pending || state.timer) return;
    state.timer = setTimeout(() => { state.timer = undefined; state.owner.flush(); },
      Math.max(100, state.pending.retryAt - Date.now()));
    state.timer.unref?.();
  };
  const dispose = () => {
    if (current) {
      clearTimeout(current.timer);
      if (current.flight.owner === current.owner) delete current.flight.owner;
    }
    current = undefined;
  };
  const start = (ctx: ExtensionContext) => {
    dispose();
    const flight = observer.flights.get(ctx.sessionManager) ?? { prompts: 0 };
    // Keep the obligation, not the retired owner's timer. Membership of the
    // any unconsumed appended notice tolerates later workflow saves or selection
    // before a newer notice, while excluding branches containing none of them.
    const pending = flight.pending && onBranch(ctx, flight.pending) ? flight.pending : undefined;
    flight.pending = pending;
    const owner: Owner = { waking: false, flush() {
      const state = current;
      if (!state || state.owner !== owner || !state.pending) return;
      if (ctx.sessionManager.getSessionId() !== state.pending.sessionId ||
          (state.pending.anchors.size > 0 && !onBranch(ctx, state.pending))) {
        state.pending = undefined; delete flight.pending;
        clearTimeout(state.timer); state.timer = undefined;
        return;
      }
      if (flight.prompts || flight.messages || flight.active || Date.now() < state.pending.retryAt) { retry(); return; }
      let idle: boolean;
      try { idle = ctx.isIdle(); } catch { dispose(); return; }
      if (!idle) {
        // A handled/failed preflight may finish while compaction is busy. Pi
        // emits neither agent_start nor agent_settled on that idle boundary,
        // and stable lifecycle polls are deduplicated. Keep the delivery
        // obligation alive independently of new input and observation changes.
        retry();
        return;
      }
      clearTimeout(state.timer); state.timer = undefined;
      // Dispatch is not consumption. Only agent_start clears this obligation;
      // handled/failed preparation retries without another user prompt or notice.
      state.pending.retryAt = Date.now() + Math.min(5000, 100 * 2 ** Math.min(state.pending.attempts++, 6));
      owner.waking = true;
      // The notice was already appended once. A failed/handled preflight never
      // consumed it; wake with a distinct hidden context message, not a duplicate
      // notice or synthetic user prompt. No success is inferred.
      retry();
      pi.sendMessage({ customType: 'pi-astraeus:claude-wake', display: false,
        content: 'Pending Claude lifecycle notice needs attention; no success inferred.' },
      { deliverAs: 'followUp', triggerTurn: true });
    } };
    flight.owner = owner;
    observer.flights.set(ctx.sessionManager, flight);
    current = { ctx, flight, owner, pending };
    retry();
  };
  return {
    start, dispose,
    agentStart() {
      if (current) {
        // Session-owned, like prompt reservations: preserve this across reload,
        // rather than mistaking non-streaming compaction for an active run.
        current.flight.active = true; current.pending = undefined;
        delete current.flight.pending;
        clearTimeout(current.timer); current.timer = undefined;
      }
    },
    settled() {
      if (current) {
        current.flight.active = false; current.owner.waking = false;
        current.owner.flush();
      }
    },
    notify(message: Parameters<ExtensionAPI['sendMessage']>[0]) {
      if (!current) return;
      const idle = current.ctx.isIdle();
      // Pi exposes the run signal before dispatching agent_start handlers in
      // order. An earlier awaited handler can therefore be streaming before
      // our own active flag is set; it must retain native followUp delivery.
      const active = current.flight.active || current.ctx.signal !== undefined;
      const preparing = current.flight.prompts > 0 || (current.flight.messages ?? 0) > 0 || (current.owner.waking && !active);
      const deferred = (preparing && idle) || (!idle && !active);
      if (deferred || idle) {
        current.pending ??= {sessionId:current.ctx.sessionManager.getSessionId(), anchors:new Set(), attempts:0, retryAt:0};
        current.flight.pending = current.pending;
      }
      if (!deferred && idle && current.pending) {
        current.owner.waking = true;
        current.pending.retryAt = Date.now() + 100; current.pending.attempts = 1;
      }
      // Non-triggering delivery appends context for the reserved user run, or
      // waits out non-streaming busy work (manual compaction). isIdle() false
      // alone does NOT imply sendMessage will queue: Pi starts a competing run
      // if triggerTurn is true while compaction, rather than a run, owns it.
      // Active runs retain Pi's native followUp queue; truly idle roots wake.
      if (current.pending) retry();
      pi.sendMessage(message, { deliverAs: 'followUp', triggerTurn: !deferred });
      if (current.pending) {
        // Non-triggering delivery appends synchronously in the pinned SDK. Use
        // the notices themselves, not the pre-send ancestor or exact current
        // leaf: later notices must not overwrite earlier unconsumed anchors.
        const leaf = current.ctx.sessionManager.getLeafEntry();
        if (leaf?.type === 'custom_message' && leaf.customType === message.customType && leaf.content === message.content) current.pending.anchors.add(leaf.id);
      }
    },
  };
}
