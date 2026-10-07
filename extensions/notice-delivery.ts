import { AgentSession, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

type Owner = { waking: boolean; flush(): void };
type Flight = { prompts: number; owner?: Owner };
type Observer = { flights: WeakMap<object, Flight> };
const observerKey = Symbol.for('pi-astraeus:prompt-flight-observer');

// Pi 1.0.4 has no preflight-complete event: isIdle() is true while prompt()
// awaits input/auth/before_agent_start/images. Observe the exported SDK method,
// not agent.prompt or private fields, so handled inputs and failures also exit
// the reservation. One observer survives extension reload; unregistered sessions
// pass through unchanged. This is runtime adaptation, not an upstream file edit.
function observePrompts(): Observer {
  const prototype = AgentSession.prototype as AgentSession & { [observerKey]?: Observer };
  if (prototype[observerKey]) return prototype[observerKey];
  const observer: Observer = { flights: new WeakMap() };
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
  return observer;
}

export function lifecycleDelivery(pi: ExtensionAPI) {
  const observer = observePrompts();
  let current: { ctx: ExtensionContext; flight: Flight; owner: Owner; pending: boolean } | undefined;
  const dispose = () => {
    if (current && current.flight.owner === current.owner) delete current.flight.owner;
    current = undefined;
  };
  const start = (ctx: ExtensionContext) => {
    dispose();
    const flight = observer.flights.get(ctx.sessionManager) ?? { prompts: 0 };
    const owner: Owner = { waking: false, flush() {
      if (!current || current.owner !== owner || !current.pending || !ctx.isIdle()) return;
      current.pending = false;
      owner.waking = true;
      // The notice was already appended once. A failed/handled preflight never
      // consumed it; wake with a distinct hidden context message, not a duplicate
      // notice or synthetic user prompt. No success is inferred.
      pi.sendMessage({ customType: 'pi-astraeus:claude-wake', display: false,
        content: 'Pending Claude lifecycle notice needs attention; no success inferred.' },
      { deliverAs: 'followUp', triggerTurn: true });
    } };
    flight.owner = owner;
    observer.flights.set(ctx.sessionManager, flight);
    current = { ctx, flight, owner, pending: false };
  };
  return {
    start, dispose,
    agentStart() { if (current) current.pending = false; },
    settled() { if (current) current.owner.waking = false; },
    notify(message: Parameters<ExtensionAPI['sendMessage']>[0]) {
      if (!current) return;
      const preparing = current.flight.prompts > 0 && current.ctx.isIdle();
      if (preparing) current.pending = true;
      else if (current.ctx.isIdle()) current.owner.waking = true;
      // Non-triggering idle delivery appends model context synchronously. The
      // upcoming user run includes it, including notices during any await gap.
      // Streaming retains Pi's native followUp queue and truly idle roots wake.
      pi.sendMessage(message, { deliverAs: 'followUp', triggerTurn: !preparing });
    },
  };
}
