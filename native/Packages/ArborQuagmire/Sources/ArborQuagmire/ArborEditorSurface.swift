import Quagmire
import SwiftUI

public struct ArborEditorSurface<Footer: View>: View {
    public let binding: ArborDocumentBinding
    public let host: ArborEditorHost
    public let configuration: EditorConfiguration
    private let footer: Footer

    public init(
        binding: ArborDocumentBinding,
        host: ArborEditorHost,
        configuration: EditorConfiguration = EditorConfiguration(),
        @ViewBuilder footer: () -> Footer
    ) {
        self.binding = binding
        self.host = host
        self.configuration = configuration
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
            configuration: configuration
        ) {
            footer
        }
    }
}

public extension ArborEditorSurface where Footer == EmptyView {
    init(
        binding: ArborDocumentBinding,
        host: ArborEditorHost,
        configuration: EditorConfiguration = EditorConfiguration()
    ) {
        self.init(binding: binding, host: host, configuration: configuration) { EmptyView() }
    }
}
