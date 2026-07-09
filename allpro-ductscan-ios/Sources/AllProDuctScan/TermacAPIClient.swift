import Foundation

// Same Worker + auth pattern as termac-d1-sync.js on the web side. Update
// this base URL / secret to match whichever alias termac-d1-sync.js is
// actually pointed at (there are two in play — unipro-ai-proxy and
// termac-d1-api — confirm the live one before shipping this build).
enum TermacAPIClient {
    static let baseURL = "https://termac-d1-api.termac-one.workers.dev"
    static let apiSecret = "termac2026"

    static func postDuctScanResult(
        projectId: String,
        result: DuctScanResult,
        completion: @escaping (Bool, String) -> Void
    ) {
        guard let url = URL(string: "\(baseURL)/api/allpro_projects/\(projectId)") else {
            completion(false, "Bad URL")
            return
        }

        var body: [String: Any] = [
            "deck_height_in": result.deckHeightIn,
            "duct_run_length_in": result.ductRunLengthIn,
        ]
        if let obstaclesData = try? JSONEncoder().encode(result.obstacles),
           let obstaclesJSON = String(data: obstaclesData, encoding: .utf8) {
            body["duct_obstacles_json"] = obstaclesJSON
        }

        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else {
            completion(false, "Could not encode request body")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiSecret, forHTTPHeaderField: "X-API-Secret")
        request.httpBody = jsonData

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(false, error.localizedDescription)
                return
            }
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                completion(false, "Server returned an error")
                return
            }
            completion(true, "OK")
        }.resume()
    }
}
