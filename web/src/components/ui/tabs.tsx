import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cn } from "@shared/lib/utils"

function Tabs(props: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root data-slot="tabs" {...props} />
}

function TabsList({
  className,
  ...props
}: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "flex border-b border-border-muted",
        className,
      )}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "px-4 py-2 text-sm font-medium text-text-secondary transition-colors cursor-pointer",
        "border-b-2 border-transparent -mb-px",
        "hover:text-text-primary",
        "data-[selected]:text-text-primary data-[selected]:border-text-primary",
        className,
      )}
      {...props}
    />
  )
}

function TabsPanel({
  className,
  ...props
}: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cn("pt-4", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsPanel }
