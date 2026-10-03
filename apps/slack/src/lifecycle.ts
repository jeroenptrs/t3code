export interface SlackDaemonLifecycle {
  readonly start: () => Promise<void>;
  readonly requestReadiness: () => void;
  readonly shutdown: () => Promise<void>;
  readonly isShuttingDown: () => boolean;
}

export function makeSlackDaemonLifecycle(input: {
  readonly startSlack: () => Promise<void>;
  readonly stopSlack: () => Promise<void>;
  readonly startAppHome: () => void;
  readonly stopAppHome: () => Promise<void>;
  readonly refreshReadiness: () => Promise<void>;
  readonly closeTransport: () => Promise<void>;
  readonly closeHealth: () => Promise<void>;
  readonly onStartFailure: () => void;
  readonly readinessIntervalMs?: number;
  readonly reconnectDelayMs?: number;
}): SlackDaemonLifecycle {
  const readinessIntervalMs = input.readinessIntervalMs ?? 30_000;
  const reconnectDelayMs = input.reconnectDelayMs ?? 5_000;
  const activeReadiness = new Set<Promise<void>>();
  let startup: Promise<void> | null = null;
  let readinessTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  const invoke = (operation: () => Promise<void>): Promise<void> =>
    Promise.resolve().then(operation);

  const runReadiness = (): Promise<void> => {
    if (shuttingDown) return Promise.resolve();
    const active = invoke(input.refreshReadiness).finally(() => activeReadiness.delete(active));
    activeReadiness.add(active);
    return active;
  };

  const connect = async (): Promise<void> => {
    if (shuttingDown) return;
    try {
      await input.startSlack();
      if (shuttingDown) {
        await input.stopSlack().catch(() => undefined);
        return;
      }
      input.startAppHome();
      if (shuttingDown) return;
      await runReadiness();
      if (shuttingDown) return;
      readinessTimer ??= setInterval(() => void runReadiness(), readinessIntervalMs);
    } catch {
      if (shuttingDown) return;
      await input.stopSlack().catch(() => undefined);
      if (shuttingDown) return;
      input.onStartFailure();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startup = connect().finally(() => {
          startup = null;
        });
      }, reconnectDelayMs);
    }
  };

  const start = (): Promise<void> => {
    if (shuttingDown) return Promise.resolve();
    startup ??= connect().finally(() => {
      startup = null;
    });
    return startup;
  };

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      shuttingDown = true;
      if (readinessTimer !== null) clearInterval(readinessTimer);
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      readinessTimer = null;
      reconnectTimer = null;

      const pendingStartup = startup;
      const firstCleanup = Promise.allSettled([
        invoke(input.stopAppHome),
        invoke(input.stopSlack),
        invoke(input.closeTransport),
      ]);
      await Promise.allSettled([
        firstCleanup,
        ...(pendingStartup === null ? [] : [pendingStartup]),
        ...activeReadiness,
      ]);

      // A pending Slack start may have completed while the first cleanup was
      // running. Repeat idempotent teardown before closing the health socket.
      await Promise.allSettled([
        invoke(input.stopAppHome),
        invoke(input.stopSlack),
        invoke(input.closeTransport),
      ]);
      await invoke(input.closeHealth).catch(() => undefined);
    })();
    return shutdownPromise;
  };

  return {
    start,
    requestReadiness: () => {
      void runReadiness();
    },
    shutdown,
    isShuttingDown: () => shuttingDown,
  };
}
