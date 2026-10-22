import * as DateTime from "effect/DateTime";

/** A UTC ISO string from epoch milliseconds or any date string `DateTime` parses. */
export const isoOf = (input: number | string): string =>
  DateTime.formatIso(DateTime.makeUnsafe(input));
