/**
 * Core's definition types as the gateway serves them: every Text resolved
 * to a string for the reader's locale. Pages import these, never the raw
 * shapes — a page has no locale to resolve with, and should never see a
 * table where a label belongs.
 */
import type {
  Localized,
  StrategyDefinition as RawStrategyDefinition,
  MonitorDefinition as RawMonitorDefinition,
  ExecutorDefinition as RawExecutorDefinition,
  ParamFieldDef as RawParamFieldDef,
  ParamFieldOption as RawParamFieldOption,
  ParamIllustration as RawParamIllustration,
  ParamPreset as RawParamPreset,
  PresetSource as RawPresetSource,
  PickerOption as RawPickerOption,
  ScriptInfo as RawScriptInfo,
  AccountImplementationInfo as RawAccountImplementationInfo,
  AccountActionInfo as RawAccountActionInfo,
  LoadedPluginInfo as RawLoadedPluginInfo,
  MonitorInstanceView as RawMonitorInstanceView,
  CredentialTypeInfo as RawCredentialTypeInfo,
  PresetCard as RawPresetCard,
} from '@openwhaleorg/core'

export type StrategyDefinition = Localized<RawStrategyDefinition>
export type MonitorDefinition = Localized<RawMonitorDefinition>
export type ExecutorDefinition = Localized<RawExecutorDefinition>
export type ParamFieldDef = Localized<RawParamFieldDef>
export type ParamFieldOption = Localized<RawParamFieldOption>
export type ParamIllustration = Localized<RawParamIllustration>
export type ParamPreset = Localized<RawParamPreset>
export type PresetSource = Localized<RawPresetSource>
export type PickerOption = Localized<RawPickerOption>
export type ScriptInfo = Localized<RawScriptInfo>
export type AccountImplementationInfo = Localized<RawAccountImplementationInfo>
export type AccountActionInfo = Localized<RawAccountActionInfo>
export type LoadedPluginInfo = Localized<RawLoadedPluginInfo>
export type MonitorInstanceView = Localized<RawMonitorInstanceView>
export type CredentialTypeInfo = Localized<RawCredentialTypeInfo>
export type PresetCard = Localized<RawPresetCard>
