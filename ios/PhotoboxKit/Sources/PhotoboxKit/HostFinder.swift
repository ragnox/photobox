import Foundation
import Network

/// Where Photobox hosts on this network say they are (DNS-SD `_photobox._tcp`, announced by the
/// computer), as addresses to try when the paired one doesn't answer. Which of them is the paired
/// host only TLS can tell. On iPhone this needs the local network permission.
public enum HostFinder {
    public static let service = "_photobox._tcp"
    private static let queue = DispatchQueue(label: "photobox.host-finder")

    /// The hosts announced within `discover` seconds; a moment longer after the first, for others.
    public static func find(discover: Double = 5, more: Double = 0.5, resolve: Double = 3) async -> [String] {
        let services = await browse(discover: discover, more: more)
        let urls = await withTaskGroup(of: [String].self) { group in
            for endpoint in services { group.addTask { await self.resolve(endpoint, within: resolve) } }
            var all: [String] = []
            for await found in group { all += found }
            return all
        }
        var seen = Set<String>()
        return urls.filter { seen.insert($0).inserted }
    }

    static func browse(discover: Double, more: Double) async -> [NWEndpoint] {
        let browser = NWBrowser(for: .bonjour(type: service, domain: nil), using: NWParameters())
        let found = Locked<[NWEndpoint]>([])
        let first = Locked(false)
        let done = Locked(false)
        return await withCheckedContinuation { continuation in
            @Sendable func finish() {
                guard done.with({ let was = $0; $0 = true; return !was }) else { return }
                browser.cancel()
                continuation.resume(returning: found.with { $0 })
            }
            browser.browseResultsChangedHandler = { results, _ in
                let endpoints = results.map(\.endpoint)
                found.with { $0 = endpoints }
                if !endpoints.isEmpty, first.with({ let was = $0; $0 = true; return !was }) {
                    queue.asyncAfter(deadline: .now() + more) { finish() }
                }
            }
            browser.stateUpdateHandler = { state in
                switch state {
                case .failed, .cancelled: finish()
                default: break
                }
            }
            browser.start(queue: queue)
            queue.asyncAfter(deadline: .now() + discover) { finish() }
        }
    }

    /// The service's IPv4 address, connected to once over TCP and dropped.
    static func resolve(_ endpoint: NWEndpoint, within seconds: Double) async -> [String] {
        let parameters = NWParameters.tcp
        (parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options)?.version = .v4
        let connection = NWConnection(to: endpoint, using: parameters)
        let done = Locked(false)
        return await withCheckedContinuation { continuation in
            @Sendable func finish(_ urls: [String]) {
                guard done.with({ let was = $0; $0 = true; return !was }) else { return }
                connection.cancel()
                continuation.resume(returning: urls)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if case .hostPort(let host, let port)? = connection.currentPath?.remoteEndpoint, case .ipv4(let address) = host {
                        finish(hostURLs(["\(address)"], port: Int(port.rawValue)))
                    } else {
                        finish([])
                    }
                case .failed, .cancelled: finish([])
                default: break
                }
            }
            connection.start(queue: queue)
            queue.asyncAfter(deadline: .now() + seconds) { finish([]) }
        }
    }
}

/// The host's addresses as server URLs. Photobox's certificate names its IPv4 addresses.
func hostURLs(_ addresses: [String], port: Int) -> [String] {
    guard (1...65535).contains(port) else { return [] }
    return addresses.compactMap { value in
        let address = value.split(separator: "%").first.map(String.init) ?? value // no interface suffix
        return IPv4Address(address) != nil ? "https://\(address):\(port)/" : nil
    }
}

/// A value behind a lock, for callbacks that come on other queues.
final class Locked<Value>: @unchecked Sendable {
    private var value: Value
    private let lock = NSLock()
    init(_ value: Value) { self.value = value }
    func with<Result>(_ body: (inout Value) -> Result) -> Result {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}
