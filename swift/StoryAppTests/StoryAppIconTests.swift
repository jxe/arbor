import Foundation
import Testing
@testable import StoryApp
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
struct StoryAppIconTests {
    @Test("Every selectable icon ships with its artwork")
    func bundledArtwork() throws {
        for icon in StoryAppIcon.allCases {
#if os(macOS)
            let image = try #require(NSImage(named: icon.imageName))
            let data = try #require(image.tiffRepresentation)
            let bitmap = try #require(NSBitmapImageRep(data: data))
            #expect(bitmap.pixelsWide == 1024)
            #expect(bitmap.pixelsHigh == 1024)
            // Mac assets leave transparent space around the Dock icon footprint.
            #expect(bitmap.colorAt(x: 0, y: 0)?.alphaComponent == 0)
#else
            #expect(UIImage(named: icon.imageName) != nil)
#endif
        }
    }

#if os(iOS)
    @Test("Both iPhone and iPad declare every alternate icon")
    func alternateIconDeclarations() throws {
        for key in ["CFBundleIcons", "CFBundleIcons~ipad"] {
            let icons = try #require(Bundle.main.infoDictionary?[key] as? [String: Any])
            let alternates = try #require(icons["CFBundleAlternateIcons"] as? [String: Any])
            for icon in StoryAppIcon.allCases where icon.alternateName != nil {
                #expect(alternates[icon.rawValue] != nil)
            }
        }
    }
#endif
}
