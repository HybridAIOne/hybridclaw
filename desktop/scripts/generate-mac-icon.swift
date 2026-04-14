import AppKit
import Foundation

let fileManager = FileManager.default
let desktopDir = URL(fileURLWithPath: fileManager.currentDirectoryPath)
let sourceURL = desktopDir
  .appendingPathComponent("../docs/static/apple-touch-icon.png")
  .standardizedFileURL
let buildDir = desktopDir.appendingPathComponent("build", isDirectory: true)
let iconsetDir = buildDir.appendingPathComponent("icon.iconset", isDirectory: true)
let masterIconURL = buildDir.appendingPathComponent("icon.png")
let icnsURL = buildDir.appendingPathComponent("icon.icns")
let backgroundURL = buildDir.appendingPathComponent("background.png")
let background2xURL = buildDir.appendingPathComponent("background@2x.png")
let sourceCopyURL = buildDir.appendingPathComponent("icon-source.png")
let iconComposerDir = desktopDir.appendingPathComponent("icon/AppIcon.icon", isDirectory: true)
let iconComposerAssetsDir = iconComposerDir.appendingPathComponent("Assets", isDirectory: true)
let iconComposerManifestURL = iconComposerDir.appendingPathComponent("icon.json")
let iconComposerMarkURL = iconComposerAssetsDir.appendingPathComponent("hybridclaw-mark.png")

let canvasSize = CGSize(width: 1024, height: 1024)
let dmgBackgroundSize = CGSize(width: 760, height: 480)
let dmgBackground2xSize = CGSize(width: 1520, height: 960)
let markInset: CGFloat = 140
let fallbackBackgroundColor = NSColor(
  calibratedRed: 0.963,
  green: 0.971,
  blue: 0.98,
  alpha: 1
)
let installerBackgroundColor = NSColor(
  calibratedRed: 0.984,
  green: 0.987,
  blue: 0.993,
  alpha: 1
)
let installerBrandColor = NSColor(
  calibratedRed: 0.216,
  green: 0.255,
  blue: 0.318,
  alpha: 1
)
let installerMutedColor = NSColor(
  calibratedRed: 0.427,
  green: 0.475,
  blue: 0.565,
  alpha: 1
)
let installerAccentColor = NSColor(
  calibratedRed: 0.365,
  green: 0.431,
  blue: 0.937,
  alpha: 1
)

func makeBitmap(size: CGSize) -> NSBitmapImageRep? {
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: Int(size.width),
    pixelsHigh: Int(size.height),
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  )
  rep?.size = size
  return rep
}

func renderImage(size: CGSize, draw: () -> Void) -> NSImage? {
  guard let rep = makeBitmap(size: size) else {
    return nil
  }

  NSGraphicsContext.saveGraphicsState()
  guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
    NSGraphicsContext.restoreGraphicsState()
    return nil
  }
  NSGraphicsContext.current = context
  context.imageInterpolation = .high

  NSColor.clear.setFill()
  NSBezierPath(rect: CGRect(origin: .zero, size: size)).fill()
  draw()

  NSGraphicsContext.restoreGraphicsState()

  let image = NSImage(size: size)
  image.addRepresentation(rep)
  return image
}

func writePng(_ image: NSImage, to url: URL) throws {
  guard
    let tiffData = image.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiffData),
    let pngData = bitmap.representation(using: .png, properties: [:])
  else {
    throw NSError(domain: "HybridClawIcon", code: 1)
  }

  try pngData.write(to: url, options: .atomic)
}

func makeLogoImage(from sourceImage: NSImage) -> NSImage? {
  guard let tiffData = sourceImage.tiffRepresentation else {
    return nil
  }
  guard let sourceRep = NSBitmapImageRep(data: tiffData) else {
    return nil
  }
  guard let outputRep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: sourceRep.pixelsWide,
    pixelsHigh: sourceRep.pixelsHigh,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else {
    return nil
  }
  outputRep.size = sourceImage.size

  guard let sourceData = sourceRep.bitmapData, let outputData = outputRep.bitmapData else {
    return nil
  }

  let sourceBytesPerRow = sourceRep.bytesPerRow
  let outputBytesPerRow = outputRep.bytesPerRow
  let brand = (red: UInt8(55), green: UInt8(65), blue: UInt8(81))

  for y in 0 ..< sourceRep.pixelsHigh {
    for x in 0 ..< sourceRep.pixelsWide {
      let sourceOffset = (y * sourceBytesPerRow) + (x * 4)
      let red = Double(sourceData[sourceOffset]) / 255.0
      let green = Double(sourceData[sourceOffset + 1]) / 255.0
      let blue = Double(sourceData[sourceOffset + 2]) / 255.0
      let alpha = Double(sourceData[sourceOffset + 3]) / 255.0

      let whiteness = (red + green + blue) / 3.0
      let extractedAlpha = max(0, min(1, ((1.0 - whiteness) - 0.03) / 0.72)) * alpha

      let outputOffset = (y * outputBytesPerRow) + (x * 4)
      outputData[outputOffset] = brand.red
      outputData[outputOffset + 1] = brand.green
      outputData[outputOffset + 2] = brand.blue
      outputData[outputOffset + 3] = UInt8((extractedAlpha * 255.0).rounded())
    }
  }

  let image = NSImage(size: sourceImage.size)
  image.addRepresentation(outputRep)
  return image
}

func makeIconComposerMarkImage(from logoImage: NSImage) -> NSImage? {
  renderImage(size: canvasSize) {
    let markRect = CGRect(
      x: markInset,
      y: markInset,
      width: canvasSize.width - (markInset * 2),
      height: canvasSize.height - (markInset * 2)
    )
    logoImage.draw(
      in: markRect,
      from: CGRect(origin: .zero, size: logoImage.size),
      operation: .sourceOver,
      fraction: 1
    )
  }
}

func makeFallbackIcon(from markImage: NSImage) -> NSImage? {
  renderImage(size: canvasSize) {
    fallbackBackgroundColor.setFill()
    NSBezierPath(rect: CGRect(origin: .zero, size: canvasSize)).fill()

    markImage.draw(
      in: CGRect(origin: .zero, size: canvasSize),
      from: CGRect(origin: .zero, size: markImage.size),
      operation: .sourceOver,
      fraction: 1
    )
  }
}

func drawInstallerBadge(markImage: NSImage, rect: CGRect) {
  let shadow = NSShadow()
  shadow.shadowColor = NSColor(
    calibratedRed: 0.18,
    green: 0.23,
    blue: 0.34,
    alpha: 0.14
  )
  shadow.shadowBlurRadius = rect.width * 0.18
  shadow.shadowOffset = CGSize(width: 0, height: -(rect.width * 0.06))

  NSGraphicsContext.saveGraphicsState()
  shadow.set()

  let badgePath = NSBezierPath(
    roundedRect: rect,
    xRadius: rect.width * 0.32,
    yRadius: rect.height * 0.32
  )
  NSColor.white.setFill()
  badgePath.fill()
  NSColor(
    calibratedRed: 0.875,
    green: 0.898,
    blue: 0.942,
    alpha: 1
  ).setStroke()
  badgePath.lineWidth = max(1, rect.width * 0.02)
  badgePath.stroke()
  NSGraphicsContext.restoreGraphicsState()

  let markInset = rect.width * 0.2
  let markRect = rect.insetBy(dx: markInset, dy: markInset)
  markImage.draw(
    in: markRect,
    from: CGRect(origin: .zero, size: markImage.size),
    operation: .sourceOver,
    fraction: 1
  )
}

func makeDmgBackground(size: CGSize, markImage: NSImage) -> NSImage? {
  renderImage(size: size) {
    let scale = size.width / dmgBackgroundSize.width
    let leftMargin = 42 * scale
    let topPadding = 34 * scale
    let badgeSize = 32 * scale
    let brandBadgeRect = CGRect(
      x: leftMargin,
      y: size.height - topPadding - badgeSize,
      width: badgeSize,
      height: badgeSize
    )
    let brandTitlePoint = CGPoint(
      x: brandBadgeRect.maxX + (12 * scale),
      y: brandBadgeRect.minY + (2 * scale)
    )
    let subtitlePoint = CGPoint(
      x: leftMargin,
      y: size.height - (86 * scale)
    )
    let arrowText = "\u{2192}"
    let arrowFont = NSFont.systemFont(ofSize: 92 * scale, weight: .bold)
    let arrowAttributes: [NSAttributedString.Key: Any] = [
      .font: arrowFont,
      .foregroundColor: installerAccentColor,
    ]
    let arrowSize = arrowText.size(withAttributes: arrowAttributes)
    let arrowPoint = CGPoint(
      x: ((size.width - arrowSize.width) / 2).rounded(),
      y: (142 * scale).rounded()
    )

    installerBackgroundColor.setFill()
    NSBezierPath(rect: CGRect(origin: .zero, size: size)).fill()

    drawInstallerBadge(markImage: markImage, rect: brandBadgeRect)

    NSString(string: "HybridClaw").draw(
      at: brandTitlePoint,
      withAttributes: [
        .font: NSFont.systemFont(ofSize: 28 * scale, weight: .bold),
        .foregroundColor: installerBrandColor,
      ]
    )

    NSString(string: "Drag to install.").draw(
      at: subtitlePoint,
      withAttributes: [
        .font: NSFont.systemFont(ofSize: 16 * scale, weight: .medium),
        .foregroundColor: installerMutedColor,
      ]
    )

    NSString(string: arrowText).draw(
      at: arrowPoint,
      withAttributes: arrowAttributes
    )
  }
}

guard let sourceImage = NSImage(contentsOf: sourceURL) else {
  fputs("Failed to load source icon at \(sourceURL.path)\n", stderr)
  exit(1)
}
guard let logoImage = makeLogoImage(from: sourceImage) else {
  fputs("Failed to isolate logo shape from \(sourceURL.lastPathComponent)\n", stderr)
  exit(1)
}
guard let iconComposerMarkImage = makeIconComposerMarkImage(from: logoImage) else {
  fputs("Failed to render Icon Composer foreground layer\n", stderr)
  exit(1)
}
guard let fallbackIcon = makeFallbackIcon(from: iconComposerMarkImage) else {
  fputs("Failed to render fallback dock icon\n", stderr)
  exit(1)
}
guard let dmgBackground = makeDmgBackground(size: dmgBackgroundSize, markImage: iconComposerMarkImage) else {
  fputs("Failed to render DMG background\n", stderr)
  exit(1)
}
guard let dmgBackground2x = makeDmgBackground(size: dmgBackground2xSize, markImage: iconComposerMarkImage) else {
  fputs("Failed to render Retina DMG background\n", stderr)
  exit(1)
}

try? fileManager.removeItem(at: buildDir)
try fileManager.createDirectory(
  at: iconsetDir,
  withIntermediateDirectories: true,
  attributes: nil
)

try? fileManager.removeItem(at: iconComposerDir)
try fileManager.createDirectory(
  at: iconComposerAssetsDir,
  withIntermediateDirectories: true,
  attributes: nil
)

let sourceCopyData = try Data(contentsOf: sourceURL)
try sourceCopyData.write(to: sourceCopyURL, options: .atomic)
try writePng(iconComposerMarkImage, to: iconComposerMarkURL)
try writePng(fallbackIcon, to: masterIconURL)
try writePng(dmgBackground, to: backgroundURL)
try writePng(dmgBackground2x, to: background2xURL)

let iconComposerManifest = """
{
  "fill": "automatic",
  "groups": [
    {
      "layers": [
        {
          "glass": false,
          "image-name": "hybridclaw-mark.png",
          "name": "HybridClawMark"
        }
      ],
      "shadow": {
        "kind": "neutral",
        "opacity": 0.45
      },
      "translucency": {
        "enabled": true,
        "value": 0.4
      }
    }
  ],
  "supported-platforms": {
    "circles": ["watchOS"],
    "squares": "shared"
  }
}
"""
try iconComposerManifest.write(to: iconComposerManifestURL, atomically: true, encoding: .utf8)

let iconVariants: [(name: String, size: CGFloat)] = [
  ("icon_16x16.png", 16),
  ("icon_16x16@2x.png", 32),
  ("icon_32x32.png", 32),
  ("icon_32x32@2x.png", 64),
  ("icon_128x128.png", 128),
  ("icon_128x128@2x.png", 256),
  ("icon_256x256.png", 256),
  ("icon_256x256@2x.png", 512),
  ("icon_512x512.png", 512),
  ("icon_512x512@2x.png", 1024),
]

for variant in iconVariants {
  let resized = NSImage(size: CGSize(width: variant.size, height: variant.size))
  resized.lockFocus()
  NSGraphicsContext.current?.imageInterpolation = .high
  fallbackIcon.draw(
    in: CGRect(origin: .zero, size: resized.size),
    from: CGRect(origin: .zero, size: fallbackIcon.size),
    operation: .copy,
    fraction: 1
  )
  resized.unlockFocus()

  try writePng(
    resized,
    to: iconsetDir.appendingPathComponent(variant.name)
  )
}

let task = Process()
task.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
task.arguments = ["-c", "icns", iconsetDir.path, "-o", icnsURL.path]
try task.run()
task.waitUntilExit()

if task.terminationStatus != 0 {
  fputs("iconutil failed with status \(task.terminationStatus)\n", stderr)
  exit(task.terminationStatus)
}
