import Foundation

/// The paired host as it answered: the connection that reached it, and what it accepts.
public struct Reached: Sendable {
    public let connection: Connection
    public let api: HostAPI
    public let capabilities: Capabilities
}

/// The paired host at the address it paired from or, when nothing answers there, at one of
/// `elsewhere`: where hosts on the local network say they are now (a computer gets another address
/// when the Wi-Fi router hands one out). Wherever it answers, only the paired host passes TLS with
/// this connection's trust anchor, so a stranger's never sees the token.
public func reach(_ connection: Connection, elsewhere: @Sendable () async -> [String]) async throws -> Reached {
    let api = try HostAPI(connection)
    do {
        return Reached(connection: connection, api: api, capabilities: try await api.capabilities())
    } catch let error as HostError {
        throw error // It answered: it's there.
    } catch let error as PhotoboxError {
        throw error
    } catch is CancellationError {
        throw CancellationError()
    } catch {
        var tried: Set<String> = [connection.server]
        for server in await elsewhere() {
            try Task.checkCancellation()
            guard let url = try? serverURL(server), tried.insert(url.absoluteString).inserted else { continue }
            let moved = connection.moved(to: url.absoluteString)
            do {
                let other = try HostAPI(moved)
                return Reached(connection: moved, api: other, capabilities: try await other.capabilities())
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                continue // Another host, or not reachable either.
            }
        }
        throw error
    }
}

/// An upload begun when the host had another address, at the address it has now (`server`): the
/// same unfinished upload on the same paired host. Anything that isn't an upload location stays as
/// it was, for `HostAPI.uploadURL` to refuse.
public func movedUpload(_ location: String, to server: String) -> String {
    guard let parts = URLComponents(string: location), parts.query == nil, parts.fragment == nil,
          isUploadPath(parts.percentEncodedPath), let base = try? serverURL(server),
          var moved = URLComponents(url: base, resolvingAgainstBaseURL: false)
    else { return location }
    moved.percentEncodedPath = parts.percentEncodedPath
    return moved.url?.absoluteString ?? location
}
