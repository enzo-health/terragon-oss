# Assistant-UI React AG-UI Patch Inventory

Source patch: `patches/@assistant-ui__react-ag-ui@0.0.26.patch`

Current npm latest checked during execution: `@assistant-ui/react-ag-ui@0.0.31`.

## Classification

| Patch area                                                                                     | Classification                                 | Reason                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `historyLoadKey`, `_loadKey`, `loadGeneration`, stale-load guards                              | Upstream                                       | Generic async history loading correctness. The runtime should ignore stale history loads and allow callers to force reloads without app-specific code.                                                     |
| `waitForInitialLoad()` before append/reload/resume/startRun                                    | Upstream                                       | Generic runtime ordering guarantee. Appends and resumes should not race initial history hydration.                                                                                                         |
| `externalMessagesStrategy: "merge-after-local-mutations"`                                      | Keep temporarily                               | Generic reconciliation shape, but the current need is driven by Terragon optimistic append plus durable replay. Revisit after transcript/submission ownership is simplified.                               |
| `hasLocalRuntimeMutations`, `mergeExternalMessages`, `dedupeMessages`, assistant merge scoring | Keep temporarily                               | Reconciliation behavior prevents local optimistic messages from being replaced by replay/hydration. It may move into app projection later, but removing it now risks duplicate or missing transcript rows. |
| `startRun(..., intent)` and `withRunIntent()` injecting `custom.terragon.intent`               | Delete                                         | Terragon product/protocol metadata should be encoded by repo-owned run metadata modules, not package internals.                                                                                            |
| Resume calls passing `intent: "resume"`                                                        | Delete after app-owned resume policy covers it | Resume intent is Terragon replay/append classification. The package should not know the product's `terragon.intent` shape.                                                                                 |
| Target assistant message support from AG-UI `messageId` / `parentMessageId`                    | Upstream                                       | Raw AG-UI events carry target identity. The runtime aggregator should update the intended assistant message instead of always creating a placeholder.                                                      |
| Synthetic assistant creation and `removeEmptySyntheticAssistant()`                             | Upstream                                       | Generic cleanup required by target-message routing to avoid empty placeholder messages.                                                                                                                    |
| Tool-call parent resolution and target emission                                                | Upstream                                       | Generic AG-UI event fidelity. Tool args/results should update the assistant message implied by event identity.                                                                                             |
| `UseAgUiRuntimeOptions.historyLoadKey`                                                         | Upstream                                       | Public runtime option for forcing history reloads.                                                                                                                                                         |
| `UseAgUiRuntimeOptions.externalMessagesStrategy`                                               | Keep temporarily                               | Potential upstream option, but the exact strategy name may be too app-shaped. Revisit after local projection ownership is decided.                                                                         |

## Execution Notes

- No hunk should remain because it mentions Terragon product semantics.
- The first deletion target is package-level injection of `custom.terragon.intent`.
- The most likely long-lived hunks are generic runtime mechanics: history load keys, load ordering, target message routing, and synthetic assistant cleanup.
- Before upgrading from `0.0.26` to `0.0.31`, compare upstream source for the generic hunks rather than assuming the patch still applies cleanly.
