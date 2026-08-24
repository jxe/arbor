import Quagmire
import SwiftUI

public struct ArborEditorSurface<Footer: View>: View {
    public let binding: ArborDocumentBinding
    public let host: ArborEditorHost
    private let footer: Footer

    public init(
        binding: ArborDocumentBinding,
        host: ArborEditorHost,
        @ViewBuilder footer: () -> Footer
    ) {
        self.binding = binding
        self.host = host
        self.footer = footer()
    }

    public var body: some View {
        EditorView(document: binding.document, state: binding.editorState, host: host) {
            footer
        }
    }
}

public extension ArborEditorSurface where Footer == EmptyView {
    init(binding: ArborDocumentBinding, host: ArborEditorHost) {
        self.init(binding: binding, host: host) { EmptyView() }
    }
}
