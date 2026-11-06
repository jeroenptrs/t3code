# Software factories ledger

This ledger pins each upstream PR the factory work builds on, as the
[experimental dependencies](software-factories.md#experimental-dependencies)
rule requires. Factory code reaches these PRs only through the adapter modules
in `apps/server/src/factories/upstream/`, and `index.ts` there is the only
import point.

Check it before every upstream sync: query each listed PR and issue, graduate
what merged (drop the cherry-pick, keep the adapter, move the row below), and
re-hash the branch commits afterwards, since a rebuild changes every SHA.

| Upstream PR                                              | Head SHA when pulled                       | Commit on this branch | What the factory work builds on it                                         |
| -------------------------------------------------------- | ------------------------------------------ | --------------------- | -------------------------------------------------------------------------- |
| [#15975](https://github.com/pingdotgg/t3code/pull/15975) | `b5d05a6ebf3c0b99a097f2a197983cb1203669c6` | `e9e13598ff`          | The thread-management toolkit and the watch reports that wake the Foreman. |

Commits on this branch are re-hashed whenever `jeroen/dev` is rebuilt on a
newer upstream base, so find them by subject when a SHA here is gone.

## Graduated

Merged into upstream `main` and carried here through the fork's rebase, not as
a pinned cherry-pick. The adapter modules stay as the single import point.

| Upstream PR                                                                                                                                                                                   | Merged     | Merge commit               | Adapter                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------- | -------------------------- |
| [#30323](https://github.com/pingdotgg/t3code/pull/30323)                                                                                                                                      | 2026-11-05 | `e139768a7e`               | `freshContext.ts`          |
| [#30325](https://github.com/pingdotgg/t3code/pull/30325)                                                                                                                                      | 2026-11-05 | `99e361e415`               | inside `freshContext.ts`   |
| [#30326](https://github.com/pingdotgg/t3code/pull/30326)                                                                                                                                      | 2026-11-05 | `4aab23cd72`               | `scheduledThreadMode.ts`   |
| [#21877](https://github.com/pingdotgg/t3code/pull/21877), superseded by [#34958](https://github.com/pingdotgg/t3code/pull/34958) and [#36411](https://github.com/pingdotgg/t3code/pull/36411) | 2026-11-13 | `daed1dd327`, `aaa3dbabb1` | none: behavior, not an API |

## Not pulled

| Upstream PR                                              | Why                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#31129](https://github.com/pingdotgg/t3code/pull/31129) | Open on 2026-11-05 when M4 shipped, so triggers have no delivery mode. Pull it behind an adapter in `apps/server/src/factories/upstream/` and add queue, steer, and restart per trigger.                                  |
| [#15350](https://github.com/pingdotgg/t3code/pull/15350) | Open on 2026-11-06, by t3dotgg: threads run in Docker sandboxes with their own ports and services. Pull it behind an adapter in `apps/server/src/factories/upstream/` and add `isolation: sandbox` as a per-role binding. |

## Fork fixes waiting on upstream

These fork commits fix upstream issues that no pulled PR covers yet.

| Upstream issue                                                                                                                                                              | Commit on this branch      | When upstream fixes it                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| [#16565](https://github.com/pingdotgg/t3code/issues/16565), closed as a duplicate of merged [#23198](https://github.com/pingdotgg/t3code/pull/23198), which does not fix it | `e7a7bee7c0`               | Drop the fork commit's source change and keep its test in `ProviderSessionManager.test.ts`.          |
| [#23006](https://github.com/pingdotgg/t3code/issues/23006), now tracked by [#33272](https://github.com/pingdotgg/t3code/issues/33272)                                       | `433e77785e`, `903e4086fc` | Drop both fork commits' source changes and keep their tests and the reproductions from `50acaee242`. |
