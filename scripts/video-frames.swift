// Pull evenly spaced stills out of a video, using what macOS already has.
//
// Marble has no working video path — a video media asset passes validation as
// an `image_prompt` and then fails the generation with a 500 — but frames from
// one real walkthrough are exactly what its multi-image reconstruction mode
// wants: genuine views of a single space, which is the case that mode exists
// for and the case our stock-photo sets were never able to satisfy.
//
// AVFoundation rather than ffmpeg, so nothing has to be installed on the
// machine to make a capture from a phone video.
//
//   swift scripts/video-frames.swift <video> <out-dir> <count>

import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 4,
      let count = Int(args[3]), count > 0 else {
    FileHandle.standardError.write("usage: video-frames.swift <video> <out-dir> <count>\n".data(using: .utf8)!)
    exit(2)
}

let input = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2])
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let asset = AVURLAsset(url: input)
let generator = AVAssetImageGenerator(asset: asset)
// Phone video carries its orientation in a track transform; without this every
// frame comes out rotated and Marble is handed a room lying on its side.
generator.appliesPreferredTrackTransform = true
// Exact frames, not the nearest keyframe: evenly spaced samples of a walk are
// the point, and keyframe snapping can collapse several of them onto the same
// moment.
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero
generator.maximumSize = CGSize(width: 1600, height: 1600)

let seconds = CMTimeGetSeconds(asset.duration)
guard seconds.isFinite, seconds > 0 else {
    FileHandle.standardError.write("could not read a duration from \(input.lastPathComponent)\n".data(using: .utf8)!)
    exit(1)
}

var written: [String] = []
for i in 0..<count {
    // Sampled at the midpoint of each slice rather than at its edges: the first
    // and last moments of a handheld walkthrough are where the phone is being
    // raised and lowered, and are the blurriest frames in the clip.
    let t = seconds * (Double(i) + 0.5) / Double(count)
    let time = CMTime(seconds: t, preferredTimescale: 600)
    do {
        let cgImage = try generator.copyCGImage(at: time, actualTime: nil)
        let name = String(format: "frame-%02d.jpg", i + 1)
        let url = outDir.appendingPathComponent(name)
        guard let dest = CGImageDestinationCreateWithURL(
            url as CFURL, UTType.jpeg.identifier as CFString, 1, nil
        ) else { continue }
        CGImageDestinationAddImage(dest, cgImage, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
        if CGImageDestinationFinalize(dest) {
            written.append(name)
            print(String(format: "%@  t=%.1fs  %dx%d", name, t, cgImage.width, cgImage.height))
        }
    } catch {
        FileHandle.standardError.write("frame at \(t)s failed: \(error)\n".data(using: .utf8)!)
    }
}

print("\(written.count)/\(count) frames -> \(outDir.path)")
