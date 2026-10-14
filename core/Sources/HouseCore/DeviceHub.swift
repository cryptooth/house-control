import Foundation

/// Everything between the UI and the real devices: the Home Assistant connection, which
/// device of the plan is linked to which entity, sending the changes made in the panel and
/// reading the devices' state back.
@MainActor
public final class DeviceHub {
    public let log: EventLog
    public let homeAssistant: HomeAssistantService
    /// The platforms a plan's `link.service` can name: Home Assistant, plus any the tests add.
    public let services: [DeviceService]
    private func service(_ id: String) -> DeviceService? { services.first { $0.id == id } }
    /// App device id -> its link to a platform's device.
    private struct Link {
        var kind: DeviceKind
        var service: String
        var id: String
        /// A temperature sensor for an AC's room reading.
        var sensor: (service: String, id: String)?
    }
    private var serviceLinks: [String: Link] = [:]
    private var refresh: Task<Void, Never>?
    /// The command in flight for each real device; the next one waits for it.
    private var commandTails: [String: Task<Void, Never>] = [:]

    /// Called after a command failed in a way that leaves the panel out of step with the
    /// devices, so the owner can read their state again.
    public var onStale: (() -> Void)?

    /// `secret(name)` is where a platform's credentials are kept ("homeassistant"); by
    /// default `<name>.json` in `directory`, readable by its user only.
    public init(directory: URL, secret: ((String) -> SecretStore)? = nil, services extra: [DeviceService] = []) {
        let vault = secret ?? { FileSecretStore(url: directory.appendingPathComponent("\($0).json")) }
        log = EventLog(directory: directory)
        homeAssistant = HomeAssistantService(vault: vault("homeassistant"))
        services = [homeAssistant] + extra
        for service in services {
            service.onChange = { [weak self] in self?.scheduleRefresh() }
        }
    }

    /// Changes reported by a platform arrive in bursts: one read for all of them.
    private func scheduleRefresh() {
        refresh?.cancel()
        refresh = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            self?.onStale?()
        }
    }

    // MARK: - Links

    public var isConnected: Bool { services.contains { $0.isConnected && $0.controlsDevices } }
    public var hasLinks: Bool { !serviceLinks.isEmpty }
    /// True when there is something to read at all.
    public var canPoll: Bool {
        serviceLinks.values.contains { reachable($0.service) || reachable($0.sensor?.service) }
    }
    private func reachable(_ id: String?) -> Bool {
        guard let id, let service = service(id) else { return false }
        return service.isConnected && service.controlsDevices
    }
    public var linkedDeviceCount: Int { serviceLinks.values.filter { !$0.id.isEmpty }.count }

    /// Takes the device links from `plan`; nil (a bundled demo) means everything is simulated.
    public func setLinks(from plan: [String: Any]?) {
        serviceLinks = [:]
        defer { watchLinks() }
        guard let plan else { return }
        for (kind, key) in [("light", "lights"), ("ac", "acs")] {
            for device in plan[key] as? [[String: Any]] ?? [] {
                guard let id = device["id"] as? String else { continue }
                let sensor = Self.sensorLink(device["sensor"])
                if let link = device["link"] as? [String: Any], let service = link["service"] as? String,
                   let target = link["id"] as? String, !target.isEmpty {
                    serviceLinks[id] = Link(kind: DeviceKind(rawValue: kind) ?? .light, service: service, id: target, sensor: sensor)
                } else if let sensor, kind == "ac" {
                    // A simulated AC can still show a real room temperature.
                    serviceLinks[id] = Link(kind: .ac, service: "", id: "", sensor: sensor)
                }
            }
        }
    }

    /// `{"service": "homeassistant", "id": "sensor.…"}` in a plan.
    private static func sensorLink(_ value: Any?) -> (service: String, id: String)? {
        guard let sensor = value as? [String: Any], let service = sensor["service"] as? String,
              let id = sensor["id"] as? String, !id.isEmpty else { return nil }
        return (service, id)
    }

    /// Tells each platform which of its devices the plan uses, for its live updates.
    private func watchLinks() {
        var ids: [String: Set<String>] = [:]
        for link in serviceLinks.values {
            if !link.id.isEmpty { ids[link.service, default: []].insert(link.id) }
            if let sensor = link.sensor { ids[sensor.service, default: []].insert(sensor.id) }
        }
        for service in services { service.watch(ids[service.id] ?? []) }
    }

    // MARK: - Commands

    /// Sends a change made in the panel to the real device and tells the panel how it went,
    /// so a rejected change can be rolled back there. Commands to one device run strictly
    /// one after another, in the order this is called.
    public func command(_ message: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        guard let id = message["id"] as? String, let link = serviceLinks[id], !link.id.isEmpty,
              let service = service(link.service), service.isConnected, service.controlsDevices else {
            reply(["ok": true]) // simulated device: nothing to send
            return
        }
        let patch = message["patch"] as? [String: Any] ?? [:]
        let state = message["state"] as? [String: Any] ?? [:]
        let key = "\(link.service):\(link.id)"
        let previous = commandTails[key]
        commandTails[key] = Task { @MainActor in
            await previous?.value
            let what = patch.keys.sorted().map { "\($0)=\(patch[$0] ?? "")" }.joined(separator: " ")
            do {
                try await service.send(kind: link.kind, id: link.id, patch: patch, state: state)
                log.write("\(id) [\(service.title)] \(what) → ok")
                reply(["ok": true])
            } catch {
                log.write("\(id) [\(service.title)] \(what) → \(error.localizedDescription)")
                reply(["error": error.localizedDescription])
                // The panel showed the change optimistically: pull the real state back in.
                onStale?()
            }
        }
    }

    // MARK: - State

    /// What the linked devices report right now, in the shape the panel's `applyRemote`
    /// takes. Nil when nothing is connected or no platform could be reached.
    public func poll() async -> [String: Any]? {
        var wanted: [String: Set<String>] = [:]
        for link in serviceLinks.values {
            if !link.id.isEmpty { wanted[link.service, default: []].insert(link.id) }
            if let sensor = link.sensor { wanted[sensor.service, default: []].insert(sensor.id) }
        }
        var readings: [String: [String: DeviceReading]] = [:]
        var answered = false
        for (serviceId, ids) in wanted {
            guard let service = service(serviceId), service.isConnected, service.controlsDevices,
                  let result = try? await service.read(ids) else { continue }
            readings[serviceId] = result
            answered = true
        }
        guard answered else { return nil }
        var lights: [String: Any] = [:], acs: [String: Any] = [:], features: [String: Any] = [:]
        for (id, link) in serviceLinks {
            let reading = readings[link.service]?[link.id]
            if link.kind == .light, let light = reading?.light, reading?.online != false { lights[id] = light }
            if link.kind == .ac {
                var ac = reading?.online == false ? [:] : reading?.ac ?? [:]
                if let sensor = link.sensor, let t = readings[sensor.service]?[sensor.id]?.temperature { ac["roomTemp"] = t }
                if !ac.isEmpty { acs[id] = ac }
                if let known = reading?.features { features[id] = known }
            }
        }
        return ["lights": lights, "acs": acs, "features": features]
    }

    /// Every device of every connected platform, in the editor's terms, plus what went
    /// wrong with the platforms that could not be asked.
    public func allDevices() async -> (devices: [[String: Any]], errors: [String: String]) {
        var devices: [[String: Any]] = []
        var errors: [String: String] = [:]
        for service in services where service.isConnected {
            do {
                devices += try await service.devices().map { $0.dictionary(service: service.id) }
            } catch {
                errors[service.id] = error.localizedDescription
            }
        }
        return (devices, errors)
    }

    /// What the editor shows for each platform.
    public var servicesInfo: [String: Any] {
        var out: [String: Any] = [:]
        for service in services { out[service.id] = service.info }
        return out
    }
}
