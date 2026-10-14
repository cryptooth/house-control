import AppKit
import WebKit

/// Regular window hosting the charts of Home Assistant's sensors.
final class ChartsController: NSObject, NSWindowDelegate {
    let host: WebHost
    private let window: NSWindow
    var onClose: (() -> Void)?

    init(host: WebHost) {
        self.host = host
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        super.init()
        window.title = "House Control — Charts"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(calibratedRed: 0.04, green: 0.055, blue: 0.1, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.minSize = NSSize(width: 760, height: 520)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = host.webView
        window.center()
        window.setFrameAutosaveName("HouseControlCharts")
    }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        onClose?()
    }
}
