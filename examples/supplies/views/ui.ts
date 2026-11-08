// The view types Supplies' JSX views use. Each is a name and props; a renderer (SwiftUI in
// Story, HTML elsewhere) decides how it looks. The vocabulary is the UI language (Apps 011).
import { jsx } from "overstory/ui/jsx-runtime"

const type = (name: string) => (props: Record<string, unknown>) => jsx(name, props)

export const Column = type("Column")
export const Row = type("Row")
export const Grid = type("Grid")
export const Text = type("Text")
export const Link = type("Link")
export const Markdown = type("Markdown")
export const Badge = type("Badge")
export const Button = type("Button")
