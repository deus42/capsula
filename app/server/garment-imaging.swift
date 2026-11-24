import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

struct Box: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct Crop: Decodable {
    let key: Int
    let source: String
    let destination: String
    let box: Box
}

struct Sheet: Decodable {
    let sources: [String]
    let destination: String
}

struct Preview: Decodable {
    let key: Int
    let source: String
    let destination: String
}

func uprightImage(_ file: String, maxPixelSize: Int? = nil) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: file) as CFURL, nil),
          let info = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = info[kCGImagePropertyPixelWidth] as? Int,
          let height = info[kCGImagePropertyPixelHeight] as? Int else { return nil }
    // Crop inputs keep their full resolution. Analysis previews are smaller.
    let options = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: maxPixelSize ?? max(width, height)
    ] as CFDictionary
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options)
}

func faces(in image: CGImage) throws -> [CGRect] {
    let request = VNDetectFaceRectanglesRequest()
    try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
    return (request.results ?? []).map { face in
        let box = face.boundingBox
        return CGRect(x: box.minX, y: 1 - box.maxY, width: box.width, height: box.height)
    }
}

func preview(_ entry: Preview) throws -> Bool {
    guard let image = uprightImage(entry.source, maxPixelSize: 1600),
          let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let canvas = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                                 space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
    let width = CGFloat(image.width), height = CGFloat(image.height)
    canvas.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    canvas.setFillColor(CGColor(gray: 0.35, alpha: 1))
    for face in try faces(in: image) {
        let covered = face.insetBy(dx: -face.width * 0.12, dy: -face.height * 0.12)
        let region = CGRect(x: covered.minX * width, y: (1 - covered.maxY) * height,
                            width: covered.width * width, height: covered.height * height)
        canvas.fill(region.integral)
    }
    guard let masked = canvas.makeImage() else { return false }
    return saveImage(masked, to: entry.destination, type: .jpeg,
                     options: [kCGImageDestinationLossyCompressionQuality: 0.87] as CFDictionary)
}

func saveImage(_ image: CGImage, to file: String, type: UTType = .png, options: CFDictionary? = nil) -> Bool {
    guard let out = CGImageDestinationCreateWithURL(URL(fileURLWithPath: file) as CFURL, type.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(out, image, options)
    return CGImageDestinationFinalize(out)
}

func downscale(_ image: CGImage, maxEdge: Int) -> CGImage {
    let longest = max(image.width, image.height)
    guard longest > maxEdge else { return image }
    let scale = CGFloat(maxEdge) / CGFloat(longest)
    let w = max(1, Int((CGFloat(image.width) * scale).rounded()))
    let h = max(1, Int((CGFloat(image.height) * scale).rounded()))
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return image }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage() ?? image
}

func crop(_ entry: Crop, image: CGImage, faces sourceFaces: [CGRect]) throws -> Bool {
    let b = entry.box
    guard b.x >= 0, b.y >= 0, b.width > 0, b.height > 0, b.x + b.width <= 1, b.y + b.height <= 1 else { return false }
    let rect = CGRect(x: b.x * Double(image.width), y: b.y * Double(image.height), width: b.width * Double(image.width), height: b.height * Double(image.height)).integral
    guard rect.width >= 48, rect.height >= 48 else { return false }
    let area = CGRect(x: rect.minX / CGFloat(image.width), y: rect.minY / CGFloat(image.height), width: rect.width / CGFloat(image.width), height: rect.height / CGFloat(image.height))
    // A face truncated by a crop may not be detected on the crop itself.
    guard !sourceFaces.contains(where: { $0.insetBy(dx: -$0.width * 0.04, dy: -$0.height * 0.04).intersects(area) }),
          let piece = image.cropping(to: rect), try faces(in: piece).isEmpty else { return false }
    return saveImage(downscale(piece, maxEdge: 1536), to: entry.destination)
}

func makeSheet(_ entry: Sheet) throws {
    let pictures = entry.sources.compactMap { uprightImage($0) }
    guard !pictures.isEmpty, pictures.count == entry.sources.count else { throw CocoaError(.fileReadCorruptFile) }
    let cell = 500, columns = min(3, pictures.count)
    let rows = (pictures.count + columns - 1) / columns
    let image = NSImage(size: NSSize(width: columns * cell, height: rows * cell), flipped: false) { bounds in
        NSColor.white.setFill()
        bounds.fill()
        for (index, picture) in pictures.enumerated() {
            let x = CGFloat((index % columns) * cell)
            let y = CGFloat((rows - index / columns - 1) * cell)
            let label = CGRect(x: x + 12, y: y + 10, width: 70, height: 38)
            String(index + 1).draw(in: label, withAttributes: [.font: NSFont.boldSystemFont(ofSize: 30), .foregroundColor: NSColor.black])
            let scale = min(470 / CGFloat(picture.width), 430 / CGFloat(picture.height))
            let width = CGFloat(picture.width) * scale, height = CGFloat(picture.height) * scale
            let rect = CGRect(x: x + (CGFloat(cell) - width) / 2, y: y + 45 + (430 - height) / 2, width: width, height: height)
            NSImage(cgImage: picture, size: .zero).draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
        }
        return true
    }
    guard let tiff = image.tiffRepresentation, let pixels = NSBitmapImageRep(data: tiff),
          let data = pixels.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
    try data.write(to: URL(fileURLWithPath: entry.destination), options: .atomic)
}

struct BodyCrop: Decodable {
    let source: String
    let destination: String
}

func bodyCrop(_ entry: BodyCrop) throws -> Bool {
    guard let image = uprightImage(entry.source), image.width >= 48, image.height >= 64 else { return false }
    let detected = try faces(in: image)
    let startY: Double
    if detected.isEmpty {
        startY = 0
    } else {
        let maxBottom = detected.map { Double($0.maxY) }.max() ?? 0.22
        let maxH = detected.map { Double($0.height) }.max() ?? 0.12
        startY = min(0.62, max(0.12, maxBottom + maxH * 0.28))
    }
    let w = image.width, h = image.height
    for shift in [0.0, 0.06, 0.12] {
        let top = max(0, min(h - 64, Int((min(0.68, startY + shift) * Double(h)).rounded())))
        let cropH = h - top
        guard cropH >= 64 else { continue }
        let rect = CGRect(x: 0, y: top, width: w, height: cropH)
        guard let piece = image.cropping(to: rect), try faces(in: piece).isEmpty else { continue }
        return saveImage(downscale(piece, maxEdge: 1536), to: entry.destination)
    }
    return false
}

let command = CommandLine.arguments[1]
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
if command == "crop" {
    let entries = try JSONDecoder().decode([Crop].self, from: data)
    var seen: [String: (CGImage, [CGRect])] = [:]
    var accepted: [Int] = []
    for entry in entries {
        do {
            if seen[entry.source] == nil, let image = uprightImage(entry.source) {
                seen[entry.source] = (image, try faces(in: image))
            }
            if let (image, sourceFaces) = seen[entry.source], try crop(entry, image: image, faces: sourceFaces) {
                accepted.append(entry.key)
            }
        } catch {
            // A failed photo check can never make the crop usable.
            continue
        }
    }
    print(String(decoding: try JSONEncoder().encode(accepted), as: UTF8.self))
} else if command == "preview" {
    let entries = try JSONDecoder().decode([Preview].self, from: data)
    let accepted = entries.compactMap { entry in (try? preview(entry)) == true ? entry.key : nil }
    print(String(decoding: try JSONEncoder().encode(accepted), as: UTF8.self))
} else if command == "sheet" {
    try makeSheet(JSONDecoder().decode(Sheet.self, from: data))
} else if command == "bodycrop" {
    let ok = try bodyCrop(JSONDecoder().decode(BodyCrop.self, from: data))
    print(ok ? "{\"ok\":true}" : "{\"ok\":false}")
} else {
    throw CocoaError(.featureUnsupported)
}
