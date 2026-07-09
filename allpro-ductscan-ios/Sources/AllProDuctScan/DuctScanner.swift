import ARKit
import SceneKit

// v1 scope, documented plainly:
//   - Measures a straight-line vertical distance between two tapped points
//     (hood top, underside of deck) using real LiDAR depth, which is the
//     part a 2D photo can't do.
//   - Flags mesh geometry that intrudes into that vertical column as
//     "unknown_obstruction" — it does NOT attempt to classify obstacles as
//     joist vs. pipe vs. conduit. That kind of semantic classification needs
//     trained object detection on top of the raw mesh, which is a real v2
//     project, not something to fake here. The rep reviews and labels
//     flagged points afterward in Termac One.
//   - Does not yet route around obstacles automatically; it reports what's
//     in the way so an estimator can add the horizontal offset by hand.

final class DuctScanner: NSObject, ARSCNViewDelegate, ARSessionDelegate {

    static func deviceSupportsLiDAR() -> Bool {
        return ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    }

    let sceneView: ARSCNView
    private var meshAnchors: [UUID: ARMeshAnchor] = [:]
    private var meshNodes: [UUID: SCNNode] = [:]

    private(set) var hoodTopPoint: SCNVector3?
    private(set) var deckPoint: SCNVector3?

    var onPointCaptured: ((Int) -> Void)?

    init(sceneView: ARSCNView) {
        self.sceneView = sceneView
        super.init()
        sceneView.delegate = self
        sceneView.session.delegate = self
        sceneView.automaticallyUpdatesLighting = true
    }

    func start() {
        guard DuctScanner.deviceSupportsLiDAR() else { return }
        let config = ARWorldTrackingConfiguration()
        config.sceneReconstruction = .mesh
        config.environmentTexturing = .automatic
        sceneView.session.run(config, options: [.resetTracking, .removeExistingAnchors])
    }

    func stop() {
        sceneView.session.pause()
    }

    func reset() {
        hoodTopPoint = nil
        deckPoint = nil
    }

    /// Call from a tap gesture on the ARSCNView. First tap = hood top,
    /// second tap = deck. Uses SceneKit hit-testing against the live mesh
    /// geometry rendered from ARMeshAnchor data, so the point returned is a
    /// real LiDAR-measured 3D position, not a screen-space guess.
    func handleTap(at screenPoint: CGPoint) {
        let results = sceneView.hitTest(screenPoint, options: [
            SCNHitTestOption.searchMode: SCNHitTestSearchMode.closest.rawValue
        ])
        guard let hit = results.first else { return }
        let worldPoint = hit.worldCoordinates

        if hoodTopPoint == nil {
            hoodTopPoint = worldPoint
            onPointCaptured?(1)
        } else if deckPoint == nil {
            deckPoint = worldPoint
            onPointCaptured?(2)
        }
    }

    var readyToFinish: Bool { hoodTopPoint != nil && deckPoint != nil }

    /// Builds the final result once both points are captured. Radius is the
    /// horizontal search radius around the hood-top/deck vertical line,
    /// in meters, used to decide which mesh vertices count as "in the way."
    /// Defaults to roughly a 24in duct footprint's worth of clearance.
    func finishScan(searchRadiusMeters: Float = 0.35) -> DuctScanResult? {
        guard let top = hoodTopPoint, let deck = deckPoint else { return nil }

        let runMeters = abs(deck.y - top.y)
        let runInches = Double(runMeters) * 39.3701

        let lowY = min(top.y, deck.y)
        let highY = max(top.y, deck.y)
        let centerX = (top.x + deck.x) / 2
        let centerZ = (top.z + deck.z) / 2

        var offsetsIn: [Double] = []
        for (_, anchor) in meshAnchors {
            let geometry = anchor.geometry
            let vertexCount = geometry.vertices.count
            let transform = anchor.transform

            for i in 0..<vertexCount {
                let local = geometry.vertex(at: UInt32(i))
                let localVec = simd_float4(local.0, local.1, local.2, 1)
                let world = transform * localVec
                let wx = world.x, wy = world.y, wz = world.z

                guard wy > lowY + 0.02, wy < highY - 0.02 else { continue }
                let dx = wx - centerX
                let dz = wz - centerZ
                let horizDist = sqrt(dx*dx + dz*dz)
                guard horizDist < searchRadiusMeters else { continue }

                let offsetFromTopMeters = abs(wy - top.y)
                offsetsIn.append(Double(offsetFromTopMeters) * 39.3701)
            }
        }

        // Cluster raw hit points into distinct obstacles — anything within
        // 2in of an existing cluster gets folded in rather than reported
        // as its own point, since one real obstacle produces many mesh hits.
        offsetsIn.sort()
        var clusters: [Double] = []
        for offset in offsetsIn {
            if let last = clusters.last, offset - last < 2.0 { continue }
            clusters.append(offset)
        }

        let obstacles = clusters.map { DuctScanObstacle(type: "unknown_obstruction", offsetIn: $0) }

        return DuctScanResult(
            deckHeightIn: runInches,
            ductRunLengthIn: runInches,
            obstacles: obstacles
        )
    }

    // MARK: - ARSCNViewDelegate (mesh rendering, needed for hit-testing)

    func renderer(_ renderer: SCNSceneRenderer, didAdd node: SCNNode, for anchor: ARAnchor) {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return }
        meshAnchors[meshAnchor.identifier] = meshAnchor
        let geoNode = SCNNode(geometry: ARMeshGeometryConverter.geometry(from: meshAnchor.geometry))
        geoNode.opacity = 0 // invisible — used for hit-testing only, not rendering
        node.addChildNode(geoNode)
        meshNodes[meshAnchor.identifier] = geoNode
    }

    func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return }
        meshAnchors[meshAnchor.identifier] = meshAnchor
        if let geoNode = meshNodes[meshAnchor.identifier] {
            geoNode.geometry = ARMeshGeometryConverter.geometry(from: meshAnchor.geometry)
        }
    }

    func renderer(_ renderer: SCNSceneRenderer, didRemove node: SCNNode, for anchor: ARAnchor) {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return }
        meshAnchors.removeValue(forKey: meshAnchor.identifier)
        meshNodes.removeValue(forKey: meshAnchor.identifier)
    }
}

// Converts ARKit's raw mesh buffers into SceneKit geometry so ARSCNView can
// hit-test against it. This is boilerplate every LiDAR mesh app needs;
// there's no shortcut Apple provides for it as of this writing.
enum ARMeshGeometryConverter {
    static func geometry(from mesh: ARMeshGeometry) -> SCNGeometry {
        let vertexSource = SCNGeometrySource(
            buffer: mesh.vertices.buffer,
            vertexFormat: mesh.vertices.format,
            semantic: .vertex,
            vertexCount: mesh.vertices.count,
            dataOffset: mesh.vertices.offset,
            dataStride: mesh.vertices.stride
        )

        let faceData = Data(
            bytesNoCopy: mesh.faces.buffer.contents(),
            count: mesh.faces.buffer.length,
            deallocator: .none
        )
        let element = SCNGeometryElement(
            data: faceData,
            primitiveType: .triangles,
            primitiveCount: mesh.faces.count,
            bytesPerIndex: mesh.faces.bytesPerIndex
        )

        return SCNGeometry(sources: [vertexSource], elements: [element])
    }
}

private extension ARGeometrySource {
    func vertex(at index: UInt32) -> (Float, Float, Float) {
        let pointer = buffer.contents().advanced(by: offset + stride * Int(index))
        let vertex = pointer.assumingMemoryBound(to: (Float, Float, Float).self).pointee
        return vertex
    }
}
