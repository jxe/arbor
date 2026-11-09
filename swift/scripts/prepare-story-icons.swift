#!/usr/bin/env swift
// Regenerate app-icon renditions from the square masters in StoryApp/IconPreviews.
// Run from the repository root: swift swift/scripts/prepare-story-icons.swift
import AppKit

let root = URL(fileURLWithPath: "swift/StoryApp")
let catalog = root.appendingPathComponent("Assets.xcassets")
let fm = FileManager.default
let template = try JSONSerialization.jsonObject(with: Data(contentsOf: catalog.appendingPathComponent("AppIcon.appiconset/Contents.json"))) as! [String: Any]

func writeJSON(_ value: Any, to url: URL) throws {
    try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]).write(to: url)
}

func render(_ source: NSImage, size: Int, mac: Bool, to url: URL) throws {
    let cg = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
        bytesPerRow: size * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: (mac ? CGImageAlphaInfo.premultipliedLast : CGImageAlphaInfo.noneSkipLast).rawValue)!
    let context = NSGraphicsContext(cgContext: cg, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let full = NSRect(x: 0, y: 0, width: size, height: size)
    NSColor.clear.setFill()
    full.fill(using: .copy)
    // Match the standard macOS icon footprint; iOS supplies its own mask.
    let rect = mac ? full.insetBy(dx: Double(size) * 0.1, dy: Double(size) * 0.1) : full
    if mac {
        NSBezierPath(roundedRect: rect, xRadius: Double(size) * 0.18, yRadius: Double(size) * 0.18).addClip()
    }
    source.draw(in: rect, from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    let bitmap = NSBitmapImageRep(cgImage: cg.makeImage()!)
    try bitmap.representation(using: .png, properties: [:])!.write(to: url)
}

for name in ["PageS", "StoryPath", "StoryPathWhite", "Doorway"] {
    let master = root.appendingPathComponent("IconPreviews/Story-\(name)-master.png")
    guard let source = NSImage(contentsOf: master) else { fatalError("Missing master: \(master.path)") }
    let set = catalog.appendingPathComponent("\(name == "StoryPath" ? "AppIcon" : name).appiconset")
    try fm.createDirectory(at: set, withIntermediateDirectories: true)
    var contents = template
    var images = template["images"] as! [[String: Any]]
    for index in images.indices {
        let entry = images[index]
        let mac = entry["idiom"] as? String == "mac"
        let points = Double((entry["size"] as! String).components(separatedBy: "x")[0])!
        let scale = Double((entry["scale"] as! String).replacingOccurrences(of: "x", with: ""))!
        let size = Int(points * scale)
        let filename = "\(mac ? "Mac" : "iOS")-\(size).png"
        images[index]["filename"] = filename
        try render(source, size: size, mac: mac, to: set.appendingPathComponent(filename))
    }
    contents["images"] = images
    try writeJSON(contents, to: set.appendingPathComponent("Contents.json"))
    // NSApplication loads a normal image asset, rather than an appiconset.
    let preview = catalog.appendingPathComponent("StoryIcon\(name).imageset")
    try fm.createDirectory(at: preview, withIntermediateDirectories: true)
    try render(source, size: 1024, mac: true, to: preview.appendingPathComponent("icon.png"))
    try writeJSON(["images": [["idiom": "universal", "filename": "icon.png"]],
                   "info": ["author": "xcode", "version": 1]], to: preview.appendingPathComponent("Contents.json"))
}

// Retain the previous iOS alternate name across upgrades. The UI still has
// four choices; fresh/default selection uses the primary AppIcon artwork.
let legacy = catalog.appendingPathComponent("StoryPath.appiconset")
if fm.fileExists(atPath: legacy.path) { try fm.removeItem(at: legacy) }
try fm.copyItem(at: catalog.appendingPathComponent("AppIcon.appiconset"), to: legacy)

// One alternate icon with native iOS appearance variants. SpringBoard chooses
// the rendition even while Story is closed; no scheduled alternate-icon calls.
let automatic = catalog.appendingPathComponent("StoryPathAutomatic.appiconset")
let automaticPreview = catalog.appendingPathComponent("StoryIconStoryPathAutomatic.imageset")
try fm.createDirectory(at: automatic, withIntermediateDirectories: true)
try fm.createDirectory(at: automaticPreview, withIntermediateDirectories: true)
var automaticImages: [[String: Any]] = []
var previewImages: [[String: Any]] = []
for (name, dark) in [("StoryPathWhite", false), ("StoryPath", true)] {
    let source = NSImage(contentsOf: root.appendingPathComponent("IconPreviews/Story-\(name)-master.png"))!
    let filename = dark ? "dark.png" : "light.png"
    try render(source, size: 1024, mac: false, to: automatic.appendingPathComponent(filename))
    try render(source, size: 1024, mac: true, to: automaticPreview.appendingPathComponent(filename))
    var icon: [String: Any] = ["idiom": "universal", "platform": "ios", "size": "1024x1024", "filename": filename]
    var preview: [String: Any] = ["idiom": "universal", "filename": filename]
    if dark {
        let appearance = [["appearance": "luminosity", "value": "dark"]]
        icon["appearances"] = appearance
        preview["appearances"] = appearance
    }
    automaticImages.append(icon)
    previewImages.append(preview)
}
try writeJSON(["images": automaticImages, "info": ["author": "xcode", "version": 1]],
              to: automatic.appendingPathComponent("Contents.json"))
try writeJSON(["images": previewImages, "info": ["author": "xcode", "version": 1]],
              to: automaticPreview.appendingPathComponent("Contents.json"))
