import Foundation
import os

/// The `URLSession` a family of clients shares, replaceable as a whole. A
/// suspended iOS app's pooled connections can die without notice; `renew()`
/// gives every later request a fresh connection pool instead of one that
/// waits out a timeout on a dead socket.
public final class ProtocolSession: Sendable {
    private let state = OSAllocatedUnfairLock(initialState: URLSession(configuration: .default))

    public init() {}

    /// The session new requests use.
    public var current: URLSession { state.withLock { $0 } }

    /// Replace the session. Requests already running on the old one finish or fail there.
    public func renew() {
        let old = state.withLock { session in
            defer { session = URLSession(configuration: .default) }
            return session
        }
        old.finishTasksAndInvalidate()
    }
}
