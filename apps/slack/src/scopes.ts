export const hasExactScopes = (
  actual: ReadonlyArray<string> | undefined,
  expected: ReadonlyArray<string>,
): boolean => {
  if (actual === undefined || actual.length !== expected.length) return false;
  const scopes = new Set(actual);
  return scopes.size === actual.length && expected.every((scope) => scopes.has(scope));
};
