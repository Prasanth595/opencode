import { contextSelection, isModelVariantAvailable } from "@opencode/util/model-variant"

type AgentModel = {
  providerID: string
  modelID: string
}

type Agent = {
  model?: AgentModel
  variant?: string
}

type Model = AgentModel & {
  variants?: Record<string, unknown>
}

type VariantInput = {
  variants: string[]
  selected: string | null | undefined
  configured: string | undefined
  preferred?: string
  context?: boolean
}

export function getConfiguredAgentVariant(input: { agent: Agent | undefined; model: Model | undefined }) {
  if (!input.agent?.variant) return undefined

  if (!input.agent.model) return undefined

  if (!input.model?.variants) return undefined

  if (input.agent.model.providerID !== input.model.providerID) return undefined

  if (input.agent.model.modelID !== input.model.modelID) return undefined

  return input.agent.variant
}

export function resolveModelVariant(input: VariantInput) {
  if (input.selected === null) return undefined
  const value = input.selected ?? input.preferred ?? input.configured

  return value && value !== "default" && isModelVariantAvailable(value, input.variants, input.context)
    ? value
    : undefined
}

export function cycleModelVariant(input: VariantInput) {
  const current = resolveModelVariant(input)

  if (input.context) {
    const selection = contextSelection(current, input.variants)
    const effort = selection.effort
    const next = input.variants[effort ? input.variants.indexOf(effort) + 1 : 0]

    return `${next ?? "default"}@${selection.tier}`
  }

  return input.variants[current ? input.variants.indexOf(current) + 1 : 0]
}
