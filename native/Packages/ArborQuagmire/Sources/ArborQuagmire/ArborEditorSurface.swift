import Quagmire
import SwiftUI

public struct ArborEditorSurface: View {
    public let binding: ArborDocumentBinding
    public let host: ArborEditorHost

    public init(binding: ArborDocumentBinding, host: ArborEditorHost) {
        self.binding = binding
        self.host = host
    }

    public var body: some View {
        EditorView(document: binding.document, state: binding.editorState, host: host)
    }
}
