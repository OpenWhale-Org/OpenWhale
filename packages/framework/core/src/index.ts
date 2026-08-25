// Types
export type {
  Credential,
  CredentialInfo,
  CredentialData,
  RawCredentialData,
  CredentialStore,
  ExecutionInstruction,
  ExecutionResult,
  ExecutionQueue,
  ExecutorOptions,
  RetryOptions,
  InstructionSchema,
  TriggerFilter,
  MonitorSource,
  CronCondition,
  MonitorCondition,
  TriggerCondition,
  Trigger,
  MonitorRecord,
  MonitorDataReader,
  EmitHandler,
  MonitorOptions,
  PlotPoint,
  PlotSeries,
  MonitorPlotDef,
  SinglePlotDef,
  MultiPlotDef,
  PlotCandle,
  PlotOption,
  MonitorPlotInfo,
  StrategyContext,
  StrategyMetrics,
  StrategyOptions,
  LlmOptions,
  LlmDeclaration,
  LlmSlotBinding,
  BuiltinProviderId,
  ProviderConfig,
  BuiltinProviderConfig,
  CustomProviderConfig,
  IStrategy,
  StrategyRunTrace,
  StrategyPortfolioSnapshot,
  AccountSlotMeta,
  ScriptDefinition,
  ScriptContext,
  ScriptResult,
  ScriptInfo,
  StrategyInstance,
  StrategyInstanceView,
  StrategyParams,
  PortfolioMode,
  PortfolioFillIntent,
  PortfolioPositionSnapshot,
  PortfolioSnapshot,
  PortfolioFillEvent,
  PortfolioDecisionEvent,
  PortfolioMarketBar,
  PortfolioUpdate,
  PortfolioReportQuery,
  PortfolioEquityPoint,
  PortfolioTrade,
  PortfolioReportSummary,
  PortfolioReport,
  IPortfolioJournal,
  AdapterKindMap,
  NamespacedKind,
  KnownKind,
  SessionOf,
  ReaderOf,
  ReaderClass,
  CredentialTypeDefinition,
  CredentialTypeInfo,
  AdapterRegistration,
  AdapterResolver,
  AccountEntity,
  AccountImplementation,
  AccountImplementationInfo,
  AccountView,
  AccountStore,
  AccountSnapshotSample,
  AccountSnapshotRecord,
  AccountSnapshotStore,
  MonitorImplementation,
  MonitorContext,
  MonitorInstanceEntity,
  MonitorInstanceView,
  MonitorInstanceStore,
  PublicSessionRegistration,
  PublicSessionAccessor,
  ISession,
  AccountSlot,
  ExecutorCredentialSlot,
  RuntimeOptions,
  IRuntime,
  LoadedPluginInfo,
  PluginDependents,
  PluginReplaceResult,
  MonitorDefinition,
  ExecutorDefinition,
  StrategyDefinition,
  ParamFieldDef,
  ParamFieldType,
  ParamFieldOption,
  ParamFieldMeta,
  ParamIllustration,
  ParamAvailability,
  AvailabilityVerdict,
  AvailabilityChecker,
  ParamFieldCatalogue,
  ParamFieldSlider,
  ListColumnDef,
  ListParamDef,
  IRegistry,
} from './types/index.js'
export { PluginAlreadyLoadedError } from './types/index.js'

// Adapter error taxonomy (value exports)
export { AdapterError, RetryableAdapterError, TerminalAdapterError, isTerminalError } from './types/adapter/errors.js'

// Credentials
export { DBCredentialStore } from './credentials/DBCredentialStore.js'

// Monitor
export { BaseMonitor, MonitorMode } from './monitor/BaseMonitor.js'
export { PnlService } from './pnl/PnlService.js'
export type { OrderClaim, PnlSummary, PnlSeriesPoint, PnlFillRow, PnlPositionRow, PnlSessionLike } from './pnl/PnlService.js'
export { MonitorDataReaderImpl } from './monitor/MonitorDataReader.js'
export { MonitorInstanceManager, ContractMonitor } from './monitor/MonitorInstanceManager.js'
export { DBMonitorInstanceStore, MemoryMonitorInstanceStore } from './monitor/MonitorInstanceStore.js'
export { DBAccountStore, MemoryAccountStore } from './account/AccountStore.js'
export { DBAccountSnapshotStore, MemoryAccountSnapshotStore } from './account/AccountSnapshotStore.js'
export { aggregateAccountEquity } from './account/aggregateAccountEquity.js'
export type { CombinedAccountEquityPoint, CombinedAccountEquitySeries } from './account/aggregateAccountEquity.js'

// Executor
export { BaseExecutor, ExecutionTimeoutError } from './executor/BaseExecutor.js'
export type { MaterializedSlot } from './executor/BaseExecutor.js'
export { MemoryExecutionQueue } from './executor/MemoryExecutionQueue.js'
export { RedisExecutionQueue } from './executor/RedisExecutionQueue.js'
export type { RedisConfig } from './executor/RedisExecutionQueue.js'

// Trigger
export { TriggerManager } from './trigger/TriggerManager.js'
export type { StrategyRunEvent } from './trigger/TriggerManager.js'

// Strategy
export { BaseStrategy } from './strategy/BaseStrategy.js'
export type { DeclarationLabel, StrategyDeclarations } from './strategy/BaseStrategy.js'
export { Strategy, Monitor, Executor, Account, Llm, Kind, VenueType } from './strategy/decorators.js'
export type { DecoratedDeclarations } from './strategy/decorators.js'
export { importLlmKeysFromEnv, BUILTIN_CREDENTIAL_NAMES } from './strategy/llm.js'
export type { CoreMessage, LlmCallOptions, LlmToolCallOptions, LlmCallSettings } from './strategy/llm.js'
export { LlmClient } from './strategy/llm.js'
export type { IStrategyStore } from './strategy/StrategyStore.js'
export { DBStrategyStore } from './strategy/StrategyStore.js'
export { PortfolioJournal } from './strategy/PortfolioJournal.js'
export { HttpClient, HttpError } from './strategy/HttpClient.js'
export type { HttpRequestOptions, HttpResponse } from './strategy/HttpClient.js'

// Instance
export { StrategyInstanceStore } from './bundle/StrategyInstanceStore.js'
export { DBStrategyInstanceStore } from './bundle/DBStrategyInstanceStore.js'

// Database
export type { DatabaseAdapter, Row } from './database/DatabaseAdapter.js'
export { SQLiteAdapter } from './database/SQLiteAdapter.js'
export type { SQLiteAdapterOptions } from './database/SQLiteAdapter.js'

// Plugin
export { PluginManager } from './plugin/PluginManager.js'
export type { OpenWhalePlugin, PluginContext, PluginFactory, PluginManagerOptions } from './plugin/PluginManager.js'
export { definePlugin } from './plugin/definePlugin.js'
export type { PluginManifest } from './plugin/definePlugin.js'
export { OwMonitor, OwAccount, OwExecutor, OwStrategy } from './plugin/componentDecorators.js'
export type { OwMonitorMeta, OwAccountMeta, OwExecutorMeta, OwStrategyMeta, MonitorClass, AccountClass } from './plugin/componentDecorators.js'

// Compiled
export { CompiledLoader } from './compiled/CompiledLoader.js'
export type { CompiledType, CompiledLoaderOptions } from './compiled/CompiledLoader.js'

// Registry
export {
  Registry,
  createMonitorRegistry,
  createExecutorRegistry,
  createStrategyRegistry,
} from './registry/Registry.js'
export type { MonitorRegistry, ExecutorRegistry, StrategyRegistry } from './registry/Registry.js'

// Runtime
export { OpenWhaleRuntime } from './runtime/OpenWhaleRuntime.js'

// Utils
export { generateId } from './utils/id.js'
export { getLogger, setLogger, createLogger, subscribeLogs, recentLogs } from './utils/logger.js'
export type { Logger, LogLevel, LogRecord } from './utils/logger.js'
export {
  getDataDir,
  getMonitorPath,
  encodeMonitorKey,
  decodeMonitorKey,
  getExecutionPath,
  getCredentialPath,
  getRegistryPath,
  getCompiledSourcePath,
  getCompiledOutputPath,
  getInstancePath,
} from './utils/paths.js'
export { appendJsonl, readJsonlLines, writeJsonlLines, streamJsonlLines } from './utils/jsonl.js'
