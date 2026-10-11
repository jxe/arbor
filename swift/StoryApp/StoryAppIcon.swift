import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum StoryAppIcon: String, CaseIterable, Identifiable {
    case pageS = "PageS"
    case storyPath = "StoryPath"
    case doorway = "Doorway"

    var id: String { rawValue }
    var title: String {
        switch self {
        case .pageS: "Page S"
        case .storyPath: "Story Path (Black)"
        case .doorway: "Doorway"
        }
    }
    var alternateName: String? { self == .storyPath ? nil : rawValue }
    var imageName: String { "StoryIcon\(rawValue)" }
}

/// Icon preferences belong to this device, independently of accounts and trees.
@MainActor
@Observable
final class StoryAppIconSelection {
    static let shared = StoryAppIconSelection()
    private(set) var isChanging = false
    var error: String?
#if os(macOS)
    private(set) var selected = StoryAppIcon(rawValue: UserDefaults.standard.string(forKey: "story.appIcon") ?? "") ?? .storyPath
#else
    var selected: StoryAppIcon {
        StoryAppIcon(rawValue: UIApplication.shared.alternateIconName ?? "StoryPath") ?? .storyPath
    }
#endif

    func select(_ icon: StoryAppIcon) async {
        guard !isChanging else { return }
        error = nil
#if os(macOS)
        guard let image = NSImage(named: icon.imageName) else {
            error = "The selected icon is missing from this app."
            return
        }
        NSApp.applicationIconImage = image
        selected = icon
        UserDefaults.standard.set(icon.rawValue, forKey: "story.appIcon")
#else
        guard icon != selected else { return }
        guard UIApplication.shared.supportsAlternateIcons else {
            error = "This device does not support alternate app icons."
            return
        }
        isChanging = true
        defer { isChanging = false }
        do {
            try await UIApplication.shared.setAlternateIconName(icon.alternateName)
        } catch { self.error = error.localizedDescription }
#endif
    }

#if os(macOS)
    func restore() {
        if let image = NSImage(named: selected.imageName) { NSApp.applicationIconImage = image }
    }
#endif
}

#if os(iOS)
struct StoryAppIconPicker: View {
    @State private var selection = StoryAppIconSelection.shared
    @State private var current = StoryAppIconSelection.shared.selected
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Menu {
            Picker("App Icon", selection: Binding(get: { current }, set: { icon in
                Task {
                    await selection.select(icon)
                    current = selection.selected
                }
            })) {
                ForEach(StoryAppIcon.allCases) { icon in
                    Text(icon.title).tag(icon)
                }
            }
        } label: {
            if selection.isChanging {
                ProgressView()
            } else {
                Label("App Icon", systemImage: "paintpalette")
            }
        }
        .disabled(selection.isChanging)
        .accessibilityLabel("App Icon, \(current.title)")
        .alert("Couldn’t Change App Icon", isPresented: Binding(
            get: { selection.error != nil },
            set: { if !$0 { selection.error = nil } }
        )) {
            Button("OK", role: .cancel) { selection.error = nil }
        } message: {
            Text(selection.error ?? "")
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { current = selection.selected }
        }
    }
}
#endif
