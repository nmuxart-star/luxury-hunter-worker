// OCR con Vision (macOS). Uso: swift ocr.swift img1.png img2.png ...
// Salida: JSON por línea {file,w,h,items:[{t,x,y,w,h}]} con coordenadas en píxeles, origen arriba-izquierda.
import Foundation
import Vision
import AppKit
for path in CommandLine.arguments.dropFirst() {
  guard let img = NSImage(contentsOfFile: path),
        let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
  let W = Double(cg.width), H = Double(cg.height)
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
  var items: [[String: Any]] = []
  for o in req.results ?? [] {
    guard let c = o.topCandidates(1).first else { continue }
    let b = o.boundingBox
    items.append(["t": c.string, "x": b.minX*W, "y": (1-b.maxY)*H, "w": b.width*W, "h": b.height*H])
  }
  let obj: [String: Any] = ["file": path, "w": W, "h": H, "items": items]
  if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) { print(s) }
}
