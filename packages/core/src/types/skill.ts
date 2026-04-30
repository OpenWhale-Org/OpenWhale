export interface SkillParameter {
  name: string
  type: 'string' | 'number' | 'boolean' | 'object'
  description: string
  required: boolean
}

export interface SkillDefinition {
  name: string
  description: string
  parameters: SkillParameter[]
  returns: string
}

export interface SkillModule {
  readonly skills: SkillDefinition[]
  execute(skillName: string, params: Record<string, unknown>): Promise<unknown>
}
