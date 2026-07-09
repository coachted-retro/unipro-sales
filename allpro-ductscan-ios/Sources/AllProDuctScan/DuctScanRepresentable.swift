import SwiftUI
import ARKit

struct DuctScanRepresentable: UIViewControllerRepresentable {
    var onFinish: (DuctScanResult) -> Void

    func makeUIViewController(context: Context) -> DuctScanViewController {
        let vc = DuctScanViewController()
        vc.onFinish = onFinish
        return vc
    }

    func updateUIViewController(_ uiViewController: DuctScanViewController, context: Context) {}
}

final class DuctScanViewController: UIViewController {
    var onFinish: ((DuctScanResult) -> Void)?

    private let sceneView = ARSCNView()
    private var scanner: DuctScanner!

    private let instructionLabel = UILabel()
    private let finishButton = UIButton(type: .system)
    private let resetButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        sceneView.frame = view.bounds
        sceneView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(sceneView)

        scanner = DuctScanner(sceneView: sceneView)
        scanner.onPointCaptured = { [weak self] step in
            self?.updateInstructions(step: step)
        }

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        sceneView.addGestureRecognizer(tap)

        instructionLabel.text = "Tap the top of the hood collar to mark point 1."
        instructionLabel.textColor = .white
        instructionLabel.numberOfLines = 0
        instructionLabel.textAlignment = .center
        instructionLabel.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        instructionLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(instructionLabel)

        finishButton.setTitle("Finish Scan", for: .normal)
        finishButton.setTitleColor(.white, for: .normal)
        finishButton.backgroundColor = UIColor.systemRed
        finishButton.layer.cornerRadius = 8
        finishButton.isEnabled = false
        finishButton.alpha = 0.4
        finishButton.addTarget(self, action: #selector(finishTapped), for: .touchUpInside)
        finishButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(finishButton)

        resetButton.setTitle("Reset Points", for: .normal)
        resetButton.setTitleColor(.white, for: .normal)
        resetButton.addTarget(self, action: #selector(resetTapped), for: .touchUpInside)
        resetButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(resetButton)

        NSLayoutConstraint.activate([
            instructionLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            instructionLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            instructionLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),

            finishButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -20),
            finishButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            finishButton.widthAnchor.constraint(equalToConstant: 160),
            finishButton.heightAnchor.constraint(equalToConstant: 44),

            resetButton.bottomAnchor.constraint(equalTo: finishButton.topAnchor, constant: -10),
            resetButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        ])
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        scanner.start()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        scanner.stop()
    }

    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        scanner.handleTap(at: gesture.location(in: sceneView))
        if scanner.readyToFinish {
            finishButton.isEnabled = true
            finishButton.alpha = 1.0
        }
    }

    private func updateInstructions(step: Int) {
        switch step {
        case 1:
            instructionLabel.text = "Point 1 marked (hood top). Now tap the underside of the deck directly above it."
        case 2:
            instructionLabel.text = "Both points marked. Move slowly around the space between them so the scanner can see any obstacles, then tap Finish Scan."
        default:
            break
        }
    }

    @objc private func resetTapped() {
        scanner.reset()
        finishButton.isEnabled = false
        finishButton.alpha = 0.4
        instructionLabel.text = "Tap the top of the hood collar to mark point 1."
    }

    @objc private func finishTapped() {
        guard let result = scanner.finishScan() else { return }
        onFinish?(result)
    }
}
