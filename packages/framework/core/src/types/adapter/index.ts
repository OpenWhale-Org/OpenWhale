/**
 * Generic adapter-layer types. Venue/domain-specific adapter interfaces
 * (exchange, DEX, …) live in domain packages such as @openwhaleorg/exchange —
 * core only defines the error taxonomy their implementations translate into.
 */
export { AdapterError, RetryableAdapterError, TerminalAdapterError, isTerminalError, heldUntil } from './errors.js'
