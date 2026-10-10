import Foundation
import Testing
import os
@testable import Overstory

@Suite("Watch idle timeout", .serialized)
struct WatchIdleTimeoutTests {
    @Test("A watch that goes silent fails as timed out")
    func silentWatchTimesOut() async throws {
        let client = watchClient(keepalives: 0)
        let events = try await client.watch(tree: "tr_one", idleTimeout: .milliseconds(200))
        let started = ContinuousClock.now
        await #expect(throws: URLError.self) {
            for try await _ in events {}
        }
        #expect(ContinuousClock.now - started < .seconds(5))
    }

    @Test("Keepalives hold a quiet watch open until the host ends it")
    func keepalivesHoldWatchOpen() async throws {
        let client = watchClient(keepalives: 8)
        let events = try await client.watch(tree: "tr_one", idleTimeout: .milliseconds(200))
        for try await _ in events {}
    }

    private func watchClient(keepalives: Int) -> ProtocolClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [QuietWatchURLProtocol.self]
        QuietWatchURLProtocol.keepalives.withLock { $0 = keepalives }
        return ProtocolClient(origin: URL(string: "https://host.test")!, session: URLSession(configuration: configuration))
    }
}

/// Answers a watch with an event stream that sends `keepalives` comments 50 ms
/// apart and then ends, or with none, stays open until cancelled.
private final class QuietWatchURLProtocol: URLProtocol, @unchecked Sendable {
    static let keepalives = OSAllocatedUnfairLock(initialState: 0)
    private var loading: Task<Void, Never>?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/event-stream"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(": ready\n\n".utf8))
        let count = Self.keepalives.withLock { $0 }
        guard count > 0 else { return }
        nonisolated(unsafe) let loader = self
        loading = Task {
            for _ in 0..<count {
                try? await Task.sleep(for: .milliseconds(50))
                if Task.isCancelled { return }
                loader.client?.urlProtocol(loader, didLoad: Data(": keepalive\n\n".utf8))
            }
            loader.client?.urlProtocolDidFinishLoading(loader)
        }
    }

    override func stopLoading() { loading?.cancel() }
}
