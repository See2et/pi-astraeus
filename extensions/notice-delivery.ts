import {
  AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type Message = Parameters<ExtensionAPI["sendMessage"]>[0];
type SendOptions = Parameters<AgentSession["sendCustomMessage"]>[1];
type Owner = {
  waking: boolean;
  flush(): void;
  compact?(session: AgentSession): (success: boolean) => void;
  stop?(): void;
  native?(message: Message, options: SendOptions): SendOptions;
  appended?(message: Message): void;
};
type Pending = {
  sessionId: string;
  anchors: Set<string>;
  attempts: number;
  retryAt: number;
  notices?: Message[];
};
type Flight = {
  prompts: number;
  messages?: number;
  active?: boolean;
  pending?: Pending;
  owner?: Owner;
  compacting?: number;
  compactAbort?: boolean;
  stopped?: boolean;
};
const onBranch = (ctx: ExtensionContext, pending: Pending) =>
  ctx.sessionManager.getSessionId() === pending.sessionId &&
  ctx.sessionManager.getBranch().some((entry) => pending.anchors.has(entry.id));
type Observer = {
  flights: WeakMap<object, Flight>;
  messagesObserved?: boolean;
  compactObserved?: boolean;
};
const observerKey = Symbol.for("pi-astraeus:prompt-flight-observer");

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
    prototype.prompt = async function (...args: Parameters<AgentSession["prompt"]>) {
      const flight = observer.flights.get(this.sessionManager);
      if (!flight?.owner) return prompt.apply(this, args);
      flight.prompts++;
      try {
        // An idle notification already acquired the agent before this user arrived.
        // Wait once, before submission; do not catch/retry a rejected user prompt or
        // change explicit steer/followUp behavior or ordinary streaming errors.
        const [text, options] = args;
        const command =
          (options?.expandPromptTemplates ?? true) &&
          text.startsWith("/") &&
          this.extensionRunner.getCommand(text.slice(1).split(" ")[0]);
        if (flight.owner.waking && this.isStreaming && !options?.streamingBehavior && !command)
          await this.waitForIdle();
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
    prototype.sendCustomMessage = async function (
      ...args: Parameters<AgentSession["sendCustomMessage"]>
    ) {
      const flight = observer.flights.get(this.sessionManager);
      if (!flight?.owner) return send.apply(this, args);
      flight.messages = (flight.messages ?? 0) + 1;
      try {
        return await send.apply(this, args);
      } finally {
        flight.messages = (flight.messages ?? 1) - 1;
        flight.owner?.flush();
      }
    };
    observer.messagesObserved = true;
  }
  if (!observer.compactObserved) {
    // Upgrade the retained public-method observer in place. The reservation must
    // precede compact's initial abort, not the later session_before_compact hook.
    const compact = prototype.compact;
    const abort = prototype.abort;
    const send = prototype.sendCustomMessage;
    prototype.compact = async function (...args: Parameters<AgentSession["compact"]>) {
      const flight = observer.flights.get(this.sessionManager);
      if (!flight?.owner) return compact.apply(this, args);
      flight.compacting = (flight.compacting ?? 0) + 1;
      const finish = flight.owner.compact?.(this);
      let success = false;
      try {
        flight.compactAbort = true;
        let operation: ReturnType<AgentSession["compact"]>;
        try {
          operation = compact.apply(this, args);
        } finally {
          flight.compactAbort = false;
        }
        const result = await operation;
        success = true;
        return result;
      } finally {
        flight.compacting--;
        finish?.(success);
        flight.owner?.flush();
      }
    };
    prototype.abort = function (...args: Parameters<AgentSession["abort"]>) {
      const flight = observer.flights.get(this.sessionManager);
      const internal = flight?.compactAbort;
      if (flight) flight.compactAbort = false;
      if (!internal) flight?.owner?.stop?.();
      return abort.apply(this, args);
    };
    prototype.sendCustomMessage = async function (message, options) {
      const owner = observer.flights.get(this.sessionManager)?.owner;
      const adapted = owner?.native?.(message, options);
      const result = send.call(this, message, adapted ?? options);
      if (adapted) owner?.appended?.(message);
      return result;
    };
    observer.compactObserved = true;
  }
  return observer;
}

export function lifecycleDelivery(
  pi: ExtensionAPI,
  managed: {
    unfinished(ctx: ExtensionContext): boolean;
    notification(message: Message, ctx: ExtensionContext): boolean;
  },
) {
  const observer = observePrompts();
  let current:
    | {
        ctx: ExtensionContext;
        flight: Flight;
        owner: Owner;
        pending?: Pending;
        interruption?: Pending;
        continuation?: Pending;
        timer?: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const retry = () => {
    const state = current;
    const obligation = state?.pending ?? state?.continuation;
    if (!state || !obligation || state.timer) return;
    state.timer = setTimeout(
      () => {
        state.timer = undefined;
        state.owner.flush();
      },
      Math.max(100, obligation.retryAt - Date.now()),
    );
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
    const owner: Owner = {
      waking: false,
      compact(session) {
        const state = current;
        const anchor = ctx.sessionManager.getLeafId();
        if (
          !state ||
          flight.stopped ||
          !(flight.active || session.isStreaming) ||
          !managed.unfinished(ctx) ||
          !anchor
        )
          return () => {};
        const interruption: Pending = {
          sessionId: ctx.sessionManager.getSessionId(),
          anchors: new Set([anchor]),
          attempts: 0,
          retryAt: 0,
        };
        state.interruption = interruption;
        return (success) => {
          if (current !== state || state.interruption !== interruption) return;
          state.interruption = undefined;
          if (success && managed.unfinished(ctx) && onBranch(ctx, interruption))
            state.continuation = interruption;
        };
      },
      stop() {
        if (current?.owner !== owner) return;
        current.interruption = undefined;
        current.continuation = undefined;
        // Explicit stop cancels existing autonomous attention, including the
        // session-owned reload obligation, without deleting notices/history or
        // suppressing a genuinely later transition. Compact's own abort skips stop.
        current.pending = undefined;
        delete flight.pending;
        clearTimeout(current.timer);
        current.timer = undefined;
        flight.stopped = true;
      },
      native(message, options) {
        if (
          options?.triggerTurn &&
          options.deliverAs === "followUp" &&
          managed.notification(message, ctx)
        )
          return prepare(message);
        return undefined;
      },
      appended: anchorNotice,
      flush() {
        const state = current;
        if (!state || state.owner !== owner) return;
        if (
          state.pending &&
          (state.pending.sessionId !== ctx.sessionManager.getSessionId() ||
            (state.pending.anchors.size > 0 && !onBranch(ctx, state.pending)))
        ) {
          state.pending = undefined;
          delete flight.pending;
        }
        if (state.continuation && (!onBranch(ctx, state.continuation) || !managed.unfinished(ctx)))
          state.continuation = undefined;
        const obligation = state.pending ?? state.continuation;
        if (!obligation) return;
        if (
          flight.compacting ||
          flight.prompts ||
          flight.messages ||
          flight.active ||
          Date.now() < obligation.retryAt
        ) {
          retry();
          return;
        }
        let idle: boolean;
        try {
          idle = ctx.isIdle();
        } catch {
          dispose();
          return;
        }
        if (!idle) {
          // A handled/failed preflight may finish while compaction is busy. Pi
          // emits neither agent_start nor agent_settled on that idle boundary,
          // and stable lifecycle polls are deduplicated. Keep the delivery
          // obligation alive independently of new input and observation changes.
          retry();
          return;
        }
        clearTimeout(state.timer);
        state.timer = undefined;
        // Dispatch is not consumption. A new agent_start can consume the wake;
        // queued notices are also consumed when they enter an active context.
        // Handled/failed preparation retries without another user prompt or notice.
        obligation.retryAt =
          Date.now() + Math.min(5000, 100 * 2 ** Math.min(obligation.attempts++, 6));
        owner.waking = true;
        // Leave queued/appended attention intact and wake with a hidden context
        // message, never a duplicate notice or synthetic user prompt. A successful
        // manual interruption adds only a parent continuation, not child actions.
        retry();
        pi.sendMessage(
          {
            customType: "pi-astraeus:claude-wake",
            display: false,
            content: state.pending
              ? "Pending managed lifecycle/completion notice needs attention; no success inferred."
              : "Manual compaction interrupted unfinished Astraeus work. Continue the parent work; do not infer child success or automatically collect, accept, or relaunch children.",
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      },
    };
    flight.owner = owner;
    observer.flights.set(ctx.sessionManager, flight);
    current = { ctx, flight, owner, pending };
    retry();
  };
  // Track attention before dispatch, including native followUp messages that Pi
  // has queued but not appended. Dispatch and turn_start are not consumption:
  // only an actual model context containing those messages consumes that queue.
  const prepare = (message: Message): SendOptions => {
    const state = current!;
    const idle = state.ctx.isIdle();
    const running = state.flight.active || state.ctx.signal !== undefined;
    const active = !state.flight.compacting && running;
    const preparing =
      state.flight.prompts > 0 ||
      (state.flight.messages ?? 0) > 0 ||
      (state.owner.waking && !active);
    const deferred = !!state.flight.compacting || (preparing && idle) || (!idle && !active);
    state.pending ??= {
      sessionId: state.ctx.sessionManager.getSessionId(),
      anchors: new Set(),
      attempts: 0,
      retryAt: 0,
    };
    state.pending.notices ??= [];
    state.pending.notices.push(message);
    state.flight.pending = state.pending;
    // An active followUp has no entry yet. Bind it to its originating branch
    // until the persisted notice itself can supply the anchor.
    if (running) {
      const leaf = state.ctx.sessionManager.getLeafId();
      if (leaf) state.pending.anchors.add(leaf);
    }
    if (!deferred && idle) {
      state.owner.waking = true;
      state.pending.retryAt = Date.now() + 100;
      state.pending.attempts = 1;
    }
    retry();
    return { deliverAs: "followUp", triggerTurn: !deferred };
  };
  function anchorNotice(message: Message) {
    const leaf = current?.ctx.sessionManager.getLeafEntry();
    if (
      leaf?.type === "custom_message" &&
      leaf.customType === message.customType &&
      leaf.content === message.content
    )
      current?.pending?.anchors.add(leaf.id);
  }
  return {
    start,
    dispose,
    agentStart() {
      if (current) {
        // Session-owned, like prompt reservations: preserve this across reload,
        // rather than mistaking non-streaming compaction for an active run.
        current.flight.active = true;
        if (current.flight.compacting) return;
        current.flight.stopped = false;
        current.pending = undefined;
        current.interruption = undefined;
        current.continuation = undefined;
        delete current.flight.pending;
        clearTimeout(current.timer);
        current.timer = undefined;
      }
    },
    settled() {
      if (current) {
        current.flight.active = false;
        current.owner.waking = false;
        current.owner.flush();
      }
    },
    context(messages: { role: string; customType?: string; content?: unknown }[]) {
      const pending = current?.pending;
      if (!pending?.notices?.length) return;
      pending.notices = pending.notices.filter(
        (notice) =>
          !messages.some(
            (message) =>
              message.role === "custom" &&
              message.customType === notice.customType &&
              JSON.stringify(message.content) === JSON.stringify(notice.content),
          ),
      );
      if (!pending.notices.length) {
        current!.pending = undefined;
        delete current!.flight.pending;
      }
    },
    notify(message: Message) {
      if (!current) return;
      pi.sendMessage(message, prepare(message));
      anchorNotice(message);
    },
  };
}
