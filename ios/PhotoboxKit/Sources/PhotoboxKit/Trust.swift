import Foundation
import Security

/// Trusts only the paired anchor, with the usual host-name (or IP address) check, and follows no
/// redirects. There is no trust-all fallback.
final class PinnedTrust: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    private let anchor: SecCertificate
    private let pinnedLeaf: String? // kind "certificate": the server's own certificate, as paired

    init(_ trust: TrustAnchor) throws {
        anchor = try trust.secCertificate()
        pinnedLeaf = trust.kind == "certificate" ? trust.sha256 : nil
    }

    /// Whether `trust`, presented by `host`, chains to the paired anchor.
    func accepts(_ trust: SecTrust, host: String) -> Bool {
        guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess
        else { return false }
        if let pinnedLeaf {
            guard let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first,
                  sha256Hex(SecCertificateCopyData(leaf) as Data) == pinnedLeaf
            else { return false }
        }
        return SecTrustEvaluateWithError(trust, nil)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async
        -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust else { return (.performDefaultHandling, nil) }
        guard let trust = space.serverTrust, accepts(trust, host: space.host) else { return (.cancelAuthenticationChallenge, nil) }
        return (.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        nil // The redirect response itself comes back, and is refused there.
    }
}
