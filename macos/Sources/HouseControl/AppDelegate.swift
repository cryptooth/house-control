import AppKit
import UniformTypeIdentifiers
import HouseCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let plans = PlanStore()
    /// The Home Assistant side: device links, commands and state.
    private lazy var hub = DeviceHub(directory: plans.directory, secret: Self.vault(plans.directory))
    private var island: IslandController?
    private var statusItem: NSStatusItem!
    private var panel: PanelController!
    private var editor: EditorController?
    private var pollTimer: Timer?
    private var lastSummary: [String: Any] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMainMenu()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = symbol("house.fill")
            button.imagePosition = .imageLeading
            button.target = self
            button.action = #selector(statusItemClicked)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.toolTip = "House Control"
        }

        let host = WebHost(mode: "panel", transparent: true) { [unowned self] in self.bootPayload() }
        host.onMessage = { [weak self, unowned host] message in self?.handle(message, from: host) }
        panel = PanelController(host: host)
        panel.onVisibilityChange = { [weak self] visible in self?.setPolling(visible) }
        hub.onStale = { [weak self] in self?.poll() }
        reloadLinks()
        host.load()
        if islandEnabled { showIsland() }

        // HOUSE_SNAPSHOT_DIR=<folder> writes panel.png and island.png there a few seconds
        // after launch: a look at the UI without a screen (see HOUSE_RENDER_HIDDEN).
        if let folder = ProcessInfo.processInfo.environment["HOUSE_SNAPSHOT_DIR"] {
            let directory = URL(fileURLWithPath: folder, isDirectory: true)
            let delay = Double(ProcessInfo.processInfo.environment["HOUSE_SNAPSHOT_DELAY"] ?? "") ?? 6
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.panel.host.snapshot(to: directory.appendingPathComponent("panel.png"))
                self?.island?.host.snapshot(to: directory.appendingPathComponent("island.png"))
            }
        }
        if ProcessInfo.processInfo.environment["HOUSE_OPEN_EDITOR"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.openEditor() }
        }
        if ProcessInfo.processInfo.environment["HOUSE_OPEN_ON_LAUNCH"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.togglePanel() }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Where the Home Assistant token is kept: the login Keychain, or the HOUSE_DATA_DIR
    /// folder for a throw-away run. A token an older build left in a file is moved over once.
    private static func vault(_ directory: URL) -> (String) -> SecretStore {
        let file: (String) -> SecretStore = { FileSecretStore(url: directory.appendingPathComponent("\($0).json")) }
        if ProcessInfo.processInfo.environment["HOUSE_DATA_DIR"] != nil { return file }
        return { name -> SecretStore in
            let keychain = KeychainSecretStore(service: "HouseControl", account: name)
            let old = file(name)
            if let data = old.read() {
                if keychain.read() == nil { keychain.write(data) }
                if keychain.read() != nil { old.write(nil) }
            }
            return keychain
        }
    }

    // MARK: - Status item

    private func symbol(_ name: String) -> NSImage? {
        let image = NSImage(systemSymbolName: name, accessibilityDescription: "House Control")?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 14, weight: .medium))
        image?.isTemplate = true
        return image
    }

    private func updateStatus(_ summary: [String: Any]) {
        lastSummary = summary
        refreshStatusIcon()
    }

    private func refreshStatusIcon() {
        guard let button = statusItem.button else { return }
        let summary = lastSummary
        let lights = summary["lightsOn"] as? Int ?? 0
        let acOn = summary["acOn"] as? Int ?? 0
        var parts: [String] = []
        if lights > 0 { parts.append("\(lights)") }
        if acOn > 0, let target = summary["acTarget"] as? Int { parts.append("\(target)°") }
        let house = lights > 0 || acOn > 0 ? "house.fill" : "house"
        button.image = symbol(house)
        button.attributedTitle = NSAttributedString(
            string: parts.isEmpty ? "" : " " + parts.joined(separator: " · "),
            attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium)])
    }

    @objc private func statusItemClicked() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            panel.hide()
            let menu = NSMenu()
            menu.addItem(withTitle: "Edit Home…", action: #selector(openEditor), keyEquivalent: "").target = self
            menu.addItem(withTitle: "Load Floor Plan…", action: #selector(loadPlan), keyEquivalent: "").target = self
            menu.addItem(withTitle: "Reveal Plan File", action: #selector(revealPlan), keyEquivalent: "").target = self
            menu.addItem(withTitle: "Reveal Device Log", action: #selector(revealLog), keyEquivalent: "").target = self
            menu.addItem(.separator())
            let islandItem = menu.addItem(withTitle: "Show Island", action: #selector(toggleIsland), keyEquivalent: "")
            islandItem.target = self
            islandItem.state = island?.isShown == true ? .on : .off
            menu.addItem(.separator())
            menu.addItem(withTitle: "Reload", action: #selector(reloadAll), keyEquivalent: "").target = self
            menu.addItem(withTitle: "Quit House Control", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            statusItem.menu = menu
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
            return
        }
        togglePanel()
    }

    private func togglePanel() {
        guard let button = statusItem.button else { return }
        panel.toggle(below: button)
    }

    // MARK: - Plans

    private func bootPayload() -> [String: Any] {
        var boot = plans.bootPayload()
        boot["services"] = hub.servicesInfo
        switch ProcessInfo.processInfo.environment["HOUSE_OPEN_EDITOR"] {
        case "connections": boot["section"] = "connections"
        case "homeassistant": boot["section"] = "service:homeassistant"
        default: break
        }
        // HOUSE_OPEN_DEVICE=<id> starts the panel on that light's or AC's detail sheet.
        if let device = ProcessInfo.processInfo.environment["HOUSE_OPEN_DEVICE"] { boot["openDevice"] = device }
        return boot
    }

    private func reloadLinks() {
        hub.setLinks(from: plans.activePlan == "custom" ? plans.customPlan() : nil)
    }

    /// A platform was connected or disconnected: read the devices again.
    private func connectionsChanged() {
        reloadLinks()
        setPolling(false) // reads at once while the panel or the island is open
    }

    @objc private func reloadAll() {
        reloadLinks()
        panel.host.load()
        if island?.isShown == true { island?.host.load() }
    }

    @objc private func loadPlan() {
        panel.hide()
        NSApp.activate(ignoringOtherApps: true)
        let open = NSOpenPanel()
        open.title = "Choose a floor plan"
        open.allowedContentTypes = [.json]
        guard open.runModal() == .OK, let url = open.url else { return }
        do {
            try plans.importPlan(from: url)
            reloadAll()
            editor?.host.load()
        } catch {
            alert("Could not load this floor plan", error.localizedDescription)
        }
    }

    @objc private func revealPlan() {
        let url = plans.hasCustomPlan ? plans.customPlanURL : WebHost.assetRoot.appendingPathComponent("plans/\(plans.activePlan).json")
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    @objc private func revealLog() {
        if !FileManager.default.fileExists(atPath: hub.log.fileURL.path) { hub.log.write("log started") }
        NSWorkspace.shared.activateFileViewerSelecting([hub.log.fileURL])
    }

    @objc private func openEditor() {
        panel.hide()
        if editor == nil {
            let host = WebHost(mode: "editor", transparent: false) { [unowned self] in self.bootPayload() }
            host.onMessage = { [weak self, unowned host] message in self?.handle(message, from: host) }
            let controller = EditorController(host: host)
            controller.onClose = { [weak self, unowned host] in
                host.webView.configuration.userContentController.removeScriptMessageHandler(forName: "house")
                self?.editor = nil
            }
            editor = controller
            host.load()
        }
        editor?.show()
    }

    private func alert(_ title: String, _ text: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.runModal()
    }

    // MARK: - Messages from the web UI

    private func handle(_ message: [String: Any], from host: WebHost) {
        switch message["type"] as? String {
        case "ready", "summary":
            // A view that has just loaded takes over what the panel shows.
            if message["type"] as? String == "ready", host !== panel.host { panel.host.call("share") }
            if let summary = (message["summary"] as? [String: Any]) ?? (message["lightsOn"] != nil ? message : nil) {
                updateStatus(summary)
            }
        case "state":
            // The panel and the island are two views of one home: what changes in one is
            // shown by the other.
            var state = message
            state["type"] = nil
            for other in [panel.host, island?.host] where other !== host { other?.call("adopt", state) }
        case "command":
            hub.command(message) { [weak host] in host?.reply(to: message, $0) }
        case "close":
            panel.hide()
        case "selectPlan":
            if let plan = message["plan"] as? String {
                plans.select(plan)
                reloadAll()
                editor?.host.load()
            }
        case "loadPlan": loadPlan()
        case "revealPlan": revealPlan()
        case "openEditor": openEditor()
        case "quit": NSApp.terminate(nil)

        // Editor
        case "savePlan":
            guard let config = message["config"] as? [String: Any] else { return }
            do {
                try plans.saveCustom(config)
                reloadAll()
                host.reply(to: message, ["ok": true, "path": plans.customPlanURL.path])
            } catch {
                host.reply(to: message, ["error": error.localizedDescription])
            }
        case "importPlan":
            let open = NSOpenPanel()
            open.allowedContentTypes = [.json]
            guard open.runModal() == .OK, let url = open.url,
                  let data = try? Data(contentsOf: url),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                host.reply(to: message, ["cancelled": true])
                return
            }
            host.reply(to: message, ["config": json])
        case "exportPlan":
            guard let config = message["config"] as? [String: Any] else { return }
            let save = NSSavePanel()
            save.allowedContentTypes = [.json]
            save.nameFieldStringValue = "\((config["name"] as? String ?? "home").lowercased()).json"
            guard save.runModal() == .OK, let url = save.url else {
                host.reply(to: message, ["cancelled": true])
                return
            }
            do {
                try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]).write(to: url)
                host.reply(to: message, ["ok": true])
            } catch {
                host.reply(to: message, ["error": error.localizedDescription])
            }
        // Home Assistant
        case "services.info":
            host.reply(to: message, hub.servicesInfo)
        case "devices.all":
            Task { @MainActor in
                let (devices, errors) = await hub.allDevices()
                host.reply(to: message, ["devices": devices, "errors": errors])
            }
        case "services.discover":
            Task { @MainActor in
                host.reply(to: message, ["found": await ServiceDiscovery.homeAssistants()])
            }
        case "homeassistant.connect":
            Task { @MainActor in
                do {
                    try await hub.homeAssistant.connect(url: message["url"] as? String ?? "", token: message["token"] as? String ?? "")
                    connectionsChanged()
                    host.reply(to: message, hub.servicesInfo)
                } catch {
                    host.reply(to: message, ["error": error.localizedDescription])
                }
            }
        case "service.disconnect":
            hub.services.first { $0.id == message["service"] as? String }?.disconnect()
            connectionsChanged()
            host.reply(to: message, hub.servicesInfo)
        default:
            break
        }
    }

    // MARK: - Device state

    /// Real devices are read while there is something on screen to show them in.
    private func setPolling(_ requested: Bool) {
        let on = requested || panel.isVisible || island?.isExpanded == true
        pollTimer?.invalidate()
        pollTimer = nil
        guard on, hub.canPoll else { return }
        poll()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 12, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
    }

    private func poll() {
        Task { @MainActor in
            guard let update = await hub.poll() else { return }
            panel.host.call("applyRemote", update) // the island adopts it from the panel
        }
    }

    // MARK: - Island

    /// On unless switched off in the menu (or by HOUSE_ISLAND=0 for one run).
    private var islandEnabled: Bool {
        if let forced = ProcessInfo.processInfo.environment["HOUSE_ISLAND"] { return forced != "0" }
        return UserDefaults.standard.object(forKey: "island") as? Bool ?? true
    }

    private func showIsland() {
        if island == nil {
            let host = WebHost(mode: "island", transparent: true) { [unowned self] in
                var boot = self.plans.bootPayload()
                boot["island"] = self.island?.bootInfo ?? [:]
                return boot
            }
            host.onMessage = { [weak self, unowned host] message in self?.handle(message, from: host) }
            let controller = IslandController(host: host)
            controller.onExpandedChange = { [weak self] open in self?.setPolling(open) }
            island = controller
        }
        island?.show()
    }

    @objc private func toggleIsland() {
        let show = island?.isShown != true
        UserDefaults.standard.set(show, forKey: "island")
        if show { showIsland() } else { island?.hide() }
    }

    // MARK: - Menu (gives the editor window the usual shortcuts)

    private func buildMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit House Control", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let windowItem = NSMenuItem()
        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowItem.submenu = window
        main.addItem(windowItem)
        NSApp.mainMenu = main
    }
}
