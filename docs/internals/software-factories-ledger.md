# Software factories ledger

This ledger pins each upstream PR the factory work builds on, as the
[experimental dependencies](software-factories.md#experimental-dependencies)
rule requires. Factory code reaches these PRs only through the adapter modules
in `apps/server/src/factories/upstream/`, and `index.ts` there is the only
import point.

| Upstream PR                                              | Head SHA when pulled                       | Commit on this branch                  | What the factory work builds on it                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#30323](https://github.com/pingdotgg/t3code/pull/30323) | `c1072b464c88dda704818de678ab3ebc30ed09a6` | `cee1d30df9`                           | The Foreman starts each work item in a fresh provider session.                                                                                                             |
| [#30325](https://github.com/pingdotgg/t3code/pull/30325) | `5a80b426ae88d781313c99a12598f67730864108` | `49cfa24f20`, inside the #30326 commit | Server slice only: the optional `freshContext` field on `ThreadManagementSendInput` and its passthrough to `message.dispatch`, so a send through the service can be fresh. |
| [#30326](https://github.com/pingdotgg/t3code/pull/30326) | `9662b37cb7580e4a99611a325313c33f9c36b1b6` | `49cfa24f20`                           | The Foreman's long-lived thread, with a fresh session on each scheduled run.                                                                                               |
| [#15975](https://github.com/pingdotgg/t3code/pull/15975) | `b5d05a6ebf3c0b99a097f2a197983cb1203669c6` | `29eb5cfead`                           | The thread-management toolkit and the watch reports that wake the Foreman.                                                                                                 |
| [#21877](https://github.com/pingdotgg/t3code/pull/21877) | `76beabe5749c02771cc630b60324ed9de4bc4edb` | `0cb4bd1578`                           | Delegated follow-ups report done only after nested work finishes, which the Foreman's revision loop relies on. No adapter, because it changes behavior, not an API.        |

## Not pulled

| Upstream PR                                              | Why                                                                                                                                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#31129](https://github.com/pingdotgg/t3code/pull/31129) | Open on 2026-11-05 when M4 shipped, so triggers have no delivery mode. Pull it behind an adapter in `apps/server/src/factories/upstream/` and add queue, steer, and restart per trigger. |

## Fork fixes waiting on upstream

These fork commits fix upstream issues that no pulled PR covers yet.

| Upstream issue                                             | Commit on this branch      | When upstream fixes it                                                                               |
| ---------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| [#16565](https://github.com/pingdotgg/t3code/issues/16565) | `67dfbce550`               | Drop the fork commit's source change and keep its test in `ProviderSessionManager.test.ts`.          |
| [#23006](https://github.com/pingdotgg/t3code/issues/23006) | `900ff1d8ba`, `9cf4629776` | Drop both fork commits' source changes and keep their tests and the reproductions from `0420d6e12b`. |
