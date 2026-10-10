import { NavTabs, type NavTab } from "@/components/ui/tabs";

/** Second header row with route tabs (team tabs or project tabs). */
export function SubNav({ tabs }: { tabs: NavTab[] }) {
  return (
    <div className="sticky top-14 z-20 border-b border-border bg-bg/80 backdrop-blur-md">
      <div className="px-2 sm:px-4">
        <NavTabs tabs={tabs} />
      </div>
    </div>
  );
}
