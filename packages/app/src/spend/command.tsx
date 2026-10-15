import { useNavigate } from "@solidjs/router"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"

export function useSpendCommand() {
  const command = useCommand()

  const language = useLanguage()

  const navigate = useNavigate()

  command.register("spend", () => [
    {
      id: "spend.open",
      title: language.t("command.spend.open"),
      category: language.t("command.category.view"),
      onSelect: () => navigate("/spend"),
    },
  ])
}
