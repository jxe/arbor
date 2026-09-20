import Quagmire
import SwiftUI

public struct ArborEditorSurface<Footer: View>: View {
    public let binding: ArborDocumentBinding
    public let host: ArborEditorHost
    public let configuration: EditorConfiguration
    public let pinchDictation: EditorPinchDictation?
    public let topOverscrollAction: EditorTopOverscrollAction?
    public let accessories: [EditorAccessory]
    public let accessoryReveal: EditorAccessoryReveal?
    private let footer: Footer

    public init(
        binding: ArborDocumentBinding,
        host: ArborEditorHost,
        configuration: EditorConfiguration = EditorConfiguration(),
        pinchDictation: EditorPinchDictation? = nil,
        topOverscrollAction: EditorTopOverscrollAction? = nil,
        accessories: [EditorAccessory] = [],
        accessoryReveal: EditorAccessoryReveal? = nil,
        @ViewBuilder footer: () -> Footer
    ) {
        self.binding = binding
        self.host = host
        self.configuration = configuration
        self.pinchDictation = pinchDictation
        self.topOverscrollAction = topOverscrollAction
        self.accessories = accessories
        self.accessoryReveal = accessoryReveal
        self.footer = footer()
    }

    public var body: some View {
        #if os(macOS)
        editor
            .focusEffectDisabled()
        #else
        editor
        #endif
    }

    private var editor: some View {
        EditorView(
            document: binding.document,
            state: binding.editorState,
            host: host,
            configuration: configuration,
            pinchDictation: pinchDictation,
            topOverscrollAction: topOverscrollAction
        ) {
            footer
        }
        .accessories(accessories, reveal: accessoryReveal)
        // EditorView keeps its key monitor, commands, undo history and document
        // hooks in @State for the document it first appeared with. A new
        // binding at the same place in the view tree (a page reloaded in place
        // over a replaced provider) must get a fresh editor, never inherit one
        // still attached to the closed document.
        .id(ObjectIdentifier(binding))
    }
}

public extension ArborEditorSurface where Footer == EmptyView {
    init(
        binding: ArborDocumentBinding,
        host: ArborEditorHost,
        configuration: EditorConfiguration = EditorConfiguration(),
        pinchDictation: EditorPinchDictation? = nil,
        topOverscrollAction: EditorTopOverscrollAction? = nil,
        accessories: [EditorAccessory] = [],
        accessoryReveal: EditorAccessoryReveal? = nil
    ) {
        self.init(
            binding: binding,
            host: host,
            configuration: configuration,
            pinchDictation: pinchDictation,
            topOverscrollAction: topOverscrollAction,
            accessories: accessories,
            accessoryReveal: accessoryReveal
        ) { EmptyView() }
    }
}
