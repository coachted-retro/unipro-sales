import SwiftUI

struct ContentView: View {
    @State private var projectId: String = ""
    @State private var showScanner = false
    @State private var lastResult: DuctScanResult?
    @State private var uploadStatus: String = ""

    var body: some View {
        NavigationView {
            VStack(spacing: 20) {
                Text("AllPro Duct Scan")
                    .font(.system(.title2, design: .rounded).weight(.bold))

                Text("Requires iPhone 12 Pro or later, or iPad Pro 2020+ — LiDAR only.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)

                TextField("Termac One Project ID (APR-...)", text: $projectId)
                    .textFieldStyle(.roundedBorder)
                    .autocapitalization(.allCharacters)
                    .padding(.horizontal)

                Button(action: { showScanner = true }) {
                    Text("Start Duct Scan")
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(projectId.isEmpty ? Color.gray : Color.red)
                        .foregroundColor(.white)
                        .cornerRadius(10)
                }
                .disabled(projectId.isEmpty || !DuctScanner.deviceSupportsLiDAR())
                .padding(.horizontal)

                if !DuctScanner.deviceSupportsLiDAR() {
                    Text("This device has no LiDAR sensor. Scanning is disabled.")
                        .font(.footnote)
                        .foregroundColor(.red)
                        .padding(.horizontal)
                }

                if let result = lastResult {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Last scan").font(.headline)
                        Text("Deck height: \(String(format: "%.1f", result.deckHeightIn)) in")
                        Text("Duct run (straight-line): \(String(format: "%.1f", result.ductRunLengthIn)) in")
                        Text("Obstacles flagged: \(result.obstacles.count)")
                        ForEach(result.obstacles.indices, id: \.self) { i in
                            Text("  • \(result.obstacles[i].type) @ \(String(format: "%.0f", result.obstacles[i].offsetIn)) in from hood top")
                                .font(.caption)
                        }
                        Text(uploadStatus).font(.caption).foregroundColor(.secondary)
                    }
                    .padding()
                    .background(Color(.secondarySystemBackground))
                    .cornerRadius(10)
                    .padding(.horizontal)
                }

                Spacer()
            }
            .padding(.top, 24)
            .navigationBarHidden(true)
            .sheet(isPresented: $showScanner) {
                DuctScanRepresentable { result in
                    lastResult = result
                    showScanner = false
                    uploadResult(result)
                }
            }
        }
    }

    private func uploadResult(_ result: DuctScanResult) {
        uploadStatus = "Uploading to Termac One..."
        TermacAPIClient.postDuctScanResult(projectId: projectId, result: result) { success, message in
            DispatchQueue.main.async {
                uploadStatus = success ? "Saved to project \(projectId)." : "Upload failed: \(message)"
            }
        }
    }
}
