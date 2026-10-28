/**
 * Dev-only: EXPO_PUBLIC_TV_DEV_TERMINAL_INPUT=<command> runs that command once in the first
 * terminal opened this launch, for a simulator nothing presses remote buttons on.
 */
let devInputUsed = false;

export function takeDevTerminalInput(): string | undefined {
  const command = __DEV__ ? process.env.EXPO_PUBLIC_TV_DEV_TERMINAL_INPUT : undefined;
  if (devInputUsed || !command) return undefined;
  devInputUsed = true;
  return `${command}\r`;
}
