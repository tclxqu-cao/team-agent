import AppKit
import Foundation

private struct FixtureState: Codable {
    var text = ""
    var pressCount = 0
    var canvasClickCount = 0
}

private func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

private final class CoordinateTargetView: NSView {
    var onTargetClick: (() -> Void)?
    private var targetRect: NSRect {
        NSRect(x: bounds.midX - 42, y: bounds.midY - 26, width: 84, height: 52)
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityIdentifier("computer-fixture.canvas")
        setAccessibilityLabel("Canvas coordinate area")
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        dirtyRect.fill()
        NSColor.separatorColor.setStroke()
        let border = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6)
        border.stroke()
        NSColor.systemTeal.setFill()
        NSBezierPath(roundedRect: targetRect, xRadius: 5, yRadius: 5).fill()
        let label = "CLICK TARGET" as NSString
        label.draw(
            at: NSPoint(x: targetRect.minX + 8, y: targetRect.midY - 7),
            withAttributes: [
                .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
                .foregroundColor: NSColor.white,
            ]
        )
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if targetRect.contains(point) { onTargetClick?() }
    }
}

private final class FixtureController: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private let statusURL: URL
    private var state = FixtureState()
    private var window: NSWindow!
    private var textField: NSTextField!
    private var statusLabel: NSTextField!

    init(statusPath: String) {
        statusURL = URL(fileURLWithPath: statusPath)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildWindow()
        persistState()
        window.center()
        window.makeKeyAndOrderFront(nil)
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
        announceReadyWhenActive(attempt: 0)
    }

    private func announceReadyWhenActive(attempt: Int) {
        guard NSApp.isActive else {
            if #available(macOS 14.0, *) {
                NSApp.activate()
            } else {
                NSApp.activate(ignoringOtherApps: true)
            }
            guard attempt < 50 else {
                fputs("fixture could not become the active application\n", stderr)
                NSApp.terminate(nil)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                self?.announceReadyWhenActive(attempt: attempt + 1)
            }
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            emit([
                "ready": true,
                "pid": ProcessInfo.processInfo.processIdentifier,
                "statusPath": self.statusURL.path,
            ])
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func controlTextDidChange(_ obj: Notification) {
        state.text = textField.stringValue
        persistState()
    }

    @objc private func pressButton() {
        state.text = textField.stringValue
        state.pressCount += 1
        persistState()
    }

    private func canvasClicked() {
        state.canvasClickCount += 1
        persistState()
    }

    private func persistState() {
        statusLabel?.stringValue = "Pressed \(state.pressCount) · Canvas \(state.canvasClickCount)"
        guard let data = try? JSONEncoder().encode(state) else { return }
        try? data.write(to: statusURL, options: .atomic)
    }

    private func buildWindow() {
        let contentRect = NSRect(x: 0, y: 0, width: 640, height: 520)
        window = NSWindow(
            contentRect: contentRect,
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "AgentRoam Computer Fixture"
        window.setFrameAutosaveName("AgentRoamComputerFixture")
        window.collectionBehavior = [.moveToActiveSpace]

        let content = NSView(frame: contentRect)
        window.contentView = content

        let heading = NSTextField(labelWithString: "Computer tool acceptance fixture")
        heading.frame = NSRect(x: 24, y: 472, width: 592, height: 24)
        heading.font = .systemFont(ofSize: 17, weight: .semibold)
        heading.setAccessibilityIdentifier("computer-fixture.heading")
        content.addSubview(heading)

        textField = NSTextField(frame: NSRect(x: 24, y: 424, width: 380, height: 30))
        textField.placeholderString = "Type through Accessibility focus"
        textField.delegate = self
        textField.setAccessibilityIdentifier("computer-fixture.text")
        content.addSubview(textField)

        let button = NSButton(title: "Press through AX", target: self, action: #selector(pressButton))
        button.frame = NSRect(x: 24, y: 374, width: 160, height: 32)
        button.bezelStyle = .rounded
        button.setAccessibilityIdentifier("computer-fixture.press")
        content.addSubview(button)

        statusLabel = NSTextField(labelWithString: "Pressed 0 · Canvas 0")
        statusLabel.frame = NSRect(x: 205, y: 380, width: 300, height: 20)
        statusLabel.setAccessibilityIdentifier("computer-fixture.status")
        content.addSubview(statusLabel)

        let document = NSTextView(frame: NSRect(x: 0, y: 0, width: 570, height: 360))
        document.string = (1...18).map { "Scrollable fixture row \($0)" }.joined(separator: "\n")
        document.isEditable = false
        let scroll = NSScrollView(frame: NSRect(x: 24, y: 174, width: 592, height: 178))
        scroll.hasVerticalScroller = true
        scroll.documentView = document
        scroll.setAccessibilityIdentifier("computer-fixture.scroll")
        content.addSubview(scroll)

        let canvas = CoordinateTargetView(frame: NSRect(x: 24, y: 24, width: 592, height: 126))
        canvas.onTargetClick = { [weak self] in self?.canvasClicked() }
        content.addSubview(canvas)
    }
}

guard let statusPath = CommandLine.arguments.dropFirst().first, !statusPath.isEmpty else {
    fputs("usage: computer-use-fixture <status-json-path>\n", stderr)
    exit(64)
}

let application = NSApplication.shared
private let controller = FixtureController(statusPath: statusPath)
application.delegate = controller
application.run()
