import { AtomRegistry } from "effect/reactivity";

/** The one atom registry for the TV app. The connection runtime and every view read through it. */
export const tvAtomRegistry = AtomRegistry.make();
