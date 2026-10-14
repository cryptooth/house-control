import AppKit
import HouseCore

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    // Menu bar only: no Dock icon (HOUSE_DOCK=1 shows one, handy for UI automation).
    app.setActivationPolicy(ProcessInfo.processInfo.environment["HOUSE_DOCK"] != nil ? .regular : .accessory)
    app.run()
}
