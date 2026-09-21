/// Chooses a source without replacing or deleting either identity store.
public enum ProfileIdentityReconciliation: Sendable, Equatable {
    case createOrRecover
    case useArbor
    case adoptNative
    case chooseExisting

    public static func decide(arbor: String?, keyAvailable: Bool, native: String?) -> Self {
        guard let arbor else { return native == nil ? .createOrRecover : .adoptNative }
        guard let native else { return .useArbor }
        guard arbor == native else { return .chooseExisting }
        return keyAvailable ? .useArbor : .adoptNative
    }
}
