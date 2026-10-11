import StoryKit
import Overstory

/// A few sample pages kept in memory, for looking at Story before a device is
/// paired. Nothing in it is stored or synced, and it is gone when the app
/// leaves it.
enum StoryTour {
    static let tree: TreeID = "tr_tour"
    static let home = WorkspaceReference(tree: tree, path: "/")
    /// The page the tour opens on.
    static let welcome = WorkspaceReference(tree: tree, path: "/Welcome-to-Story", stableKey: markdownStableKey("pg_tour_welcome"))

    /// Each page's path is the name its title gives it, so the editor has no rename to suggest.
    static func provider() -> InMemoryWorkspaceProvider {
        func page(_ path: String, _ key: String, _ title: String, _ body: String) -> WorkspaceNode {
            WorkspaceNode(
                reference: WorkspaceReference(tree: tree, path: path, stableKey: markdownStableKey(key)),
                title: title,
                surface: .markdown(source: "# \(title)\n\n\(body)\n", contentRevision: "r1"),
                provenance: .init(authority: .local, sourceDescription: "Sample pages on this device", contentRevision: "r1")
            )
        }
        let root = WorkspaceNode(
            reference: home,
            title: "Sample Pages",
            surface: .directory(summary: "A few pages to try. Nothing here is saved or synced."),
            provenance: .init(authority: .local, sourceDescription: "Sample pages on this device")
        )
        let welcome = page("/Welcome-to-Story", "pg_tour_welcome", "Welcome to Story", """
        Story keeps pages of notes that sync between your Mac, your iPhone and the people you share them with.

        These sample pages live only on this iPhone. Edit anything: nothing here is saved or sent anywhere.

        - Tap a line to edit it.
        - Start a line with `- ` for a list, or `# ` for a heading.
        - Drag a line by its handle to move it.
        """)
        let sharing = page("/Sharing-and-hosts", "pg_tour_sharing", "Sharing and hosts", """
        Your pages are kept by a host: a small server that you or a friend runs. You choose who can read or edit each set of pages, by person or by group.

        Each of your devices keeps its own copy, so you can read and write offline. Changes merge when the devices next reach the host.
        """)
        let pairing = page("/Pairing-this-iPhone", "pg_tour_pairing", "Pairing this iPhone", """
        To use Story with your own pages, set up an account in Story on a Mac, then pair this iPhone with it:

        1. On the Mac, open Story and choose Sync & Accounts.
        2. Choose Pair another device.
        3. On this iPhone, leave the sample pages and scan the code.
        """)
        return InMemoryWorkspaceProvider(
            nodes: [root, welcome, sharing, pairing],
            children: [root.id: [welcome.id, sharing.id, pairing.id]]
        )
    }
}
