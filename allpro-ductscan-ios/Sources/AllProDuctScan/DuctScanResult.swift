import Foundation

struct DuctScanObstacle: Codable {
    var type: String        // "joist" | "pipe" | "conduit" | "unknown_obstruction"
    var offsetIn: Double    // vertical distance from hood-top point, in inches

    enum CodingKeys: String, CodingKey {
        case type
        case offsetIn = "offset_in"
    }
}

struct DuctScanResult: Codable {
    var deckHeightIn: Double
    var ductRunLengthIn: Double
    var obstacles: [DuctScanObstacle]

    enum CodingKeys: String, CodingKey {
        case deckHeightIn = "deck_height_in"
        case ductRunLengthIn = "duct_run_length_in"
        case obstacles
    }
}
