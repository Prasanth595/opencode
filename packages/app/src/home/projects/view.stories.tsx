import { useLanguage } from "@/runtime/i18n/language"
import { HomeUtilityNav } from "./view"

export default { title: "App/Home/Utility nav", id: "app-home-utility-nav" }

const Nav = () => {
  const language = useLanguage()

  return <HomeUtilityNav class="flex" language={language} onOpenSettings={() => {}} onOpenHelp={() => {}} />
}

export const HelpMenu = {
  render: () => (
    <div class="w-[320px] rounded-[10px] bg-v2-background-bg-base p-4">
      <Nav />
    </div>
  ),
}
