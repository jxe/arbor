import Quagmire
import SwiftUI

public struct ArborEditorSurface<Footer: View>: View {
    public let binding: ArborDocumentBinding
    public let host: ArborEditorHost
    public let configuration: EditorConfiguration
    public let pinchDictation: EditorPinchDictation?
    private let footer: Footer

    public init(
        binding: ArborDocumentBinding,
        host: ArborEditorHost,
        configuration: EditorConfiguration = EditorConfiguration(),
        pinchDictation: EditorPinchDictation? = nil,
        @ViewBuilder footer: () -> Footer
    ) {
        self.binding = binding
        self.host = host
        self.configuration = configuration
        self.pinchDictation = pinchDictation
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
            pinchDictation: pinchDictation
        ) {
            footer
        }
    }
}

public extension ArborEditorSurface where Footer == EmptyView {
    init(
        binding: ArborDocumentBinding,
        host: ArborEditorHost,
        configuration: EditorConfiguration = EditorConfiguration(),
        pinchDictation: EditorPinchDictation? = nil
    ) {
        self.init(
            binding: binding,
            host: host,
            configuration: configuration,
            pinchDictation: pinchDictation
        ) { EmptyView() }
    }
}
