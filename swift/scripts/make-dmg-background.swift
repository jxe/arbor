// Draws the Mac disk image's window background: an arrow from the app to the
// Applications folder, and a line saying what to do. make-dmg.sh places the
// icons over it at (160, 170) and (440, 170) in a 600 by 360 window.
//
//   swift swift/scripts/make-dmg-background.swift <output.tiff>
//
// The TIFF holds a 1x and a 2x image, so the window is sharp on every display.
// Rerun it after changing the layout and commit the result.
import AppKit

let width = 600.0
let height = 360.0
let iconY = 170.0

func render(scale: CGFloat) -> NSBitmapImageRep {
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: Int(width * scale), pixelsHigh: Int(height * scale),
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    bitmap.size = NSSize(width: width, height: height)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

    // Finder draws the window in the same light colors in light and dark mode.
    NSColor(calibratedWhite: 0.97, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()

    // AppKit's origin is bottom left; Finder's icon positions are from the top.
    let y = height - iconY
    let arrow = NSColor(calibratedWhite: 0.55, alpha: 1)
    arrow.setStroke()
    arrow.setFill()
    let shaft = NSBezierPath()
    shaft.move(to: NSPoint(x: 250, y: y))
    shaft.line(to: NSPoint(x: 336, y: y))
    shaft.lineWidth = 6
    shaft.lineCapStyle = .round
    shaft.stroke()
    let head = NSBezierPath()
    head.move(to: NSPoint(x: 352, y: y))
    head.line(to: NSPoint(x: 330, y: y + 16))
    head.line(to: NSPoint(x: 330, y: y - 16))
    head.close()
    head.lineJoinStyle = .round
    head.lineWidth = 4
    head.fill()
    head.stroke()

    let caption = "Drag Story to Applications to install it" as NSString
    let style = NSMutableParagraphStyle()
    style.alignment = .center
    caption.draw(
        in: NSRect(x: 0, y: 44, width: width, height: 24),
        withAttributes: [
            .font: NSFont.systemFont(ofSize: 14, weight: .medium),
            .foregroundColor: NSColor(calibratedWhite: 0.45, alpha: 1),
            .paragraphStyle: style,
        ])

    NSGraphicsContext.restoreGraphicsState()
    return bitmap
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("usage: make-dmg-background.swift <output.tiff>\n".data(using: .utf8)!)
    exit(2)
}
let image = NSImage(size: NSSize(width: width, height: height))
image.addRepresentation(render(scale: 1))
image.addRepresentation(render(scale: 2))
guard let tiff = image.tiffRepresentation(using: .lzw, factor: 0) else { exit(1) }
try tiff.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
