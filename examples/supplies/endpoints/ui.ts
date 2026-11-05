// SPIKE: the handful of view types the endpoint examples use. Each is a name
// and props; a renderer (SwiftUI in Story, HTML elsewhere) decides what it looks like.
import { jsx } from "overstory/ui/jsx-runtime"

const view = (type: string) => (props: Record<string, unknown>) => jsx(type, props)

export const Column = view("Column")
export const Row = view("Row")
export const Grid = view("Grid")
export const Text = view("Text")
export const Link = view("Link")
export const Markdown = view("Markdown")
export const Badge = view("Badge")
export const Button = view("Button")
