export interface ReadinessCoordinator {
  readonly setConnected: (connected: boolean, reason?: string) => void;
  readonly run: () => Promise<void>;
}

export function makeReadinessCoordinator<Result>(input: {
  readonly check: () => Promise<Result>;
  readonly isShuttingDown: () => boolean;
  readonly onReady: (result: Result) => void;
  readonly onFailure: (error: unknown) => void;
  readonly onUnavailable: (reason: string) => void;
}): ReadinessCoordinator {
  let connected = false;
  let unavailableReason = "Slack Socket Mode is disconnected";
  let connectionGeneration = 0;
  let latestAttempt = 0;

  const setConnected = (next: boolean, reason = "Slack Socket Mode is disconnected"): void => {
    connected = next;
    if (!next) unavailableReason = reason;
    connectionGeneration += 1;
    latestAttempt += 1;
    if (!next && !input.isShuttingDown()) input.onUnavailable(reason);
  };

  const run = async (): Promise<void> => {
    if (input.isShuttingDown()) return;
    const generation = connectionGeneration;
    const attempt = ++latestAttempt;
    if (!connected) {
      input.onUnavailable(unavailableReason);
      return;
    }
    try {
      const result = await input.check();
      if (
        input.isShuttingDown() ||
        !connected ||
        generation !== connectionGeneration ||
        attempt !== latestAttempt
      ) {
        return;
      }
      input.onReady(result);
    } catch (error) {
      if (
        input.isShuttingDown() ||
        !connected ||
        generation !== connectionGeneration ||
        attempt !== latestAttempt
      ) {
        return;
      }
      input.onFailure(error);
    }
  };

  return { setConnected, run };
}
