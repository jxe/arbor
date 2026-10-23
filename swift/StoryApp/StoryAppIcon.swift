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

enum StoryIOSSettings {
    /// Whether the page shows a grip at its bottom left edge on iOS for revealing the sidebar.
    static let showsSidebarHandleKey = "sidebar.showsHandle"
}

#if os(iOS)
/// Device preferences, pushed from the gear in Sync & Accounts.
struct StoryIOSSettingsView: View {
    @AppStorage(StoryIOSSettings.showsSidebarHandleKey) private var showsSidebarHandle = true

    var body: some View {
        Form {
            Section("App Icon") {
                StoryAppIconChoices()
            }
            Section {
                Toggle("Show Sidebar Handle", isOn: $showsSidebarHandle)
            } header: {
                Text("Sidebar")
            } footer: {
                Text("A grip on the page's left edge, near the bottom, slides the page aside to show the sidebar. Without it, swipe in from the left edge.")
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The app icons side by side, each tappable, with the current one checked.
private struct StoryAppIconChoices: View {
    @State private var selection = StoryAppIconSelection.shared
    @State private var current = StoryAppIconSelection.shared.selected
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ForEach(StoryAppIcon.allCases) { icon in
                Button {
                    Task {
                        await selection.select(icon)
                        current = selection.selected
                    }
                } label: {
                    VStack(spacing: 6) {
                        Image(icon.imageName)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: 88)
                        Text(icon.title)
                            .font(.caption)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(icon == current ? .primary : .secondary)
                        Image(systemName: icon == current ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .foregroundStyle(icon == current ? Color.accentColor : Color.secondary.opacity(0.5))
                    }
                    .frame(maxWidth: .infinity)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(icon.title)
                .accessibilityAddTraits(icon == current ? .isSelected : [])
            }
        }
        .padding(.vertical, 6)
        .disabled(selection.isChanging)
        .opacity(selection.isChanging ? 0.6 : 1)
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
