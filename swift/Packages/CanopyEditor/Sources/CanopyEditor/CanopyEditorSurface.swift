import Quagmire
import SwiftUI

public struct CanopyEditorSurface<Footer: View>: View {
    public let binding: CanopyDocumentBinding
    public let host: CanopyEditorHost
    public let configuration: EditorConfiguration
    public let pinchDictation: EditorPinchDictation?
    public let topOverscrollAction: EditorTopOverscrollAction?
    public let accessories: [EditorAccessory]
    public let accessoryReveal: EditorAccessoryReveal?
    public let readOnly: Bool
    private let footer: Footer

    public init(
        binding: CanopyDocumentBinding,
        host: CanopyEditorHost,
        configuration: EditorConfiguration = EditorConfiguration(),
        pinchDictation: EditorPinchDictation? = nil,
        topOverscrollAction: EditorTopOverscrollAction? = nil,
        accessories: [EditorAccessory] = [],
        accessoryReveal: EditorAccessoryReveal? = nil,
        readOnly: Bool = false,
        @ViewBuilder footer: () -> Footer
    ) {
        self.binding = binding
        self.host = host
        self.configuration = configuration
        self.pinchDictation = pinchDictation
        self.topOverscrollAction = topOverscrollAction
        self.accessories = accessories
        self.accessoryReveal = accessoryReveal
        self.readOnly = readOnly
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
            topOverscrollAction: topOverscrollAction,
            readOnly: readOnly
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

public extension CanopyEditorSurface where Footer == EmptyView {
    init(
        binding: CanopyDocumentBinding,
        host: CanopyEditorHost,
        configuration: EditorConfiguration = EditorConfiguration(),
        pinchDictation: EditorPinchDictation? = nil,
        topOverscrollAction: EditorTopOverscrollAction? = nil,
        accessories: [EditorAccessory] = [],
        accessoryReveal: EditorAccessoryReveal? = nil,
        readOnly: Bool = false
    ) {
        self.init(
            binding: binding,
            host: host,
            configuration: configuration,
            pinchDictation: pinchDictation,
            topOverscrollAction: topOverscrollAction,
            accessories: accessories,
            accessoryReveal: accessoryReveal,
            readOnly: readOnly
        ) { EmptyView() }
    }
}
