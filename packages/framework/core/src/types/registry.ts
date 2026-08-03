export interface IRegistry<TDefinition extends { id: string }, TInstance> {
  register(definition: TDefinition, instance: TInstance): void
  unregister(id: string): void
  get(id: string): TInstance | undefined
  getDefinition(id: string): TDefinition | undefined
  list(): TDefinition[]
}
