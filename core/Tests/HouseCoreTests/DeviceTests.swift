import XCTest
@testable import HouseCore

@MainActor
final class DeviceTests: XCTestCase {
    func testHubSimulatesUnlinkedDevicesAndReadsLinks() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let hub = DeviceHub(directory: dir, secret: { _ in MemorySecretStore() })
        hub.setLinks(from: ["lights": [["id": "a", "link": ["service": "homeassistant", "id": "light.a"]], ["id": "b"],
                                       ["id": "c", "link": ["service": "homeassistant", "id": ""]]],
                            "acs": [["id": "ac", "link": ["service": "homeassistant", "id": "climate.ac"],
                                     "sensor": ["service": "homeassistant", "id": "sensor.s1"]]]])
        XCTAssertEqual(hub.linkedDeviceCount, 2)
        XCTAssertFalse(hub.isConnected)
        XCTAssertFalse(hub.canPoll)
        var reply: [String: Any]?
        hub.command(["id": "a", "kind": "light", "patch": ["on": true]]) { reply = $0 }
        XCTAssertEqual(reply?["ok"] as? Bool, true) // not connected: nothing is sent anywhere
        hub.setLinks(from: nil)
        XCTAssertFalse(hub.hasLinks)
    }

    func testPlanStoreKeepsSyncedBytesAndRevision() throws {
        let data = Data("{\n  \"name\": \"Synced\",\n  \"rooms\": []\n}".utf8)
        XCTAssertNoThrow(try PlanStore.validate(data))
        XCTAssertThrowsError(try PlanStore.validate(Data("{\"name\":\"x\"}".utf8)))
        XCTAssertEqual(PlanStore.revision(of: data).count, 16)
        XCTAssertNotEqual(PlanStore.revision(of: data), PlanStore.revision(of: data + Data(" ".utf8)))
    }

    func testSecretStores() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).json")
        let file = FileSecretStore(url: url)
        XCTAssertNil(file.read())
        file.write(Data("secret".utf8))
        XCTAssertEqual(file.read(), Data("secret".utf8))
        let mode = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
        XCTAssertNotNil(file.stamp)
        file.write(nil)
        XCTAssertNil(file.read())
    }
}
