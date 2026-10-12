import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

export function DialogContext() {
  const local = useLocal()
  const dialog = useDialog()
  const options = createMemo(() =>
    (["default", "long"] as const).map((tier) => ({
      value: tier,
      title: tier === "long" ? "Long" : "Default",
      description: `${local.model.context.budgets()?.[tier].toLocaleString()} input tokens`,
      onSelect() {
        local.model.context.set(tier)
        dialog.clear()
      },
    })),
  )
  return <DialogSelect options={options()} title="Select context window" current={local.model.context.current()} flat />
}
